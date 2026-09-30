export const QUESTION_MS = 30_000;
const MAX_SCORE = 1_000;

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeQuestionDurationMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : QUESTION_MS;
}

function clampResponseTime(questionStartedAt, receivedAt, questionDurationMs) {
  if (!isFiniteTimestamp(questionStartedAt) || !isFiniteTimestamp(receivedAt)) {
    return questionDurationMs;
  }

  return Math.min(
    questionDurationMs,
    Math.max(0, receivedAt - questionStartedAt)
  );
}

/**
 * Calculate one answer result from server-owned timing and correctness.
 * Caller-provided score, elapsed, and client timestamp fields are ignored.
 */
export function calculateScore({
  isCorrect,
  questionStartedAt,
  deadlineAt,
  receivedAt,
  questionDurationMs = QUESTION_MS
} = {}) {
  questionDurationMs = normalizeQuestionDurationMs(questionDurationMs);
  const responseTimeMs = receivedAt === null || receivedAt === undefined
    ? questionDurationMs
    : clampResponseTime(questionStartedAt, receivedAt, questionDurationMs);

  if (
    isCorrect !== true ||
    !isFiniteTimestamp(questionStartedAt) ||
    !isFiniteTimestamp(deadlineAt) ||
    receivedAt === null ||
    receivedAt === undefined ||
    !isFiniteTimestamp(receivedAt)
  ) {
    return { score: 0, responseTimeMs };
  }

  const serverDeadlineAt = Math.min(
    deadlineAt,
    questionStartedAt + questionDurationMs
  );

  if (receivedAt > serverDeadlineAt) {
    return { score: 0, responseTimeMs };
  }

  const score = Math.floor(
    MAX_SCORE * (questionDurationMs - responseTimeMs) / questionDurationMs
  );

  return {
    score: Math.max(0, Math.min(MAX_SCORE, score)),
    responseTimeMs
  };
}

/**
 * Sort leaderboard rows by score descending, response time ascending, then
 * the server-assigned player sequence ascending.
 */
export function compareLeaderboard(left, right) {
  const scoreDifference = (right?.totalScore ?? 0) - (left?.totalScore ?? 0);
  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const responseDifference =
    (left?.totalResponseMs ?? QUESTION_MS) -
    (right?.totalResponseMs ?? QUESTION_MS);
  if (responseDifference !== 0) {
    return responseDifference;
  }

  return (left?.playerSequence ?? Number.MAX_SAFE_INTEGER) -
    (right?.playerSequence ?? Number.MAX_SAFE_INTEGER);
}
