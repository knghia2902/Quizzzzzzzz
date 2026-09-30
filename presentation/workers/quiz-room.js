import { DurableObject } from 'cloudflare:workers';
import { questions } from './questions.js';
import { QUESTION_MS, calculateScore, compareLeaderboard } from './scoring.js';
import {
  QuestionSetError,
  normalizeQuestionSet,
  normalizeQuestionSettings
} from './question-sets.js';

export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
export const CAPABILITY_TTL_MS = 2 * 60 * 60 * 1000;
export const RECONNECT_TTL_MS = 15 * 60 * 1000;
export const REVEAL_MS = 2_500;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_SETTINGS_BODY_BYTES = 256 * 1024;
export const MAX_PLAYERS = 100;
export const ROOM_ALLOCATOR_ID = '__quiz_room_allocator__';
export const HISTORY_STORAGE_KEY = 'quiz-history-v1';
export const QUIZ_SETTINGS_STORAGE_KEY = 'quiz-settings-v1';
export const DEFAULT_QUESTION_DURATION_SEC = QUESTION_MS / 1000;
export const MIN_QUESTION_DURATION_SEC = 5;
export const MAX_QUESTION_DURATION_SEC = 300;
const HISTORY_LIMIT = 50;

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const STORAGE_KEY = 'quiz-room-state-v1';
const VOICE_STORAGE_PREFIX = 'quiz-dynamic-voice-v1:';
const VOICE_ASSET_PATTERN = /^[A-Za-z0-9_-]{1,96}$/u;
const MAX_VOICE_BYTES = 2 * 1024 * 1024;
const LOCAL_TTS_URL = 'http://127.0.0.1:8786/tts';
const LOCAL_TTS_TIMEOUT_MS = 60_000;
const PHASES = new Set([
  'lobby',
  'question',
  'reveal',
  'finished',
  'paused_host_disconnect'
]);
const ROLES = new Set(['host', 'player']);
const OPTIONS = new Set(['A', 'B', 'C', 'D']);

export function normalizeQuestionDurationSec(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_QUESTION_DURATION_SEC;
  return Math.min(
    MAX_QUESTION_DURATION_SEC,
    Math.max(MIN_QUESTION_DURATION_SEC, Math.round(seconds))
  );
}

function currentTime() {
  return Date.now();
}

function createRoomCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length]).join('');
}

function shuffleQuestionIds(questionSet) {
  const ids = questionSet.questions.map(({ id }) => id);
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    const swapIndex = bytes[0] % (index + 1);
    [ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]];
  }
  return ids;
}

export function normalizeRoomCode(value) {
  const roomCode = String(value || '').trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(roomCode)) {
    throw new RoomError('Mã phòng phải gồm đúng 6 ký tự chữ hoặc số.', 400, 'invalid_room_code');
  }
  return roomCode;
}

export function normalizeNickname(value) {
  const nickname = String(value || '').trim().replace(/\s+/g, ' ');
  if (!nickname || nickname.length > 32 || /[\u0000-\u001f\u007f]/u.test(nickname)) {
    throw new RoomError('Biệt danh phải dài từ 1 đến 32 ký tự.', 400, 'invalid_nickname');
  }
  return nickname;
}

function assertOption(value) {
  if (!OPTIONS.has(value)) {
    throw new RoomError('Đáp án không hợp lệ.', 400, 'invalid_option');
  }
  return value;
}

function tokenBytes(token) {
  return new TextEncoder().encode(token);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function hashCapability(token) {
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes(token));
  return bytesToHex(new Uint8Array(digest));
}

export function createOpaqueToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function safeJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function publicQuestion(question) {
  return {
    id: question.id,
    prompt: question.prompt,
    options: question.options
  };
}

function newPlayer({ playerId, roomCode, displayName, role, playerSequence, capability, reconnect, now }) {
  return {
    playerId,
    roomCode,
    displayName,
    role,
    playerSequence,
    status: 'online',
    capabilityTokenHash: capability.hash,
    capabilityIssuedAt: now,
    capabilityExpiresAt: now + CAPABILITY_TTL_MS,
    capabilityRevokedAt: null,
    reconnectTokenHash: reconnect.hash,
    reconnectIssuedAt: null,
    reconnectExpiresAt: null,
    reconnectRevokedAt: null,
    totalScore: 0,
    totalResponseMs: 0,
    missedQuestions: 0,
    connectedAt: now,
    disconnectedAt: null,
    leftAt: null
  };
}

export class RoomError extends Error {
  constructor(message, status = 400, code = 'room_error') {
    super(message);
    this.name = 'RoomError';
    this.status = status;
    this.code = code;
  }
}

export class QuizRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();
    this.voiceGenerationKeys = new Set();
    this.room = null;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.room = await this.ctx.storage.get(STORAGE_KEY) || null;
      for (const websocket of this.ctx.getWebSockets()) {
        const attachment = websocket.deserializeAttachment();
        if (attachment?.playerId) {
          this.sessions.set(websocket, attachment);
        }
      }
    });
  }

  async fetch(request) {
    await this.ready;

    try {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/history')) {
        if (request.method === 'GET') return await this.readHistory();
        if (request.method === 'POST' && request.headers.get('X-Quiz-Internal') === 'history-writer') {
          return await this.recordHistory(request);
        }
        if (request.method === 'DELETE' && request.headers.get('X-Quiz-Internal') === 'history-admin-clear') {
          return await this.clearHistory();
        }
        return safeJson({ ok: false, error: 'Phương thức không được hỗ trợ.', code: 'method_not_allowed' }, 405);
      }
      if (url.pathname.endsWith('/settings')) {
        if (request.method === 'GET') return await this.readQuizSettings();
        if (request.method === 'PUT' && request.headers.get('X-Quiz-Internal') === 'admin-settings') {
          return await this.writeQuizSettings(request);
        }
        return safeJson({ ok: false, error: 'Phương thức không được hỗ trợ.', code: 'method_not_allowed' }, 405);
      }
      if (url.pathname.endsWith('/allocate')) {
        return await this.allocateRoom(request);
      }
      const roomCode = this.roomCodeFromRequest(url, request);
      const voiceMatch = url.pathname.match(/\/rooms\/[^/]+\/voice\/([A-Za-z0-9_-]+)$/u);
      if (voiceMatch && request.method === 'GET') {
        return await this.readVoice(request, voiceMatch[1]);
      }
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return await this.upgradeWebSocket(request, roomCode);
      }

      if (request.method === 'GET') {
        await this.expireIfNeeded();
        const capabilityToken = url.searchParams.get('capabilityToken');
        const playerId = url.searchParams.get('playerId');
        if (url.searchParams.get('finished') === '1') {
          await this.authenticateFinished({ playerId, capabilityToken });
        } else {
          await this.authenticate({ playerId, capabilityToken });
        }
        return safeJson({ ok: true, event: 'snapshot', snapshot: this.snapshot() });
      }

      if (request.method !== 'POST') {
        return safeJson({ ok: false, error: 'Phương thức không được hỗ trợ.', code: 'method_not_allowed' }, 405);
      }

      const body = await this.readJson(request);
      const result = await this.dispatchCommand(body, { roomCode });
      return safeJson({ ok: true, ...result });
    } catch (error) {
      return this.errorResponse(error);
    }
  }

  roomCodeFromRequest(url, request) {
    const match = url.pathname.match(/\/rooms\/([^/]+)/u);
    const value = match?.[1] || request.headers.get('X-Room-Code');
    return value ? normalizeRoomCode(value) : null;
  }

  async readJson(request, maxBytes = MAX_MESSAGE_BYTES) {
    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > maxBytes) {
      throw new RoomError('Thông điệp quá lớn.', 413, 'message_too_large');
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new RoomError('Thông điệp quá lớn.', 413, 'message_too_large');
    }
    try {
      const body = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('not_object');
      }
      return body;
    } catch {
      throw new RoomError('JSON không hợp lệ.', 400, 'invalid_json');
    }
  }

  async readVoice(request, assetId) {
    if (!VOICE_ASSET_PATTERN.test(assetId)) {
      return safeJson({ ok: false, error: 'Audio không hợp lệ.', code: 'invalid_voice_asset' }, 400);
    }
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId');
    const capabilityToken = url.searchParams.get('capabilityToken');
    if (url.searchParams.get('finished') === '1') {
      await this.authenticateFinished({ playerId, capabilityToken });
    } else {
      await this.authenticate({ playerId, capabilityToken });
    }
    // Durable Object Storage preserves the ArrayBuffer type that was written;
    // passing the old KV-style type string makes the current runtime throw.
    const audio = await this.ctx.storage.get(`${VOICE_STORAGE_PREFIX}${assetId}`);
    if (!audio) return safeJson({ ok: false, error: 'Audio chưa sẵn sàng.', code: 'voice_not_found' }, 404);
    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'private, max-age=3600'
      }
    });
  }

  async generateDynamicVoice(text, assetId) {
    const startedAt = Date.now();
    if (!VOICE_ASSET_PATTERN.test(assetId)) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_TTS_TIMEOUT_MS);
    try {
      const response = await fetch(String(this.env?.LOCAL_TTS_URL || LOCAL_TTS_URL), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        signal: controller.signal,
        body: JSON.stringify({ text: String(text || '').trim() })
      });
      if (!response.ok) return null;
      const audio = await response.arrayBuffer();
      if (!audio.byteLength || audio.byteLength > MAX_VOICE_BYTES) return null;
      await this.ctx.storage.put(`${VOICE_STORAGE_PREFIX}${assetId}`, audio);
      console.log(`[quiz-tts] generated ${assetId} in ${Date.now() - startedAt}ms (${audio.byteLength} bytes)`);
      return assetId;
    } catch {
      console.warn(`[quiz-tts] generation failed for ${assetId} after ${Date.now() - startedAt}ms`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  queueDynamicVoice({ text, assetId, expectedPhase, expectedQuestionIndex = null, expectedKind, expectedPlayerId = null, pendingFastestVoice = false }) {
    if (this.voiceGenerationKeys.has(assetId)) return;
    this.voiceGenerationKeys.add(assetId);
    const publish = async () => {
      try {
        const readyAssetId = await this.generateDynamicVoice(text, assetId);
        if (!readyAssetId) return;
        if (pendingFastestVoice) {
          const pending = this.room?.pendingFastestVoice;
          if (!pending || pending.assetId !== assetId || pending.questionIndex !== expectedQuestionIndex || pending.playerId !== expectedPlayerId) return;
          pending.voiceAssetId = readyAssetId;
          pending.ready = true;
          const announcement = this.room.announcement;
          const canPublish = this.room.phase === 'reveal' && this.room.questionIndex === expectedQuestionIndex && announcement?.kind === 'fastest_correct' && announcement.playerId === expectedPlayerId;
          if (canPublish) {
            this.room.announcement = { ...announcement, voiceAssetId: readyAssetId };
            this.bumpVersion();
          }
          await this.save();
          if (canPublish) this.broadcast({ event: 'voice_ready', snapshot: this.snapshot() });
          return;
        }
        const announcement = this.room?.announcement;
        if (!this.room || this.room.phase !== expectedPhase || this.room.questionIndex !== expectedQuestionIndex || announcement?.kind !== expectedKind || (expectedPlayerId && announcement.playerId !== expectedPlayerId)) return;
        this.room.announcement = { ...announcement, voiceAssetId: readyAssetId };
        this.bumpVersion();
        await this.save();
        this.broadcast({ event: 'voice_ready', snapshot: this.snapshot() });
      } finally {
        this.voiceGenerationKeys.delete(assetId);
      }
    };
    const task = publish().catch((error) => {
      console.warn(`[quiz-tts] publish failed for ${assetId}: ${error?.message || error}`);
    });
    if (typeof this.ctx.waitUntil === 'function') this.ctx.waitUntil(task);
  }

  finalResultsAnnouncement() {
    const topTen = this.leaderboard().slice(0, 10).map(({ displayName, totalScore, rank }) => ({ displayName, totalScore, rank }));
    return { topTen };
  }

  voiceAssetId(kind, version) {
    return `${kind}-${this.room.roomCode}-${Number(version)}`;
  }

  errorResponse(error) {
    if (error instanceof RoomError) {
      return safeJson({ ok: false, error: error.message, code: error.code }, error.status);
    }
    return safeJson({ ok: false, error: 'Lỗi máy chủ phòng chơi.', code: 'internal_error' }, 500);
  }

  async dispatchCommand(command, context = {}) {
    const type = typeof command?.type === 'string' ? command.type : '';
    if (![
      'create',
      'join',
      'snapshot',
      'start',
      'answer',
      'next',
      'setAutoAdvance',
      'resume',
      'finish',
      'finalize',
      'leave'
    ].includes(type)) {
      throw new RoomError('Loại lệnh không hợp lệ.', 400, 'invalid_message_type');
    }

    await this.expireIfNeeded();
    if (type === 'create') return this.createRoom(context.roomCode || command.roomCode, command.nickname, command.questionDurationSec, command.questionSet);
    if (type === 'join') return this.joinRoom(context.roomCode || command.roomCode, command.nickname);
    if (type === 'snapshot') {
      await this.authenticate(command);
      return { event: 'snapshot', snapshot: this.snapshot() };
    }

    if (type === 'finalize') return await this.finalizeResult(command);

    const player = await this.authenticate(command);
    if (type === 'start') return await this.startQuiz(player);
    if (type === 'answer') return await this.submitAnswer(player, command);
    if (type === 'next') return await this.hostNext(player);
    if (type === 'setAutoAdvance') return await this.setAutoAdvance(player, command.enabled);
    if (type === 'resume') return await this.resumePlayer(player, command.reconnectToken);
    if (type === 'finish') return await this.finishQuiz(player, 'host');
    if (type === 'leave') return await this.leaveRoom(player);
    throw new RoomError('Lệnh không được xử lý.', 400, 'unhandled_command');
  }

  requireHost(player) {
    if (player.role !== 'host') {
      throw new RoomError('Chỉ chủ phòng mới được thực hiện thao tác này.', 403, 'host_only');
    }
  }

  async createRoom(roomCodeValue, nicknameValue, questionDurationSecValue = DEFAULT_QUESTION_DURATION_SEC, questionSetValue = null) {
    const roomCode = normalizeRoomCode(roomCodeValue);
    if (this.room) {
      throw new RoomError('Phòng đã tồn tại.', 409, 'room_exists');
    }
    let questionSet;
    try {
      const candidate = questionSetValue || normalizeQuestionSettings().questionSets[0];
      if (!candidate) throw new RoomError('Chưa có bộ câu hỏi được nhập. Hãy import một bộ 20 câu trước khi tạo phòng.', 400, 'question_set_required');
      questionSet = normalizeQuestionSet(candidate);
    } catch (error) {
      if (error instanceof RoomError) throw error;
      if (error instanceof QuestionSetError) throw new RoomError(error.message, 400, 'invalid_question_set');
      throw error;
    }

    const now = currentTime();
    const capabilityToken = createOpaqueToken();
    const reconnectToken = createOpaqueToken();
    const [capabilityHash, reconnectHash] = await Promise.all([
      hashCapability(capabilityToken),
      hashCapability(reconnectToken)
    ]);
    const host = newPlayer({
      playerId: crypto.randomUUID(),
      roomCode,
      displayName: normalizeNickname(nicknameValue),
      role: 'host',
      playerSequence: 1,
      capability: { hash: capabilityHash },
      reconnect: { hash: reconnectHash },
      now
    });
    this.room = {
      roomCode,
      phase: 'lobby',
      roomStatus: 'active',
      roomVersion: 1,
      questionDurationSec: normalizeQuestionDurationSec(questionDurationSecValue),
      questionSetId: questionSet.id,
      questionSetName: questionSet.name,
      questions: questionSet.questions,
      questionOrder: shuffleQuestionIds(questionSet),
      questionIndex: -1,
      questionStartedAt: null,
      deadlineAt: null,
      pausedFromPhase: null,
      pausedRemainingMs: null,
      pendingFastestVoice: null,
      revealUntil: null,
      reveal: null,
      announcement: { kind: 'room_ready', text: 'Phòng chơi đã sẵn sàng.' },
      autoAdvance: false,
      createdAt: now,
      expiresAt: now + CAPABILITY_TTL_MS,
      finishedAt: null,
      players: [host],
      answers: {},
      persisted: false,
      finalizedByPlayerId: null,
      finalizedByCapabilityHash: null,
      finishedCapabilityHashes: [],
      rateWindows: {}
    };
    await this.save();
    return this.credentialsResult(host, capabilityToken, reconnectToken, 'created');
  }

  async joinRoom(roomCodeValue, nicknameValue) {
    const roomCode = normalizeRoomCode(roomCodeValue);
    if (!this.room || this.room.roomCode !== roomCode) {
      throw new RoomError('Không tìm thấy phòng chơi.', 404, 'room_not_found');
    }
    if (this.room.phase !== 'lobby') {
      throw new RoomError('Phòng đã bắt đầu hoặc đã kết thúc.', 409, 'room_not_joinable');
    }
    if (this.room.players.length >= MAX_PLAYERS) {
      throw new RoomError('Phòng đã đủ người chơi.', 409, 'room_full');
    }

    const now = currentTime();
    const displayName = this.uniqueNickname(normalizeNickname(nicknameValue));
    const capabilityToken = createOpaqueToken();
    const reconnectToken = createOpaqueToken();
    const [capabilityHash, reconnectHash] = await Promise.all([
      hashCapability(capabilityToken),
      hashCapability(reconnectToken)
    ]);
    const player = newPlayer({
      playerId: crypto.randomUUID(),
      roomCode,
      displayName,
      role: 'player',
      playerSequence: this.room.players.length + 1,
      capability: { hash: capabilityHash },
      reconnect: { hash: reconnectHash },
      now
    });
    this.room.players.push(player);
    this.bumpVersion({ kind: 'participant_joined', text: `${displayName} đã tham gia phòng.` });
    await this.save();
    this.broadcast({ event: 'snapshot', snapshot: this.snapshot() });
    return this.credentialsResult(player, capabilityToken, reconnectToken, 'joined');
  }

  uniqueNickname(baseName) {
    const used = new Set(this.room.players.map((player) => player.displayName));
    if (!used.has(baseName)) return baseName;
    let suffix = 2;
    while (used.has(`${baseName} #${suffix}`)) suffix += 1;
    return `${baseName} #${suffix}`;
  }

  credentialsResult(player, capabilityToken, reconnectToken, event) {
    return {
      event,
      player: this.publicPlayer(player),
      capabilityToken,
      reconnectToken,
      snapshot: this.snapshot()
    };
  }

  publicPlayer(player) {
    return {
      playerId: player.playerId,
      displayName: player.displayName,
      role: player.role,
      playerSequence: player.playerSequence,
      status: player.status
    };
  }

  questionBank() {
    return Array.isArray(this.room?.questions) && this.room.questions.length
      ? this.room.questions
      : questions;
  }

  questionCount() {
    return Array.isArray(this.room?.questionOrder) && this.room.questionOrder.length
      ? this.room.questionOrder.length
      : this.questionBank().length;
  }

  questionAt(index) {
    const bank = this.questionBank();
    const questionId = this.room?.questionOrder?.[index];
    return (questionId ? bank.find((question) => question.id === questionId) : bank[index]) || null;
  }

  async authenticate(command) {
    if (!this.room || this.room.phase === 'finished' || this.room.roomStatus === 'expired') {
      throw new RoomError('Phiên phòng đã kết thúc.', 401, 'room_finished');
    }
    const playerId = String(command?.playerId || '');
    const token = typeof command?.capabilityToken === 'string' ? command.capabilityToken : '';
    const player = this.room.players.find((candidate) => candidate.playerId === playerId);
    if (!player || !token) {
      throw new RoomError('Capability không hợp lệ.', 401, 'invalid_capability');
    }
    const tokenHash = await hashCapability(token);
    const now = currentTime();
    if (
      tokenHash !== player.capabilityTokenHash ||
      player.capabilityRevokedAt !== null ||
      now >= player.capabilityExpiresAt ||
      player.status === 'left'
    ) {
      throw new RoomError('Capability đã hết hạn hoặc bị thu hồi.', 401, 'invalid_capability');
    }
    return player;
  }

  async authenticateFinished(command) {
    if (!this.room || this.room.phase !== 'finished') {
      return this.authenticate(command);
    }
    const playerId = String(command?.playerId || '');
    const token = typeof command?.capabilityToken === 'string' ? command.capabilityToken : '';
    const player = this.room.players.find((candidate) => candidate.playerId === playerId);
    const tokenHash = token ? await hashCapability(token) : '';
    if (!player || !token || !(this.room.finishedCapabilityHashes || []).includes(tokenHash)) {
      throw new RoomError('Capability không hợp lệ.', 401, 'invalid_capability');
    }
    return player;
  }

  async authenticateSession(session) {
    if (!session?.playerId || !this.room) {
      throw new RoomError('Phiên WebSocket không hợp lệ.', 401, 'invalid_session');
    }
    const player = this.room.players.find((candidate) => candidate.playerId === session.playerId);
    const now = currentTime();
    if (
      !player ||
      player.capabilityTokenHash !== session.capabilityTokenHash ||
      player.capabilityRevokedAt !== null ||
      now >= player.capabilityExpiresAt ||
      player.status === 'left' ||
      this.room.phase === 'finished'
    ) {
      throw new RoomError('Capability đã hết hạn hoặc bị thu hồi.', 401, 'invalid_capability');
    }
    return player;
  }

  async startQuiz(player) {
    this.requireHost(player);
    if (this.room.phase !== 'lobby') {
      throw new RoomError('Quiz không ở sảnh chờ.', 409, 'invalid_phase');
    }
    await this.beginQuestion(0, { announcement: { kind: 'quiz_started', text: 'Quiz bắt đầu!' } });
    return { event: 'question', snapshot: this.snapshot() };
  }

  async submitAnswer(player, command) {
    if (player.role !== 'player') {
      throw new RoomError('Chủ phòng không trả lời như người chơi.', 403, 'host_cannot_answer');
    }
    const answerReceivedAt = currentTime();
    if (this.room.phase === 'question' && answerReceivedAt >= this.room.deadlineAt) {
      await this.maybeExpireQuestion();
      throw new RoomError('Đã hết giờ trả lời.', 409, 'late_answer');
    }
    await this.maybeExpireQuestion();
    if (this.room.phase !== 'question') {
      throw new RoomError('Câu hỏi hiện tại đã khóa.', 409, 'question_locked');
    }
    if (player.status !== 'online') {
      throw new RoomError('Người chơi đang ngoại tuyến.', 409, 'player_offline');
    }
    const option = assertOption(command.option);
    const answerKey = this.answerKey(player.playerId, this.room.questionIndex);
    if (this.room.answers[answerKey]) {
      throw new RoomError('Bạn chỉ được trả lời một lần cho mỗi câu.', 409, 'duplicate_answer');
    }
    const now = currentTime();
    if (now >= this.room.deadlineAt) {
      throw new RoomError('Đã hết giờ trả lời.', 409, 'late_answer');
    }
    const question = this.questionAt(this.room.questionIndex);
    const result = calculateScore({
      isCorrect: option === question.correctOption,
      questionStartedAt: this.room.questionStartedAt,
      deadlineAt: this.room.deadlineAt,
      receivedAt: now,
      questionDurationMs: this.questionDurationMs()
    });
    this.room.answers[answerKey] = {
      answerId: crypto.randomUUID(),
      playerId: player.playerId,
      questionIndex: this.room.questionIndex,
      questionId: question.id,
      option,
      isCorrect: option === question.correctOption,
      score: result.score,
      responseTimeMs: result.responseTimeMs,
      receivedAt: now
    };
    let queuedFastestVoice = null;
    if (result.score > 0 && !this.room.pendingFastestVoice) {
      const text = `Chúc mừng ${player.displayName} đã trả lời đúng và nhanh nhất!`;
      const assetId = this.voiceAssetId('fastest-correct', this.room.questionIndex + 1);
      this.room.pendingFastestVoice = {
        questionIndex: this.room.questionIndex,
        playerId: player.playerId,
        text,
        assetId,
        voiceAssetId: null,
        ready: false
      };
      queuedFastestVoice = this.room.pendingFastestVoice;
    }
    player.totalScore += result.score;
    player.totalResponseMs += result.responseTimeMs;
    this.bumpVersion();
    await this.save();
    const event = result.score > 0 ? 'correct' : 'incorrect';
    this.broadcast({ event, snapshot: this.snapshot(), result: { ...result, accepted: true } });
    if (queuedFastestVoice) {
      this.queueDynamicVoice({
        text: queuedFastestVoice.text,
        assetId: queuedFastestVoice.assetId,
        expectedPhase: 'question',
        expectedQuestionIndex: queuedFastestVoice.questionIndex,
        expectedPlayerId: queuedFastestVoice.playerId,
        pendingFastestVoice: true
      });
    }
    // The direct command response may reveal the correct option to the player
    // who just answered. The broadcast above intentionally remains generic so
    // other players can continue answering without seeing the key early.
    return { event, result: { ...result, accepted: true, correctOption: question.correctOption }, snapshot: this.snapshot() };
  }

  async hostNext(player) {
    this.requireHost(player);
    if (this.room.phase === 'question') {
      await this.maybeExpireQuestion();
      if (this.room.phase === 'question') {
        await this.enterReveal('manual');
      }
    } else if (this.room.phase === 'reveal') {
      await this.advanceQuestion();
    } else {
      throw new RoomError('Không thể chuyển câu ở giai đoạn này.', 409, 'invalid_phase');
    }
    return { event: this.room.phase === 'reveal' ? 'reveal' : this.room.phase === 'finished' ? 'finished' : 'question', snapshot: this.snapshot() };
  }

  async setAutoAdvance(player, enabled) {
    this.requireHost(player);
    if (typeof enabled !== 'boolean') {
      throw new RoomError('Chế độ tự chuyển phải là true hoặc false.', 400, 'invalid_auto_advance');
    }
    this.room.autoAdvance = enabled;
    if (enabled && this.room.phase === 'reveal' && !this.room.revealUntil) {
      this.room.revealUntil = currentTime() + REVEAL_MS;
      this.ctx.storage.setAlarm(this.room.revealUntil);
    }
    if (!enabled) this.room.revealUntil = null;
    this.bumpVersion({ kind: 'auto_advance_changed', enabled });
    await this.save();
    this.broadcast({ event: 'snapshot', snapshot: this.snapshot() });
    return { event: 'snapshot', snapshot: this.snapshot() };
  }

  async resumePlayer(player, reconnectToken) {
    const token = typeof reconnectToken === 'string' ? reconnectToken : '';
    return await this.resumeWithReconnect(player, token);
  }

  async resumeWithReconnect(player, reconnectToken) {
    const hash = await hashCapability(reconnectToken);
    const now = currentTime();
    if (
      !reconnectToken ||
      hash !== player.reconnectTokenHash ||
      player.reconnectRevokedAt !== null ||
      player.reconnectExpiresAt === null ||
      now >= player.reconnectExpiresAt
    ) {
      throw new RoomError('Reconnect token đã hết hạn hoặc bị thu hồi.', 401, 'invalid_reconnect');
    }
    const replacement = await this.rotateReconnectToken(player);
    player.status = 'online';
    player.connectedAt = now;
    player.disconnectedAt = null;
    if (this.room.phase === 'paused_host_disconnect' && player.role === 'host') {
      await this.resumeHostAfterDisconnect();
    }
    this.bumpVersion({ kind: 'participant_resumed', playerId: player.playerId });
    await this.save();
    this.broadcast({ event: 'snapshot', snapshot: this.snapshot() });
    return {
      event: 'resumed',
      reconnectToken: replacement.token,
      snapshot: this.snapshot()
    };
  }

  async rotateReconnectToken(player) {
    const token = createOpaqueToken();
    player.reconnectTokenHash = await hashCapability(token);
    player.reconnectIssuedAt = null;
    player.reconnectExpiresAt = null;
    player.reconnectRevokedAt = null;
    return { token };
  }

  async finishQuiz(player, reason = 'host') {
    this.requireHost(player);
    if (!['lobby', 'question', 'reveal', 'paused_host_disconnect'].includes(this.room.phase)) {
      throw new RoomError('Quiz đã kết thúc.', 409, 'invalid_phase');
    }
    if (this.room.phase === 'question') await this.enterReveal('finish', { queueVoice: false });
    this.room.phase = 'finished';
    this.room.roomStatus = reason === 'expired' ? 'expired' : 'finished';
    this.room.finishedAt = currentTime();
    this.room.finalizedByPlayerId = player.playerId;
    this.room.finalizedByCapabilityHash = player.capabilityTokenHash;
    this.room.finishedCapabilityHashes = this.room.players.map(({ capabilityTokenHash }) => capabilityTokenHash);
    this.room.revealUntil = null;
    const { topTen } = this.finalResultsAnnouncement();
    this.room.announcement = {
      kind: 'final_results',
      text: 'Màn chơi đã kết thúc.',
      topTen
    };
    this.revokeAllTokens();
    this.bumpVersion();
    await this.save();
    await this.persistFinalResults();
    this.broadcast({ event: 'finished', snapshot: this.snapshot() });
    return { event: 'finished', snapshot: this.snapshot() };
  }

  async finalizeResult(command) {
    const playerId = typeof command?.playerId === 'string' ? command.playerId : '';
    const capabilityToken = typeof command?.capabilityToken === 'string' ? command.capabilityToken : '';
    if (this.room?.phase === 'finished') {
      const tokenHash = capabilityToken ? await hashCapability(capabilityToken) : '';
      if (!playerId || !(this.room.finishedCapabilityHashes || []).includes(tokenHash)) {
        throw new RoomError('Capability không hợp lệ.', 401, 'invalid_capability');
      }
      return { event: 'finished', idempotent: true, snapshot: this.snapshot() };
    }
    const player = await this.authenticate(command);
    this.requireHost(player);
    const result = await this.finishQuiz(player, 'api');
    return { ...result, idempotent: false };
  }

  async leaveRoom(player) {
    player.status = 'left';
    player.leftAt = currentTime();
    player.disconnectedAt = player.leftAt;
    this.revokePlayerTokens(player);
    if (player.role === 'host' && this.room.phase !== 'finished') {
      await this.pauseForHostDisconnect(player.leftAt);
    } else {
      this.bumpVersion({ kind: 'participant_left', playerId: player.playerId });
      await this.save();
      this.broadcast({ event: 'snapshot', snapshot: this.snapshot() });
    }
    return { event: 'left', snapshot: this.snapshot() };
  }

  async beginQuestion(index, { announcement = null } = {}) {
    const now = currentTime();
    this.room.phase = 'question';
    this.room.pausedFromPhase = null;
    this.room.pausedRemainingMs = null;
    this.room.questionIndex = index;
    this.room.pendingFastestVoice = null;
    this.room.questionStartedAt = now;
    this.room.deadlineAt = now + this.questionDurationMs();
    this.room.reveal = null;
    this.room.revealUntil = null;
    this.room.announcement = announcement;
    this.bumpVersion();
    await this.save();
    this.ctx.storage.setAlarm(this.room.deadlineAt);
    this.broadcast({ event: 'question', snapshot: this.snapshot() });
  }

  answerKey(playerId, questionIndex) {
    return `${playerId}:${questionIndex}`;
  }

  async maybeExpireQuestion() {
    if (this.room.phase === 'question' && currentTime() >= this.room.deadlineAt) {
      await this.enterReveal('timeout');
    }
  }

  async enterReveal(reason, { queueVoice = true } = {}) {
    if (this.room.phase !== 'question') return;
    const now = currentTime();
    const question = this.questionAt(this.room.questionIndex);
    const answers = Object.values(this.room.answers)
      .filter((answer) => answer.questionIndex === this.room.questionIndex);
    for (const player of this.room.players) {
      if (player.role !== 'player' || player.status === 'left') continue;
      const answer = this.room.answers[this.answerKey(player.playerId, this.room.questionIndex)];
      if (!answer) {
        player.missedQuestions += 1;
        player.totalResponseMs += this.questionDurationMs();
      }
    }
    const correct = answers
      .filter((answer) => answer.isCorrect)
      .sort((left, right) => left.responseTimeMs - right.responseTimeMs || this.playerSequence(left.playerId) - this.playerSequence(right.playerId))[0];
    this.room.phase = 'reveal';
    this.room.deadlineAt = null;
    this.room.revealUntil = this.room.autoAdvance ? now + REVEAL_MS : null;
    this.room.reveal = {
      questionId: question.id,
      correctOption: question.correctOption,
      explanation: question.explanation,
      reason,
      fastestCorrectPlayerId: correct?.playerId || null
    };
    this.bumpVersion();
    if (correct) {
      const fastestName = this.playerById(correct.playerId).displayName;
      const text = `Chúc mừng ${fastestName} đã trả lời đúng và nhanh nhất!`;
      const pending = this.room.pendingFastestVoice;
      const voiceAssetId = pending?.questionIndex === this.room.questionIndex && pending.playerId === correct.playerId && pending.ready
        ? pending.voiceAssetId
        : null;
      this.room.announcement = {
        kind: 'fastest_correct',
        text,
        playerId: correct.playerId,
        ...(voiceAssetId ? { voiceAssetId } : {})
      };
    } else {
      this.room.announcement = { kind: 'no_correct_answer', text: 'Chưa có người trả lời đúng câu này.' };
    }
    await this.save();
    if (this.room.autoAdvance) this.ctx.storage.setAlarm(this.room.revealUntil);
    this.broadcast({ event: 'reveal', snapshot: this.snapshot() });
    const pending = this.room.pendingFastestVoice;
    if (correct && pending?.questionIndex === this.room.questionIndex && pending.playerId === correct.playerId && !pending.ready) {
      this.queueDynamicVoice({
        text: pending.text,
        assetId: pending.assetId,
        expectedPhase: 'reveal',
        expectedQuestionIndex: pending.questionIndex,
        expectedKind: 'fastest_correct',
        expectedPlayerId: pending.playerId,
        pendingFastestVoice: true
      });
    }
  }

  async advanceQuestion() {
    if (this.room.questionIndex >= this.questionCount() - 1) {
      const host = this.room.players.find((player) => player.role === 'host');
      if (host) return await this.finishQuiz(host, 'host');
      this.room.phase = 'finished';
      this.room.roomStatus = 'finished';
      this.revokeAllTokens();
      this.bumpVersion();
      await this.save();
      return;
    }
    await this.beginQuestion(this.room.questionIndex + 1);
  }

  async pauseForHostDisconnect(now = currentTime()) {
    if (this.room.phase === 'finished' || this.room.phase === 'paused_host_disconnect') return;
    this.room.pausedFromPhase = this.room.phase;
    this.room.pausedRemainingMs = this.room.phase === 'question'
      ? Math.max(0, this.room.deadlineAt - now)
      : null;
    this.room.phase = 'paused_host_disconnect';
    this.room.deadlineAt = null;
    this.room.revealUntil = null;
    this.room.announcement = { kind: 'host_disconnected', text: 'Chủ phòng đã mất kết nối. Đang tạm dừng.' };
    this.bumpVersion();
    await this.save();
    this.broadcast({ event: 'paused_host_disconnect', snapshot: this.snapshot() });
  }

  async resumeHostAfterDisconnect() {
    if (this.room.phase !== 'paused_host_disconnect') return;
    const previousPhase = this.room.pausedFromPhase || 'lobby';
    this.room.phase = previousPhase;
    if (previousPhase === 'question') {
      const remainingMs = Math.max(0, this.room.pausedRemainingMs || 0);
      const now = currentTime();
      this.room.questionStartedAt = now - (this.questionDurationMs() - remainingMs);
      this.room.deadlineAt = now + remainingMs;
      if (remainingMs === 0) await this.enterReveal('timeout');
      else this.ctx.storage.setAlarm(this.room.deadlineAt);
    }
    this.room.pausedFromPhase = null;
    this.room.pausedRemainingMs = null;
    this.room.announcement = { kind: 'host_resumed', text: 'Chủ phòng đã kết nối lại.' };
    this.bumpVersion();
    await this.save();
  }

  async expireIfNeeded() {
    if (!this.room || this.room.phase === 'finished') return;
    if (currentTime() < this.room.expiresAt) return;
    this.room.roomStatus = 'expired';
    this.room.phase = 'finished';
    this.room.finishedAt = currentTime();
    this.room.announcement = { kind: 'room_expired', text: 'Phòng chơi đã hết hạn.' };
    this.revokeAllTokens();
    this.bumpVersion();
    await this.save();
    await this.persistFinalResults();
    this.broadcast({ event: 'finished', snapshot: this.snapshot() });
  }

  playerById(playerId) {
    const player = this.room.players.find((candidate) => candidate.playerId === playerId);
    if (!player) throw new RoomError('Không tìm thấy người chơi.', 404, 'player_not_found');
    return player;
  }

  playerSequence(playerId) {
    return this.playerById(playerId).playerSequence;
  }

  revokePlayerTokens(player) {
    const now = currentTime();
    player.capabilityRevokedAt = now;
    player.reconnectRevokedAt = now;
  }

  revokeAllTokens() {
    for (const player of this.room.players) this.revokePlayerTokens(player);
  }

  bumpVersion(announcement = undefined) {
    this.room.roomVersion += 1;
    if (announcement !== undefined) this.room.announcement = announcement;
  }

  publicAnswerForPlayer(player) {
    if (this.room.questionIndex < 0) return null;
    const answer = this.room.answers[this.answerKey(player.playerId, this.room.questionIndex)];
    return answer ? { option: answer.option, score: answer.score, responseTimeMs: answer.responseTimeMs } : null;
  }

  leaderboard() {
    return this.room.players
      .filter((player) => player.role === 'player' && player.status !== 'left')
      .map((player) => ({
        playerId: player.playerId,
        displayName: player.displayName,
        playerSequence: player.playerSequence,
        totalScore: player.totalScore,
        totalResponseMs: player.totalResponseMs,
        status: player.status
      }))
      .sort(compareLeaderboard)
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  snapshot() {
    const now = currentTime();
    const question = this.room && this.room.questionIndex >= 0 ? this.questionAt(this.room.questionIndex) : null;
    const currentAnswer = question ? Object.fromEntries(this.room.players.map((player) => [
      player.playerId,
      this.publicAnswerForPlayer(player) ? { accepted: true } : null
    ])) : {};
    return {
      roomCode: this.room?.roomCode || null,
      roomVersion: this.room?.roomVersion || 0,
      phase: this.room?.phase || 'lobby',
      roomStatus: this.room?.roomStatus || 'active',
      questionIndex: this.room?.questionIndex ?? -1,
      questionStartedAt: this.room?.questionStartedAt || null,
      deadlineAt: this.room?.deadlineAt || null,
      questionDurationSec: this.room?.questionDurationSec || DEFAULT_QUESTION_DURATION_SEC,
      serverNow: now,
      remainingMs: this.room?.phase === 'question' && this.room.deadlineAt
        ? Math.max(0, this.room.deadlineAt - now)
        : this.room?.phase === 'paused_host_disconnect' ? this.room.pausedRemainingMs : null,
      autoAdvance: this.room?.autoAdvance || false,
      question: question ? publicQuestion(question) : null,
      reveal: this.room?.reveal || null,
      announcement: this.room?.announcement || null,
      participants: this.room?.players?.map((player) => ({
        ...this.publicPlayer(player),
        connectedAt: player.connectedAt,
        disconnectedAt: player.disconnectedAt,
        answeredCurrent: Boolean(currentAnswer[player.playerId])
      })) || [],
      answers: currentAnswer,
      leaderboard: this.room ? this.leaderboard() : [],
      finalResults: this.room?.phase === 'finished' ? this.leaderboard().slice(0, 10) : null
    };
  }

  async save() {
    await this.ctx.storage.put(STORAGE_KEY, this.room);
  }

  questionDurationMs() {
    return normalizeQuestionDurationSec(this.room?.questionDurationSec) * 1000;
  }

  async quizSettings() {
    const stored = await this.ctx.storage.get(QUIZ_SETTINGS_STORAGE_KEY);
    const questionSettings = normalizeQuestionSettings(stored);
    return {
      questionDurationSec: normalizeQuestionDurationSec(stored?.questionDurationSec),
      activeQuestionSetId: questionSettings.activeQuestionSetId,
      questionSets: questionSettings.questionSets
    };
  }

  async readQuizSettings() {
    return safeJson({ ok: true, settings: await this.quizSettings() });
  }

  async writeQuizSettings(request) {
    const body = await this.readJson(request, MAX_SETTINGS_BODY_BYTES);
    let questionSettings;
    try {
      questionSettings = normalizeQuestionSettings(body);
    } catch (error) {
      if (error instanceof QuestionSetError) throw new RoomError(error.message, 400, 'invalid_question_set');
      throw error;
    }
    const settings = {
      questionDurationSec: normalizeQuestionDurationSec(body?.questionDurationSec),
      activeQuestionSetId: questionSettings.activeQuestionSetId,
      questionSets: questionSettings.questionSets
    };
    await this.ctx.storage.put(QUIZ_SETTINGS_STORAGE_KEY, settings);
    return safeJson({ ok: true, settings });
  }

  async persistFinalResults() {
    if (!this.room || this.room.persisted) return;
    const finalResults = {
      roomCode: this.room.roomCode,
      finishedAt: this.room.finishedAt || currentTime(),
      createdAt: this.room.createdAt,
      questionCount: this.questionCount(),
      playerCount: this.room.players.filter(({ role, status }) => role === 'player' && status !== 'left').length,
      leaderboard: this.leaderboard()
    };
    await this.ctx.storage.put('quiz-final-results-v1', finalResults);
    await this.persistHistory(finalResults);
    this.room.persisted = true;
    await this.save();
  }

  async persistHistory(finalResults) {
    const binding = this.env?.QUIZ_ROOM;
    if (!binding || typeof binding.idFromName !== 'function' || typeof binding.get !== 'function') return;
    try {
      const allocator = binding.get(binding.idFromName(ROOM_ALLOCATOR_ID));
      await allocator.fetch(new Request('https://quiz-room.internal/history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Quiz-Internal': 'history-writer'
        },
        body: JSON.stringify({ type: 'record', ...finalResults })
      }));
    } catch {
      // Room-local results remain authoritative if the history index is unavailable.
    }
  }

  async readHistory() {
    const history = await this.ctx.storage.get(HISTORY_STORAGE_KEY) || [];
    return safeJson({ ok: true, history: Array.isArray(history) ? history : [] });
  }

  async clearHistory() {
    await this.ctx.storage.delete(HISTORY_STORAGE_KEY);
    return safeJson({ ok: true, history: [] });
  }

  async recordHistory(request) {
    const body = await this.readJson(request);
    if (body?.type !== 'record' || typeof body.roomCode !== 'string' || !body.roomCode) {
      return safeJson({ ok: false, error: 'Dữ liệu lịch sử không hợp lệ.', code: 'invalid_history_record' }, 400);
    }
    const entry = {
      roomCode: body.roomCode,
      createdAt: Number(body.createdAt) || currentTime(),
      finishedAt: Number(body.finishedAt) || currentTime(),
      questionCount: Math.max(0, Number(body.questionCount) || 0),
      playerCount: Math.max(0, Number(body.playerCount) || 0),
      leaderboard: Array.isArray(body.leaderboard) ? body.leaderboard.slice(0, 100).map((row, index) => ({
        rank: Number(row.rank) || index + 1,
        displayName: String(row.displayName || 'Người chơi').slice(0, 32),
        totalScore: Math.max(0, Number(row.totalScore) || 0),
        totalResponseMs: Math.max(0, Number(row.totalResponseMs) || 0)
      })) : []
    };
    const history = await this.ctx.storage.get(HISTORY_STORAGE_KEY) || [];
    const next = [entry, ...(Array.isArray(history) ? history : []).filter((item) => item?.roomCode !== entry.roomCode)]
      .slice(0, HISTORY_LIMIT);
    await this.ctx.storage.put(HISTORY_STORAGE_KEY, next);
    return safeJson({ ok: true, history: next });
  }

  async upgradeWebSocket(request, roomCode) {
    if (!this.room || !roomCode || this.room.roomCode !== roomCode) {
      return new Response('Room not found', { status: 404 });
    }
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId');
    const capabilityToken = url.searchParams.get('capabilityToken');
    const reconnectToken = url.searchParams.get('reconnectToken');
    const player = await this.authenticate({ playerId, capabilityToken });
    let resumeResult = null;
    if (player.status === 'offline' && !reconnectToken) {
      throw new RoomError('Reconnect token bắt buộc sau khi mất kết nối.', 401, 'invalid_reconnect');
    }
    if (reconnectToken) {
      resumeResult = await this.resumeWithReconnect(player, reconnectToken);
    }
    player.status = 'online';
    player.connectedAt = currentTime();
    player.disconnectedAt = null;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const attachment = {
      playerId: player.playerId,
      role: player.role,
      capabilityTokenHash: player.capabilityTokenHash,
      reconnectTokenHash: player.reconnectTokenHash
    };
    server.serializeAttachment(attachment);
    this.sessions.set(server, attachment);
    this.bumpVersion({ kind: 'participant_online', playerId: player.playerId });
    await this.save();
    if (resumeResult) this.send(server, { ok: true, ...resumeResult });
    this.broadcast({ event: 'snapshot', snapshot: this.snapshot() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(websocket, message) {
    await this.ready;
    if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      websocket.close(1009, 'message too large');
      return;
    }
    let command;
    try {
      command = JSON.parse(message);
    } catch {
      this.send(websocket, { event: 'error', error: 'JSON không hợp lệ.', code: 'invalid_json' });
      return;
    }
    const session = this.sessions.get(websocket) || websocket.deserializeAttachment();
    try {
      const player = await this.authenticateSession(session);
      this.enforceRateLimit(player.playerId);
      const result = await this.dispatchSocketCommand(command, player);
      this.send(websocket, { ok: true, ...result });
    } catch (error) {
      this.send(websocket, {
        ok: false,
        event: 'error',
        error: error instanceof RoomError ? error.message : 'Lỗi máy chủ phòng chơi.',
        code: error instanceof RoomError ? error.code : 'internal_error'
      });
    }
  }

  async dispatchSocketCommand(command, player) {
    if (command.type === 'start') return await this.startQuiz(player);
    if (command.type === 'answer') return await this.submitAnswer(player, command);
    if (command.type === 'next') return await this.hostNext(player);
    if (command.type === 'setAutoAdvance') return await this.setAutoAdvance(player, command.enabled);
    if (command.type === 'resume') return await this.resumeWithReconnect(player, command.reconnectToken);
    if (command.type === 'finish') return await this.finishQuiz(player, 'host');
    if (command.type === 'leave') return await this.leaveRoom(player);
    if (command.type === 'snapshot') return { event: 'snapshot', snapshot: this.snapshot() };
    throw new RoomError('Lệnh WebSocket không hợp lệ.', 400, 'invalid_message_type');
  }

  enforceRateLimit(playerId) {
    const now = currentTime();
    const windowStart = now - 10_000;
    const timestamps = (this.room.rateWindows[playerId] || []).filter((timestamp) => timestamp > windowStart);
    if (timestamps.length >= 60) {
      throw new RoomError('Bạn gửi thao tác quá nhanh.', 429, 'rate_limited');
    }
    timestamps.push(now);
    this.room.rateWindows[playerId] = timestamps;
  }

  send(websocket, payload) {
    try {
      websocket.send(JSON.stringify(payload));
    } catch {
      // The close handler owns offline state; a stale socket cannot break the room actor.
    }
  }

  broadcast(payload) {
    for (const websocket of this.sessions.keys()) this.send(websocket, payload);
  }

  async webSocketClose(websocket) {
    await this.markSocketOffline(websocket);
  }

  async webSocketError(websocket) {
    await this.markSocketOffline(websocket);
  }

  async markSocketOffline(websocket) {
    const session = this.sessions.get(websocket) || websocket.deserializeAttachment();
    this.sessions.delete(websocket);
    if (!session?.playerId || !this.room) return;
    const player = this.room.players.find((candidate) => candidate.playerId === session.playerId);
    if (!player || player.status === 'left' || this.room.phase === 'finished') return;
    const now = currentTime();
    player.status = 'offline';
    player.disconnectedAt = now;
    player.reconnectIssuedAt = now;
    player.reconnectExpiresAt = now + RECONNECT_TTL_MS;
    if (player.role === 'host') await this.pauseForHostDisconnect(now);
    else {
      this.bumpVersion({ kind: 'player_offline', playerId: player.playerId });
      await this.save();
      this.broadcast({ event: 'snapshot', snapshot: this.snapshot() });
    }
  }

  async alarm() {
    await this.ready;
    if (!this.room || this.room.phase === 'finished') return;
    if (this.room.phase === 'question' && currentTime() >= this.room.deadlineAt) {
      await this.enterReveal('timeout');
      return;
    }
    if (this.room.phase === 'reveal' && this.room.autoAdvance && currentTime() >= this.room.revealUntil) {
      await this.advanceQuestion();
    }
  }

  async allocateRoom(request) {
    if (request.method !== 'POST') {
      return safeJson({ ok: false, error: 'Phương thức không được hỗ trợ.', code: 'method_not_allowed' }, 405);
    }
    if (!this.env.QUIZ_ROOM || typeof this.env.QUIZ_ROOM.idFromName !== 'function') {
      return safeJson({ ok: false, error: 'Dịch vụ phòng chơi chưa được cấu hình.', code: 'missing_room_binding' }, 503);
    }
    const body = await this.readJson(request);
    if (body?.type !== 'create') {
      return safeJson({ ok: false, error: 'Thao tác phòng chơi không hợp lệ.', code: 'invalid_room_action' }, 400);
    }
    const settings = await this.quizSettings();
    const activeQuestionSet = settings.questionSets.find((item) => item.id === settings.activeQuestionSetId) || settings.questionSets[0];
    if (!activeQuestionSet) {
      return safeJson({ ok: false, error: 'Chưa có bộ câu hỏi được nhập. Hãy import một bộ 20 câu trước khi tạo phòng.', code: 'question_set_required' }, 400);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const roomCode = createRoomCode();
      const id = this.env.QUIZ_ROOM.idFromName(roomCode);
      const stub = this.env.QUIZ_ROOM.get(id);
      const target = new URL(request.url);
      target.pathname = `/rooms/${roomCode}`;
      const response = await stub.fetch(new Request(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ type: 'create', nickname: body.nickname, questionDurationSec: settings.questionDurationSec, questionSet: activeQuestionSet })
      }));
      if (response.status !== 409) return response;
    }
    return safeJson({ ok: false, error: 'Không thể tạo mã phòng lúc này.', code: 'room_allocation_failed' }, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/\/rooms\/([^/]+)/u);
    if (!match) {
      return safeJson({ ok: true, service: 'quiz-room-worker' });
    }
    const roomCode = normalizeRoomCode(match[1]);
    if (!env.QUIZ_ROOM) {
      return safeJson({ ok: false, error: 'Durable Object binding chưa được cấu hình.', code: 'missing_room_binding' }, 503);
    }
    const id = env.QUIZ_ROOM.idFromName(roomCode);
    return env.QUIZ_ROOM.get(id).fetch(request);
  }
};
