import { describe, expect, it, vi } from 'vitest';
import publicBank from '../presentation/quiz/questions.json';
import { createQuizController, projectSnapshot, resolveQuestion } from '../presentation/quiz/app.js';

function response(body, ok = true, status = ok ? 200 : 503) {
  return { ok, status, async json() { return body; } };
}

describe('authoritative quiz client projection', () => {
  it('resolves q01-q20 to sanitized prompt and four options', () => {
    for (let index = 0; index < publicBank.questions.length; index += 1) {
      const source = publicBank.questions[index];
      const projected = projectSnapshot({
        phase: 'question',
        questionIndex: index,
        question: { id: source.id, prompt: source.prompt, options: source.options, correctOption: 'A', explanation: 'secret' },
        answers: {}
      }, 'player', publicBank);
      expect(projected.question).toEqual({ id: source.id, prompt: source.prompt, options: source.options });
      expect(projected.question).not.toHaveProperty('correctOption');
      expect(projected.question).not.toHaveProperty('explanation');
      expect(resolveQuestion({ questionIndex: index, question: { id: source.id, options: source.options } }, publicBank).prompt).toBe(source.prompt);
    }
  });

  it('exposes the answer key only in an authoritative reveal projection', () => {
    const projected = projectSnapshot({
      phase: 'reveal',
      questionIndex: 0,
      question: publicBank.questions[0],
      reveal: { correctOption: 'A', explanation: 'Giải thích từ máy chủ.', reason: 'manual' },
      leaderboard: []
    }, 'player', publicBank);
    expect(projected.question).not.toHaveProperty('correctOption');
    expect(projected.reveal).toEqual({ correctOption: 'A', explanation: 'Giải thích từ máy chủ.', reason: 'manual' });
  });

  it('submits one answer through the room command path and ignores a second choice', async () => {
    const commands = [];
    const controller = createQuizController({
      questionBank: publicBank,
      commandTransport: async (command) => { commands.push(command); return null; }
    });
    controller.state.role = 'player';
    controller.state.session = { playerId: 'player-1', roomCode: 'ABC123' };
    controller.state.snapshot = { phase: 'question', questionIndex: 0, question: publicBank.questions[0], answers: {} };
    expect(await controller.submitAnswer('A')).toBe(true);
    expect(await controller.submitAnswer('B')).toBe(false);
    expect(commands).toEqual([{ type: 'answer', option: 'A' }]);
  });

  it('persists the final result without loading a global leaderboard', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push({ url, init });
      return response({ ok: true, event: 'finished' });
    });
    const controller = createQuizController({ fetchImpl });
    controller.state.role = 'host';
    controller.state.session = { playerId: 'player-1', roomCode: 'ABC123', capabilityToken: 'token' };
    controller.state.snapshot = {
      phase: 'finished', roomCode: 'ABC123', finalResults: [], leaderboard: [{ playerId: 'player-1', totalScore: 833 }]
    };
    await controller.persistFinalResult();
    expect(calls[0].url).toBe('/api/score');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ roomCode: 'ABC123', playerId: 'player-1', capabilityToken: 'token', resultId: 'ABC123:player-1' });
    expect(calls).toHaveLength(1);
    expect(controller.state.snapshot.phase).toBe('finished');
  });

  it('keeps the current-room result visible when optional persistence fails', async () => {
    const fetchImpl = vi.fn(async (url) => response({ ok: false, error: 'offline' }, false));
    const controller = createQuizController({ fetchImpl });
    controller.state.role = 'host';
    controller.state.session = { playerId: 'player-1', roomCode: 'ABC123', capabilityToken: 'token' };
    controller.state.snapshot = { phase: 'finished', roomCode: 'ABC123', leaderboard: [{ playerId: 'player-1', totalScore: 500 }] };
    await controller.persistFinalResult();
    expect(controller.state.snapshot.leaderboard[0].totalScore).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not ask a player to finalize a result after the host already persisted it', async () => {
    const fetchImpl = vi.fn(async () => response({ ok: false, error: 'should not be called' }, false, 401));
    const controller = createQuizController({ fetchImpl });
    controller.state.role = 'player';
    controller.state.session = { playerId: 'player-1', roomCode: 'ABC123', capabilityToken: 'token' };
    controller.state.snapshot = { phase: 'finished', roomCode: 'ABC123', leaderboard: [{ playerId: 'player-1', totalScore: 500 }] };

    await controller.persistFinalResult();

    expect(fetchImpl.mock.calls.some(([url]) => String(url).startsWith('/api/score'))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reconciles a missed finished event while the room is showing a reveal', async () => {
    const timers = [];
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/api/quiz/rooms?')) {
        return response({ ok: true, snapshot: {
          roomCode: 'ABC123', roomVersion: 9, phase: 'finished', finalResults: [{ playerId: 'player-1', totalScore: 1000, rank: 1 }], leaderboard: []
        } });
      }
      if (String(url).startsWith('/api/score')) return response({ ok: true, event: 'finished' });
      return response({ ok: true, globalLeaderboard: [] });
    });
    const controller = createQuizController({
      fetchImpl,
      windowRef: {
        location: { protocol: 'https:', host: 'quiz.test' },
        matchMedia: () => ({ matches: false }),
        setTimeout: vi.fn((callback, delay) => { timers.push({ callback, delay }); return timers.length; }),
        clearTimeout: vi.fn()
      }
    });
    controller.state.role = 'player';
    controller.state.session = { roomCode: 'ABC123', playerId: 'player-1', capabilityToken: 'capability' };
    controller.state.snapshot = { roomCode: 'ABC123', roomVersion: 8, phase: 'reveal', leaderboard: [] };

    controller.render();
    expect(timers[0].delay).toBe(800);
    timers[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchImpl.mock.calls[0][0]).toContain('finished=1');
    expect(controller.state.snapshot.phase).toBe('finished');
  });
});
