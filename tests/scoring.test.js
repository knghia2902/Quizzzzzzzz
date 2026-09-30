import { describe, expect, it } from 'vitest';
import {
  QUESTION_MS,
  calculateScore,
  compareLeaderboard
} from '../presentation/workers/scoring.js';

const QUESTION_STARTED_AT = 1_700_000_000_000;
const DEADLINE_AT = QUESTION_STARTED_AT + QUESTION_MS;

describe('server-authoritative quiz scoring', () => {
  it('uses the D-06 question window and awards 1,000 at zero elapsed time', () => {
    expect(QUESTION_MS).toBe(30_000);
    expect(calculateScore({
      isCorrect: true,
      questionStartedAt: QUESTION_STARTED_AT,
      deadlineAt: DEADLINE_AT,
      receivedAt: QUESTION_STARTED_AT
    })).toEqual({ score: 1_000, responseTimeMs: 0 });
  });

  it.each([
    ['midpoint', QUESTION_STARTED_AT + 15_000, 500],
    ['deadline', DEADLINE_AT, 0]
  ])('applies linear decay at the %s boundary', (_label, receivedAt, score) => {
    expect(calculateScore({
      isCorrect: true,
      questionStartedAt: QUESTION_STARTED_AT,
      deadlineAt: DEADLINE_AT,
      receivedAt
    })).toEqual({ score, responseTimeMs: receivedAt - QUESTION_STARTED_AT });
  });

  it('uses the room-specific question duration for scoring', () => {
    const durationMs = 45_000;
    expect(calculateScore({
      isCorrect: true,
      questionStartedAt: QUESTION_STARTED_AT,
      deadlineAt: QUESTION_STARTED_AT + durationMs,
      receivedAt: QUESTION_STARTED_AT + 15_000,
      questionDurationMs: durationMs
    })).toEqual({ score: 666, responseTimeMs: 15_000 });
  });

  it.each([
    ['incorrect', { isCorrect: false, receivedAt: QUESTION_STARTED_AT }],
    ['unanswered', { isCorrect: false, receivedAt: null }],
    ['late', { isCorrect: true, receivedAt: DEADLINE_AT + 1 }]
  ])('scores %s answers at zero regardless of client values', (_label, answer) => {
    expect(calculateScore({
      ...answer,
      questionStartedAt: QUESTION_STARTED_AT,
      deadlineAt: DEADLINE_AT,
      score: 1_000,
      elapsedMs: 0,
      clientReceivedAt: QUESTION_STARTED_AT
    }).score).toBe(0);
  });

  it('clamps trusted response time to the server window and ignores forged timing', () => {
    expect(calculateScore({
      isCorrect: true,
      questionStartedAt: QUESTION_STARTED_AT,
      deadlineAt: DEADLINE_AT,
      receivedAt: DEADLINE_AT + 10_000,
      score: 1_000,
      elapsedMs: 0,
      clientReceivedAt: QUESTION_STARTED_AT
    })).toEqual({ score: 0, responseTimeMs: QUESTION_MS });

    expect(calculateScore({
      isCorrect: false,
      questionStartedAt: QUESTION_STARTED_AT,
      deadlineAt: DEADLINE_AT,
      receivedAt: null,
      score: 1_000,
      elapsedMs: 0
    })).toEqual({ score: 0, responseTimeMs: QUESTION_MS });
  });

  it('orders leaderboards by score, response time, then stable player sequence', () => {
    const players = [
      { playerSequence: 3, totalScore: 1_000, totalResponseMs: 500 },
      { playerSequence: 2, totalScore: 500, totalResponseMs: 1 },
      { playerSequence: 1, totalScore: 1_000, totalResponseMs: 500 },
      { playerSequence: 4, totalScore: 1_000, totalResponseMs: 900 }
    ];

    expect(players.sort(compareLeaderboard)).toEqual([
      { playerSequence: 1, totalScore: 1_000, totalResponseMs: 500 },
      { playerSequence: 3, totalScore: 1_000, totalResponseMs: 500 },
      { playerSequence: 4, totalScore: 1_000, totalResponseMs: 900 },
      { playerSequence: 2, totalScore: 500, totalResponseMs: 1 }
    ]);
  });
});
