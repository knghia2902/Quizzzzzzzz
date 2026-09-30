import { describe, expect, it, vi } from 'vitest';
import {
  QUIZ_SESSION_FIELDS,
  QUIZ_SESSION_STORAGE_KEY,
  QUIZ_RESULT_STORAGE_PREFIX,
  QUIZ_RUNTIME_SESSION_STORAGE_KEY,
  createQuizController,
  readSessionMetadata,
  sessionMetadata
} from '../presentation/quiz/app.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function windowRef(storage = new MemoryStorage(), sessionStorage = new MemoryStorage()) {
  return {
    localStorage: storage,
    sessionStorage,
    location: { protocol: 'https:', host: 'quiz.test' },
    matchMedia: () => ({ matches: false }),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn()
  };
}

function snapshot(overrides = {}) {
  return {
    roomCode: 'ABC123',
    roomVersion: 7,
    phase: 'question',
    questionIndex: 2,
    question: { id: 'q03', prompt: 'Câu hỏi', options: { A: 'A', B: 'B', C: 'C', D: 'D' } },
    answers: {},
    participants: [{ playerId: 'player-1', role: 'player', status: 'online' }],
    leaderboard: [],
    ...overrides
  };
}

describe('metadata-only quiz offline persistence', () => {
  it('sends the original reconnect token, rotates it on acknowledgement, and never retries with the predecessor', () => {
    const storage = new MemoryStorage();
    const timers = [];
    const sockets = [];
    const controller = createQuizController({
      windowRef: {
        ...windowRef(storage),
        setTimeout: vi.fn((callback, delay) => { timers.push({ callback, delay }); return timers.length; })
      },
      webSocketFactory: vi.fn((url) => {
        const listeners = new Map();
        const socket = {
          readyState: 1,
          url,
          addEventListener(name, callback) { listeners.set(name, callback); },
          emit(name, payload) { listeners.get(name)?.(payload); }
        };
        sockets.push(socket);
        return socket;
      })
    });
    controller.state.session = {
      roomCode: 'ABC123', role: 'player', playerId: 'player-1',
      capabilityToken: 'capability-token', reconnectToken: 'old-token'
    };
    controller.state.snapshot = snapshot();
    controller.connectSocket();
    expect(sockets[0].url).toContain('capabilityToken=capability-token');
    expect(sockets[0].url).not.toContain('reconnectToken=');

    sockets[0].emit('open');
    sockets[0].emit('close', { code: 1006 });
    expect(timers[0].delay).toBe(500);
    timers[0].callback();
    expect(sockets[1].url).toContain('reconnectToken=old-token');
    sockets[1].emit('message', { data: JSON.stringify({
      event: 'resumed',
      reconnectToken: 'replacement-token',
      snapshot: snapshot({ roomVersion: 8 })
    }) });
    expect(JSON.parse(storage.getItem(QUIZ_SESSION_STORAGE_KEY)).reconnectToken).toBe('replacement-token');

    sockets[1].emit('close', { code: 1006 });
    timers[1].callback();
    expect(sockets[2].url).toContain('reconnectToken=replacement-token');
    expect(sockets[2].url).not.toContain('reconnectToken=old-token');
  });

  it('clears only a rejected reconnect capability and leaves the session shell available', () => {
    const storage = new MemoryStorage();
    const controller = createQuizController({ windowRef: windowRef(storage) });
    controller.state.session = {
      roomCode: 'ABC123', role: 'player', playerId: 'player-1',
      capabilityToken: 'runtime-only', reconnectToken: 'stale-token'
    };
    controller.persistSession();
    controller.applyMessage({ event: 'error', code: 'invalid_reconnect', error: 'expired' });
    expect(controller.state.session).toMatchObject({ roomCode: 'ABC123', playerId: 'player-1', capabilityToken: 'runtime-only' });
    expect(controller.state.session.reconnectToken).toBeNull();
    expect(JSON.parse(storage.getItem(QUIZ_SESSION_STORAGE_KEY))).not.toHaveProperty('reconnectToken');
    expect(controller.state.transport).toBe('offline');
  });

  it('persists only the approved session shell and cleans it up explicitly', () => {
    const storage = new MemoryStorage();
    const session = {
      roomCode: 'ABC123', role: 'player', playerId: 'player-1', reconnectToken: 'old-token',
      roomVersion: 7, capabilityToken: 'secret-capability', displayName: 'Minh', answer: 'A', score: 999
    };
    const metadata = sessionMetadata(session, true);
    expect(Object.keys(metadata).sort()).toEqual([...QUIZ_SESSION_FIELDS].sort());
    expect(metadata).not.toHaveProperty('capabilityToken');
    expect(metadata).not.toHaveProperty('answer');
    expect(metadata).not.toHaveProperty('score');

    const controller = createQuizController({ windowRef: windowRef(storage) });
    controller.state.session = session;
    controller.state.audioEnabled = true;
    expect(controller.persistSession()).toBe(true);
    expect(JSON.parse(storage.getItem(QUIZ_SESSION_STORAGE_KEY))).toEqual(metadata);
    expect(readSessionMetadata(windowRef(storage))).toEqual(metadata);
    controller.clearPersistedSession();
    expect(storage.getItem(QUIZ_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('preserves the session shell through a failed API attempt and uses capped retry state', async () => {
    const storage = new MemoryStorage();
    const saved = { roomCode: 'ABC123', role: 'player', playerId: 'player-1', reconnectToken: 'old-token', roomVersion: 7 };
    storage.setItem(QUIZ_SESSION_STORAGE_KEY, JSON.stringify(saved));
    const controller = createQuizController({
      windowRef: windowRef(storage),
      fetchImpl: vi.fn(async () => { throw new Error('offline'); }),
      webSocketFactory: vi.fn(() => ({ readyState: 0, addEventListener() {} }))
    });
    controller.state.session = { ...saved, capabilityToken: 'runtime-only' };
    await controller.start();
    expect(controller.state.session).toMatchObject(saved);
    expect(JSON.parse(storage.getItem(QUIZ_SESSION_STORAGE_KEY))).toEqual(saved);
    expect(controller.state.transport).toBe('reconnecting');
    controller.state.reconnectAttempt = 20;
    controller.scheduleReconnect();
    expect(controller.state.reconnectAttempt).toBe(21);
  });

  it('does not open a WebSocket when the restored session has no capability token', () => {
    const storage = new MemoryStorage();
    const webSocketFactory = vi.fn();
    const controller = createQuizController({ windowRef: windowRef(storage), webSocketFactory });
    controller.state.session = { roomCode: 'ABC123', role: 'player', playerId: 'player-1', reconnectToken: 'old-token' };

    controller.connectSocket();

    expect(webSocketFactory).not.toHaveBeenCalled();
    expect(controller.state.transport).toBe('offline');
    expect(controller.state.reconnectRejected).toBe(true);
  });

  it('restores a locally cached finished result after reload without storing credentials', async () => {
    const storage = new MemoryStorage();
    const saved = { roomCode: 'ABC123', role: 'player', playerId: 'player-1', audioEnabled: false };
    storage.setItem(QUIZ_SESSION_STORAGE_KEY, JSON.stringify(saved));
    storage.setItem(`${QUIZ_RESULT_STORAGE_PREFIX}ABC123:player-1`, JSON.stringify({
      snapshot: snapshot({ phase: 'finished', finalResults: [{ playerId: 'player-1', totalScore: 1000, rank: 1 }] })
    }));
    const webSocketFactory = vi.fn();
    const controller = createQuizController({ windowRef: windowRef(storage), webSocketFactory });

    await controller.start();

    expect(controller.state.snapshot.phase).toBe('finished');
    expect(controller.state.connection).toBe('offline');
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it('restores a finished server snapshot from same-tab runtime credentials without opening a socket', async () => {
    const storage = new MemoryStorage();
    const runtimeStorage = new MemoryStorage();
    const saved = { roomCode: 'ABC123', role: 'player', playerId: 'player-1', audioEnabled: false };
    storage.setItem(QUIZ_SESSION_STORAGE_KEY, JSON.stringify(saved));
    runtimeStorage.setItem(QUIZ_RUNTIME_SESSION_STORAGE_KEY, JSON.stringify({
      roomCode: 'ABC123', playerId: 'player-1', role: 'player', capabilityToken: 'runtime-capability'
    }));
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toContain('finished=1');
      return { ok: true, status: 200, async json() { return { ok: true, snapshot: snapshot({ phase: 'finished' }) }; } };
    });
    const webSocketFactory = vi.fn();
    const controller = createQuizController({ windowRef: windowRef(storage, runtimeStorage), fetchImpl, webSocketFactory });

    await controller.start();

    expect(controller.state.snapshot.phase).toBe('finished');
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it('rotates the stored token before the next reconnect and never replays a disconnected answer', async () => {
    const storage = new MemoryStorage();
    const controller = createQuizController({ windowRef: windowRef(storage) });
    controller.state.role = 'player';
    controller.state.transport = 'connected';
    controller.state.socket = { readyState: 1, send() { throw new Error('socket closed'); } };
    controller.state.session = { roomCode: 'ABC123', role: 'player', playerId: 'player-1', capabilityToken: 'runtime-only', reconnectToken: 'old-token' };
    controller.state.snapshot = snapshot();
    controller.persistSession();

    controller.applyMessage({ event: 'resumed', reconnectToken: 'replacement-token', snapshot: snapshot({ roomVersion: 8 }) });
    expect(controller.state.session.reconnectToken).toBe('replacement-token');
    expect(JSON.parse(storage.getItem(QUIZ_SESSION_STORAGE_KEY)).reconnectToken).toBe('replacement-token');
    expect(JSON.parse(storage.getItem(QUIZ_SESSION_STORAGE_KEY)).roomVersion).toBe(8);

    expect(await controller.submitAnswer('A')).toBe(false);
    expect(controller.state.answerPending).toBe(false);
    const persisted = JSON.parse(storage.getItem(QUIZ_SESSION_STORAGE_KEY));
    expect(persisted).not.toHaveProperty('pendingAnswer');
    expect(persisted).not.toHaveProperty('answer');
    expect(controller.state.lastAuthoritativeEvent).toBeNull();
  });

  it('keeps host pause visible while a player disconnect snapshot keeps the question moving', () => {
    const host = createQuizController({ windowRef: windowRef() });
    host.state.role = 'host';
    host.state.transport = 'connected';
    host.state.snapshot = snapshot({ phase: 'paused_host_disconnect', remainingMs: 12000 });
    host.render();
    expect(host.state.connection).toBe('paused');

    const player = createQuizController({ windowRef: windowRef() });
    player.state.role = 'player';
    player.state.transport = 'connected';
    player.state.snapshot = snapshot({ participants: [{ playerId: 'player-1', role: 'player', status: 'offline' }] });
    player.render();
    expect(player.state.snapshot.phase).toBe('question');
    expect(player.state.connection).toBe('connected');
  });
});
