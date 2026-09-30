const RESERVED_QUESTION_SET_ID = 'default';
export const QUESTION_SET_COUNT = 20;
const SET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const QUESTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const ANSWERS = ['A', 'B', 'C', 'D'];

export class QuestionSetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuestionSetError';
  }
}

function text(value, field, maxLength) {
  const result = String(value ?? '').trim();
  if (!result || result.length > maxLength) {
    throw new QuestionSetError(`${field} không được để trống và tối đa ${maxLength} ký tự.`);
  }
  return result;
}

export function normalizeQuestionSet(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new QuestionSetError('Bộ câu hỏi không hợp lệ.');
  }
  const id = String(input.id || '').trim().toLowerCase();
  if (!SET_ID_PATTERN.test(id) || id === RESERVED_QUESTION_SET_ID) {
    throw new QuestionSetError('ID bộ câu hỏi không hợp lệ.');
  }
  const name = text(input.name, 'Tên bộ câu hỏi', 80);
  if (!Array.isArray(input.questions) || input.questions.length !== QUESTION_SET_COUNT) {
    throw new QuestionSetError(`Bộ câu hỏi phải có đúng ${QUESTION_SET_COUNT} câu.`);
  }
  const seenIds = new Set();
  const normalizedQuestions = input.questions.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new QuestionSetError(`Câu ${index + 1} không hợp lệ.`);
    }
    const questionId = String(item.id || `q${String(index + 1).padStart(2, '0')}`).trim();
    if (!QUESTION_ID_PATTERN.test(questionId) || seenIds.has(questionId)) {
      throw new QuestionSetError(`ID câu hỏi ở vị trí ${index + 1} không hợp lệ hoặc bị trùng.`);
    }
    seenIds.add(questionId);
    const options = {};
    for (const answer of ANSWERS) options[answer] = text(item.options?.[answer], `Đáp án ${answer} của câu ${index + 1}`, 300);
    const correctOption = String(item.correctOption || '').trim().toUpperCase();
    if (!ANSWERS.includes(correctOption)) throw new QuestionSetError(`Đáp án đúng của câu ${index + 1} phải là A, B, C hoặc D.`);
    return {
      id: questionId,
      prompt: text(item.prompt, `Nội dung câu ${index + 1}`, 500),
      options,
      correctOption,
      explanation: text(item.explanation, `Giải thích câu ${index + 1}`, 1000)
    };
  });
  return { id, name, questions: normalizedQuestions };
}

export function normalizeQuestionSets(value) {
  const sets = [];
  const seen = new Set();
  if (!Array.isArray(value)) return sets;
  for (const item of value) {
    if (String(item?.id || '').trim().toLowerCase() === RESERVED_QUESTION_SET_ID) continue;
    const normalized = normalizeQuestionSet(item);
    if (seen.has(normalized.id)) throw new QuestionSetError(`ID bộ câu hỏi bị trùng: ${normalized.id}.`);
    seen.add(normalized.id);
    sets.push(normalized);
  }
  return sets;
}

export function normalizeQuestionSettings(stored = {}) {
  const questionSets = normalizeQuestionSets(stored.questionSets);
  const requestedId = String(stored.activeQuestionSetId || '').trim().toLowerCase();
  const activeQuestionSetId = questionSets.some((item) => item.id === requestedId)
    ? requestedId
    : questionSets[0]?.id || null;
  return { questionSets, activeQuestionSetId };
}
