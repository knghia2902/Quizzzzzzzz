import { describe, expect, it } from 'vitest';
import { createQuizController } from '../presentation/quiz/app.js';

class ClassListDouble extends Set {
  remove(value) { this.delete(value); }
}

class NodeDouble {
  constructor() {
    this.dataset = {};
    this.classList = new ClassListDouble();
    this.style = {};
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.attributes = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  focus() {}
  addEventListener() {}
  removeAttribute(name) { this.attributes.delete(name); }
}

class QuizRoot {
  constructor() {
    this.roles = new Map([
      ['quiz-shell', new NodeDouble()],
      ['status-band', new NodeDouble()],
      ['connection-status', new NodeDouble()],
      ['question-panel', new NodeDouble()],
      ['reveal-panel', new NodeDouble()],
      ['question-heading', new NodeDouble()],
      ['question-progress', new NodeDouble()],
      ['question-heading', new NodeDouble()],
      ['timer', new NodeDouble()],
      ['timer-value', new NodeDouble()],
      ['timer-progress', new NodeDouble()],
      ['answer-status', new NodeDouble()],
      ['announcement', new NodeDouble()],
      ['announcement-footer', new NodeDouble()],
      ['correct-answer', new NodeDouble()],
      ['explanation', new NodeDouble()],
      ['result-message', new NodeDouble()],
      ['finished-panel', new NodeDouble()],
      ['final-score', new NodeDouble()],
      ['final-rank', new NodeDouble()],
      ['final-announcement', new NodeDouble()],
      ['leaderboard-list', new NodeDouble()],
      ['room-leaderboard-empty', new NodeDouble()],
      ['leaderboard-count', new NodeDouble()],
      ['global-leaderboard', new NodeDouble()],
      ['host-lobby', new NodeDouble()],
      ['player-lobby', new NodeDouble()],
      ['host-rail', new NodeDouble()],
      ['paused-panel', new NodeDouble()],
      ['global-leaderboard-list', new NodeDouble()],
      ['global-leaderboard-empty', new NodeDouble()],
      ['global-leaderboard-error', new NodeDouble()],
      ['global-save-state', new NodeDouble()],
      ['save-state', new NodeDouble()],
      ['room-code', new NodeDouble()],
      ['player-name', new NodeDouble()],
      ['room-code', new NodeDouble()],
      ['role-badge', new NodeDouble()]
    ]);
    this.answers = ['A', 'B', 'C', 'D'].map((answer) => {
      const node = new NodeDouble();
      node.dataset.answer = answer;
      return node;
    });
  }
  querySelector(selector) {
    const role = selector.match(/^\[data-role="([^"]+)"\]$/)?.[1];
    if (role) return this.roles.get(role) || null;
    const answer = selector.match(/^\[data-answer="([ABCD])"\]$/)?.[1];
    return answer ? this.answers.find((node) => node.dataset.answer === answer) || null : null;
  }
  querySelectorAll(selector) {
    if (selector === '[data-answer]') return this.answers;
    if (selector === '[data-screen]') return [];
    if (selector.startsWith('[data-action=')) return [];
    return [];
  }
  addEventListener() {}
}

function snapshot(overrides = {}) {
  return {
    roomCode: 'ABC123', roomVersion: 4, phase: 'question', questionIndex: 0,
    question: { id: 'q01', prompt: 'Câu hỏi', options: { A: 'A', B: 'B', C: 'C', D: 'D' } },
    answers: {}, participants: [{ playerId: 'player-1', role: 'player', status: 'online' }],
    leaderboard: [{ playerId: 'player-1', displayName: 'Minh', totalScore: 0, rank: 1 }],
    ...overrides
  };
}

function controllerWithHooks(options = {}) {
  const root = new QuizRoot();
  const effects = [];
  const audio = [];
  const controller = createQuizController({
    root,
    windowRef: { matchMedia: () => ({ matches: false }), setTimeout: () => 1 },
    fetchImpl: async () => ({ ok: false, status: 503, async json() { return { ok: false, error: 'offline' }; } }),
    effectHook: (name, detail) => effects.push({ name, detail }),
    audioHook: (name) => audio.push(name),
    audioEnabled: true,
    ...options
  });
  controller.state.role = 'player';
  controller.state.transport = 'connected';
  controller.state.session = { playerId: 'player-1', roomCode: 'ABC123', role: 'player' };
  controller.state.lastQuestionId = 'q01';
  controller.state.selectedOption = 'A';
  return { controller, root, effects, audio };
}

describe('authoritative client result events', () => {
  it('uses the room duration from settings for the timer and progress bar', () => {
    const { controller, root } = controllerWithHooks();
    controller.applyMessage({
      event: 'question',
      snapshot: snapshot({ questionDurationSec: 15, remainingMs: 15_000 })
    });

    expect(controller.state.questionDurationSec).toBe(15);
    expect(root.roles.get('timer-value').textContent).toBe('15');
    expect(root.roles.get('timer-progress').style.transform).toBe('scaleX(1)');
  });

  it('does not show a result before acknowledgement, then maps correct to state/effects', () => {
    const { controller, root, effects, audio } = controllerWithHooks();
    controller.state.snapshot = snapshot();
    controller.applyMessage({ event: 'correct', result: { accepted: false, score: 999999 }, snapshot: snapshot() });
    expect(effects).toHaveLength(0);
    expect(controller.state.lastAuthoritativeEvent).toBeNull();

    controller.applyMessage({
      event: 'correct',
      result: { accepted: true, score: 999999, responseTimeMs: 0 },
      snapshot: snapshot({ answers: { 'player-1': { accepted: true } }, leaderboard: [{ playerId: 'player-1', totalScore: 250, rank: 1 }] })
    });
    expect(root.roles.get('quiz-shell').classList.has('is-success')).toBe(true);
    expect(root.answers.find((node) => node.dataset.answer === 'A').dataset.state).toBe('correct');
    expect(effects.map(({ name }) => name)).toEqual(['confetti']);
    expect(audio).toEqual(['correct']);
    expect(root.roles.get('connection-status').textContent).toContain('đúng');
  });

  it('keeps incorrect and timeout visually distinct and never renders client score', () => {
    const incorrect = controllerWithHooks();
    incorrect.controller.state.snapshot = snapshot();
    incorrect.controller.applyMessage({
      event: 'incorrect', result: { accepted: true, score: 999999, responseTimeMs: 0 },
      snapshot: snapshot({ answers: { 'player-1': { accepted: true } }, leaderboard: [{ playerId: 'player-1', totalScore: 0, rank: 1 }] })
    });
    expect(incorrect.root.roles.get('quiz-shell').classList.has('is-error')).toBe(true);
    expect(incorrect.root.answers.find((node) => node.dataset.answer === 'A').dataset.state).toBe('incorrect');
    expect(incorrect.audio).toEqual(['incorrect']);

    const timeout = controllerWithHooks();
    timeout.controller.state.snapshot = snapshot();
    timeout.controller.applyMessage({
      event: 'timeout', result: { accepted: true, score: 999999, elapsedMs: 0 },
      snapshot: snapshot({ phase: 'reveal', reveal: { correctOption: 'B', reason: 'timeout', explanation: 'Giải thích' }, leaderboard: [{ playerId: 'player-1', totalScore: 0, rank: 1 }] })
    });
    expect(timeout.root.roles.get('quiz-shell').classList.has('is-timeout')).toBe(true);
    expect(timeout.root.roles.get('result-message').textContent).toContain('Hết giờ');
    expect(timeout.audio).toEqual(['timeout']);
    expect(timeout.root.roles.get('final-score').textContent).not.toContain('999999');
  });

  it('colors only the submitted option after an authoritative result', () => {
    const { controller, root } = controllerWithHooks();
    controller.state.snapshot = snapshot();
    controller.state.selectedOption = 'A';
    controller.applyMessage({
      event: 'correct',
      result: { accepted: true, score: 1000, responseTimeMs: 100 },
      snapshot: snapshot({ answers: { 'player-1': { accepted: true } } })
    });
    expect(root.answers.find((node) => node.dataset.answer === 'A').dataset.state).toBe('correct');
    expect(root.answers.filter((node) => node.dataset.answer !== 'A').every((node) => !node.dataset.state)).toBe(true);
  });

  it('colors the selected wrong option red and the server key green immediately', () => {
    const { controller, root } = controllerWithHooks();
    controller.state.snapshot = snapshot();
    controller.state.selectedOption = 'B';
    controller.applyMessage({
      event: 'incorrect',
      result: { accepted: true, score: 0, responseTimeMs: 100, correctOption: 'A' },
      snapshot: snapshot({ answers: { 'player-1': { accepted: true } } })
    });
    expect(root.answers.find((node) => node.dataset.answer === 'B').dataset.state).toBe('incorrect');
    expect(root.answers.find((node) => node.dataset.answer === 'A').dataset.state).toBe('correct');
    expect(root.answers.filter((node) => ['C', 'D'].includes(node.dataset.answer)).every((node) => !node.dataset.state)).toBe(true);
  });

  it('handles reveal and finished hooks while reduced motion keeps state text deterministic', () => {
    const { controller, root, effects, audio } = controllerWithHooks({ reducedMotion: true });
    controller.state.snapshot = snapshot();
    controller.applyMessage({ event: 'reveal', snapshot: snapshot({ phase: 'reveal', reveal: { correctOption: 'C', reason: 'manual', explanation: 'Giải thích' } }) });
    expect(root.roles.get('quiz-shell').classList.has('is-reveal')).toBe(true);
    expect(audio).toEqual(['reveal']);

    controller.applyMessage({ event: 'finished', snapshot: snapshot({ phase: 'finished', finalResults: [{ playerId: 'player-1', totalScore: 300, rank: 1 }], leaderboard: [{ playerId: 'player-1', totalScore: 300, rank: 1 }], announcement: { text: 'Đã xong' } }) });
    expect(root.roles.get('quiz-shell').classList.has('is-finished')).toBe(true);
    expect(root.roles.get('final-score').textContent).toBe('300');
    expect(audio).toEqual(['reveal', 'finished']);
    expect(effects.every(({ detail }) => detail.reducedMotion)).toBe(true);
  });

  it('does not let a stale reveal overwrite a newer finished snapshot', () => {
    const { controller, root } = controllerWithHooks();
    controller.state.snapshot = snapshot({ phase: 'finished', roomVersion: 12, finalResults: [{ playerId: 'player-1', totalScore: 300, rank: 1 }] });
    controller.render();
    controller.applyMessage({ event: 'reveal', snapshot: snapshot({ phase: 'reveal', roomVersion: 11, reveal: { correctOption: 'A', explanation: 'Cũ' } }) });
    expect(controller.state.snapshot.phase).toBe('finished');
    expect(root.roles.get('finished-panel').hidden).toBe(false);
    expect(root.roles.get('reveal-panel').hidden).toBe(true);
  });
});
