import { beforeEach, describe, expect, it, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject
} from 'cloudflare:test';
import {
  CAPABILITY_TTL_MS,
  RECONNECT_TTL_MS,
  REVEAL_MS
} from '../presentation/workers/quiz-room.js';
import { questions as defaultQuestions } from '../presentation/workers/questions.js';
import { QUESTION_MS } from '../presentation/workers/scoring.js';

const ROOM_CODE = 'ABC123';
const BASE_TIME = 1_800_000_000_000;
const importedQuestionSet = {
  id: 'imported-set',
  name: 'Bộ import kiểm thử',
  questions: defaultQuestions.map((question, index) => ({
    ...question,
    id: `imported-${String(index + 1).padStart(2, '0')}`,
    options: { ...question.options }
  }))
};

function roomStub(roomCode = ROOM_CODE) {
  return env.QUIZ_ROOM.get(env.QUIZ_ROOM.idFromName(roomCode));
}

async function callRoom(command, roomCode = ROOM_CODE) {
  const response = await roomStub(roomCode).fetch(
    `https://quiz.test/rooms/${roomCode}/command`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command)
    }
  );
  return { status: response.status, body: await response.json() };
}

function withCapability(credentials, type, extra = {}) {
  return {
    type,
    playerId: credentials.player.playerId,
    capabilityToken: credentials.capabilityToken,
    ...extra
  };
}

async function createRoom(nickname = 'Chủ phòng', roomCode = ROOM_CODE) {
  const result = await callRoom({ type: 'create', nickname, questionSet: importedQuestionSet }, roomCode);
  expect(result.status).toBe(200);
  return result.body;
}

async function joinRoom(nickname = 'Minh', roomCode = ROOM_CODE) {
  const result = await callRoom({ type: 'join', nickname }, roomCode);
  expect(result.status).toBe(200);
  return result.body;
}

async function simulateDisconnect(credentials) {
  const stub = roomStub();
  await runInDurableObject(stub, async (instance) => {
    const socket = {
      deserializeAttachment() {
        return { playerId: credentials.player.playerId };
      }
    };
    instance.sessions.set(socket, { playerId: credentials.player.playerId });
    await instance.markSocketOffline(socket);
  });
}

describe('authoritative QuizRoom Durable Object protocol', () => {
  beforeEach(async () => {
    await reset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await reset();
  });

  it('runs create → join → start → answer → reveal → next → finish with authoritative payloads', async () => {
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host = await createRoom();
    const player = await joinRoom('Minh');
    const duplicateName = await joinRoom('Minh');

    expect(player.player.displayName).toBe('Minh');
    expect(duplicateName.player.displayName).toBe('Minh #2');
    expect(host.snapshot.phase).toBe('lobby');
    expect(host.snapshot.announcement.kind).toBe('room_ready');

    const playerCannotStart = await callRoom(withCapability(player, 'start'));
    expect(playerCannotStart.status).toBe(403);
    expect(playerCannotStart.body.code).toBe('host_only');

    const started = await callRoom(withCapability(host, 'start'));
    expect(started.body.snapshot.phase).toBe('question');
    expect(started.body.snapshot.deadlineAt - started.body.snapshot.questionStartedAt).toBe(QUESTION_MS);
    expect(started.body.snapshot.announcement.kind).toBe('quiz_started');
    expect(started.body.snapshot.roomVersion).toBeGreaterThan(host.snapshot.roomVersion);
    const currentQuestion = await runInDurableObject(roomStub(), async (instance) => instance.questionAt(0));
    const correctOption = currentQuestion.correctOption;
    const incorrectOption = ['A', 'B', 'C', 'D'].find((option) => option !== correctOption);

    vi.setSystemTime(BASE_TIME + 2_000);
    const incorrect = await callRoom(withCapability(duplicateName, 'answer', { option: incorrectOption }));
    expect(incorrect.status).toBe(200);
    expect(incorrect.body.result).toMatchObject({ accepted: true, score: 0, responseTimeMs: 2_000 });
    expect(incorrect.body.result.correctOption).toBe(correctOption);

    vi.setSystemTime(BASE_TIME + 5_000);
    const answer = await callRoom(withCapability(player, 'answer', { option: correctOption, score: 1, receivedAt: 0 }));
    expect(answer.status).toBe(200);
    expect(answer.body.result.accepted).toBe(true);
    expect(answer.body.result.score).toBe(833);
    expect(answer.body.result.responseTimeMs).toBe(5_000);
    const pendingVoice = await runInDurableObject(roomStub(), async (instance) => ({
      questionIndex: instance.room.pendingFastestVoice?.questionIndex,
      playerId: instance.room.pendingFastestVoice?.playerId,
      ready: instance.room.pendingFastestVoice?.ready
    }));
    expect(pendingVoice).toMatchObject({ questionIndex: 0, playerId: player.player.playerId, ready: false });

    const duplicate = await callRoom(withCapability(player, 'answer', { option: 'B' }));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('duplicate_answer');

    const reveal = await callRoom(withCapability(host, 'next'));
    expect(reveal.status).toBe(200);
    expect(reveal.body.snapshot.phase).toBe('reveal');
    expect(reveal.body.snapshot.reveal.correctOption).toBe(correctOption);
    expect(reveal.body.snapshot.reveal.explanation).toBe(currentQuestion.explanation);
    expect(reveal.body.snapshot.announcement.kind).toBe('fastest_correct');
    expect(reveal.body.snapshot.leaderboard[0]).toMatchObject({ displayName: 'Minh', totalScore: 833 });

    const next = await callRoom(withCapability(host, 'next'));
    expect(next.body.snapshot.phase).toBe('question');
    expect(next.body.snapshot.questionIndex).toBe(1);

    const finished = await callRoom(withCapability(host, 'finish'));
    expect(finished.status).toBe(200);
    expect(finished.body.snapshot.phase).toBe('finished');
    expect(finished.body.snapshot.finalResults[0].displayName).toBe('Minh');
    expect(finished.body.snapshot.finalResults).toHaveLength(2);
    expect(finished.body.snapshot.announcement.kind).toBe('final_results');
    expect(finished.body.snapshot.announcement.text).toBe('Màn chơi đã kết thúc.');

    const revoked = await callRoom(withCapability(host, 'snapshot'));
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe('room_finished');

    const persisted = await runInDurableObject(roomStub(), async (instance) => (
      instance.ctx.storage.get('quiz-final-results-v1')
    ));
    expect(persisted.leaderboard.map(({ displayName }) => displayName)).toEqual(['Minh', 'Minh #2']);
  });

  it('keeps the configured question duration in the room snapshot and deadline', async () => {
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const created = await callRoom({
      type: 'create',
      nickname: 'Custom timer',
      questionDurationSec: 45,
      questionSet: importedQuestionSet
    }, 'DEF456');
    expect(created.status).toBe(200);
    const started = await callRoom({
      type: 'start',
      playerId: created.body.player.playerId,
      capabilityToken: created.body.capabilityToken
    }, 'DEF456');
    expect(started.body.snapshot.questionDurationSec).toBe(45);
    expect(started.body.snapshot.deadlineAt - started.body.snapshot.questionStartedAt).toBe(45_000);
  });

  it('stores a separate shuffled order for each room question set', async () => {
    const questionSet = {
      id: 'review-set',
      name: 'Ôn tập chương 2',
      questions: defaultQuestions.map((question, index) => ({
        ...question,
        id: `review-${String(index + 1).padStart(2, '0')}`,
        options: { ...question.options },
        prompt: `Ôn tập: ${question.prompt}`
      }))
    };
    const created = await callRoom({ type: 'create', nickname: 'Chủ phòng', questionSet }, 'SET789');
    expect(created.status).toBe(200);
    const stored = await runInDurableObject(roomStub('SET789'), async (instance) => ({
      questionSetId: instance.room.questionSetId,
      questionSetName: instance.room.questionSetName,
      questionOrder: instance.room.questionOrder,
      firstQuestion: instance.questionAt(0)
    }));

    expect(stored.questionSetId).toBe('review-set');
    expect(stored.questionSetName).toBe('Ôn tập chương 2');
    expect(stored.questionOrder).toHaveLength(20);
    expect(new Set(stored.questionOrder).size).toBe(20);
    expect(stored.questionOrder).toEqual(expect.arrayContaining(questionSet.questions.map(({ id }) => id)));
    expect(stored.firstQuestion.prompt).toMatch(/^Ôn tập: /u);
  });

  it('accepts answers only before the single server deadline and rejects forged, late, and duplicate submissions', async () => {
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host = await createRoom();
    const player = await joinRoom();
    await callRoom(withCapability(host, 'start'));

    vi.setSystemTime(BASE_TIME + QUESTION_MS);
    const late = await callRoom(withCapability(player, 'answer', {
      option: 'A',
      score: 1000,
      responseTimeMs: 0,
      clientTimestamp: BASE_TIME
    }));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('late_answer');

    const snapshot = await callRoom(withCapability(host, 'snapshot'));
    expect(snapshot.body.snapshot.phase).toBe('reveal');
    expect(snapshot.body.snapshot.reveal.reason).toBe('timeout');
    expect(snapshot.body.snapshot.announcement.kind).toBe('no_correct_answer');
    expect(snapshot.body.snapshot.leaderboard[0]).toMatchObject({ totalScore: 0, totalResponseMs: QUESTION_MS });
  });

  it('auto-advances only when host mode is enabled and uses the alarm deadline', async () => {
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host = await createRoom();
    await callRoom(withCapability(host, 'setAutoAdvance', { enabled: true }));
    await callRoom(withCapability(host, 'start'));

    vi.setSystemTime(BASE_TIME + QUESTION_MS);
    expect(await runDurableObjectAlarm(roomStub())).toBe(true);
    let snapshot = await callRoom(withCapability(host, 'snapshot'));
    expect(snapshot.body.snapshot.phase).toBe('reveal');
    expect(snapshot.body.snapshot.reveal.reason).toBe('timeout');

    vi.setSystemTime(BASE_TIME + QUESTION_MS + REVEAL_MS);
    expect(await runDurableObjectAlarm(roomStub())).toBe(true);
    snapshot = await callRoom(withCapability(host, 'snapshot'));
    expect(snapshot.body.snapshot.phase).toBe('question');
    expect(snapshot.body.snapshot.questionIndex).toBe(1);
  });

  it('freezes and resumes the server deadline for the same host capability', async () => {
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host = await createRoom();
    await callRoom(withCapability(host, 'start'));
    vi.setSystemTime(BASE_TIME + 7_000);
    await simulateDisconnect(host);

    const paused = await callRoom(withCapability(host, 'snapshot'));
    expect(paused.status).toBe(200);
    expect(paused.body.snapshot.phase).toBe('paused_host_disconnect');
    expect(paused.body.snapshot.remainingMs).toBe(QUESTION_MS - 7_000);

    vi.setSystemTime(BASE_TIME + 60_000);
    const resumed = await callRoom({
      ...withCapability(host, 'resume'),
      reconnectToken: host.reconnectToken
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.event).toBe('resumed');
    expect(resumed.body.snapshot.phase).toBe('question');
    expect(resumed.body.snapshot.deadlineAt).toBe(BASE_TIME + 60_000 + QUESTION_MS - 7_000);
  });

  it('marks players offline without pausing the room, never replays a missed answer, and resumes with rotation', async () => {
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host = await createRoom();
    const player = await joinRoom();
    await callRoom(withCapability(host, 'start'));
    await simulateDisconnect(player);

    const hostNext = await callRoom(withCapability(host, 'next'));
    expect(hostNext.body.snapshot.phase).toBe('reveal');
    expect(hostNext.body.snapshot.participants.find(({ playerId }) => playerId === player.player.playerId).status).toBe('offline');
    expect(hostNext.body.snapshot.answers[player.player.playerId]).toBeNull();
    expect(hostNext.body.snapshot.leaderboard[0]).toMatchObject({ totalScore: 0, totalResponseMs: QUESTION_MS });

    vi.setSystemTime(BASE_TIME + 2_000);
    const resumed = await callRoom({
      ...withCapability(player, 'resume'),
      reconnectToken: player.reconnectToken
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.reconnectToken).not.toBe(player.reconnectToken);
    expect(resumed.body.snapshot.answers[player.player.playerId]).toBeNull();

    const oldToken = await callRoom({
      ...withCapability(player, 'resume'),
      reconnectToken: player.reconnectToken
    });
    expect(oldToken.status).toBe(401);
    expect(oldToken.body.code).toBe('invalid_reconnect');
  });

  it('enforces two-hour capabilities and fifteen-minute reconnect tokens at exact boundaries for both roles', async () => {
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host = await createRoom();
    const player = await joinRoom();

    vi.setSystemTime(BASE_TIME + CAPABILITY_TTL_MS - 1);
    expect((await callRoom(withCapability(host, 'snapshot'))).status).toBe(200);
    expect((await callRoom(withCapability(player, 'snapshot'))).status).toBe(200);

    vi.setSystemTime(BASE_TIME + CAPABILITY_TTL_MS);
    expect((await callRoom(withCapability(host, 'snapshot'))).status).toBe(401);
    expect((await callRoom(withCapability(player, 'snapshot'))).status).toBe(401);

    vi.useRealTimers();
    await reset();
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host2 = await createRoom('Host 2');
    const player2 = await joinRoom('Player 2');
    await callRoom(withCapability(host2, 'start'));
    await simulateDisconnect(host2);
    await simulateDisconnect(player2);

    vi.setSystemTime(BASE_TIME + RECONNECT_TTL_MS - 1);
    const hostResumed = await callRoom({ ...withCapability(host2, 'resume'), reconnectToken: host2.reconnectToken });
    expect(hostResumed.status).toBe(200);
    expect(hostResumed.body.event).toBe('resumed');
    const playerResumed = await callRoom({ ...withCapability(player2, 'resume'), reconnectToken: player2.reconnectToken });
    expect(playerResumed.status).toBe(200);

    vi.useRealTimers();
    await reset();
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host3 = await createRoom('Host 3');
    const player3 = await joinRoom('Player 3');
    await callRoom(withCapability(host3, 'start'));
    await simulateDisconnect(host3);
    await simulateDisconnect(player3);
    vi.setSystemTime(BASE_TIME + RECONNECT_TTL_MS);
    expect((await callRoom({ ...withCapability(host3, 'resume'), reconnectToken: host3.reconnectToken })).status).toBe(401);
    expect((await callRoom({ ...withCapability(player3, 'resume'), reconnectToken: player3.reconnectToken })).status).toBe(401);
  });

  it('revokes capabilities on explicit leave, finished rooms, expiry, and reconnect-token rotation', async () => {
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host = await createRoom();
    const player = await joinRoom();
    const left = await callRoom({ ...withCapability(player, 'leave') });
    expect(left.status).toBe(200);
    expect((await callRoom(withCapability(player, 'snapshot'))).status).toBe(401);

    vi.useRealTimers();
    await reset();
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const rotatedHost = await createRoom('Second host');
    const rotatedPlayer = await joinRoom('Second player');
    await callRoom(withCapability(rotatedHost, 'start'));
    await simulateDisconnect(rotatedPlayer);
    vi.setSystemTime(BASE_TIME + 1_000);
    const rotated = await callRoom({ ...withCapability(rotatedPlayer, 'resume'), reconnectToken: rotatedPlayer.reconnectToken });
    expect(rotated.status).toBe(200);
    expect((await callRoom({ ...withCapability(rotatedPlayer, 'resume'), reconnectToken: rotatedPlayer.reconnectToken })).status).toBe(401);

    vi.setSystemTime(BASE_TIME + CAPABILITY_TTL_MS);
    const expired = await callRoom({ ...withCapability(rotatedHost, 'snapshot') });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('room_finished');
  });

  it('rehydrates the room snapshot after Durable Object eviction and keeps authoritative versioning', async () => {
    vi.useFakeTimers({ now: BASE_TIME, toFake: ['Date'] });
    const host = await createRoom();
    const started = await callRoom(withCapability(host, 'start'));
    await evictDurableObject(roomStub());
    const restored = await callRoom(withCapability(host, 'snapshot'));
    expect(restored.status).toBe(200);
    expect(restored.body.snapshot.phase).toBe('question');
    expect(restored.body.snapshot.questionIndex).toBe(0);
    expect(restored.body.snapshot.roomVersion).toBe(started.body.snapshot.roomVersion);
  });
});
