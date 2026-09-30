import { describe, expect, it } from 'vitest';
import publicBank from '../presentation/quiz/questions.json';
import { questions as trustedQuestions } from '../presentation/workers/questions.js';

const expectedPrompts = [
  'Phủ định siêu hình là gì?',
  'Phủ định biện chứng khác phủ định siêu hình ở điểm nào?',
  'Tính khách quan của phủ định biện chứng là gì?',
  'Tính kế thừa của phủ định biện chứng thể hiện thế nào?',
  'Ví dụ khoa học nào thể hiện phủ định biện chứng?',
  'Trong văn hóa, chữ Quốc ngữ phủ định chữ Nôm theo cách nào?',
  'Phủ định biện chứng có tính phổ biến nghĩa là gì?',
  'Quy luật phủ định của phủ định chỉ ra khuynh hướng phát triển như thế nào?',
  'Một chu kỳ phủ định của phủ định cần ít nhất bao nhiêu lần phủ định?',
  'Ví dụ tự nhiên nào minh họa phủ định của phủ định?',
  'Ví dụ xã hội nào minh họa phủ định của phủ định?',
  'Ví dụ trong công nghệ thể hiện phủ định của phủ định?',
  'Quá trình học tập có phải là phủ định của phủ định không?',
  'Đường xoáy ốc trong phủ định của phủ định có ý nghĩa gì?',
  'Theo Lênin, sự phát triển diễn ra theo hình thức nào?',
  'Ý nghĩa lớn nhất của quy luật phủ định của phủ định là gì?',
  'Quy luật này giúp ta nhận thức thế nào về sự phát triển?',
  'Trong học tập, phủ định của phủ định được vận dụng như thế nào?',
  'Trong đổi mới xã hội, cần kế thừa những yếu tố nào của cái cũ?',
  'Tại sao không thể phủ định sạch trơn quá khứ?'
];

const expectedAnswerKey = {
  q01: 'A', q02: 'B', q03: 'B', q04: 'C', q05: 'B',
  q06: 'B', q07: 'C', q08: 'B', q09: 'B', q10: 'B',
  q11: 'A', q12: 'A', q13: 'A', q14: 'A', q15: 'C',
  q16: 'B', q17: 'B', q18: 'B', q19: 'B', q20: 'A'
};

const expectedIds = Object.keys(expectedAnswerKey);

describe('DOCX-derived question contract', () => {
  it('contains the 20 prompts in their source order', () => {
    expect(publicBank.questions.map(({ id }) => id)).toEqual(expectedIds);
    expect(publicBank.questions.map(({ prompt }) => prompt)).toEqual(expectedPrompts);
    expect(trustedQuestions.map(({ id }) => id)).toEqual(expectedIds);
  });

  it('keeps four complete Vietnamese options in public and trusted data', () => {
    for (const question of publicBank.questions) {
      expect(Object.keys(question.options).sort()).toEqual(['A', 'B', 'C', 'D']);
      expect(question.prompt).toMatch(/[À-ỹ]/u);
      for (const option of Object.values(question.options)) {
        expect(option.trim()).not.toBe('');
      }
    }

    for (const question of trustedQuestions) {
      expect(Object.keys(question.options).sort()).toEqual(['A', 'B', 'C', 'D']);
      expect(question.explanation.trim()).not.toBe('');
      expect(question.explanation).toMatch(/[À-ỹ]/u);
      expect(question.correctOption).toMatch(/^[ABCD]$/);
    }
  });

  it('keeps the answer key authoritative and out of the public asset', () => {
    expect(Object.fromEntries(trustedQuestions.map(({ id, correctOption }) => [id, correctOption])))
      .toEqual(expectedAnswerKey);

    for (const question of publicBank.questions) {
      expect(question).not.toHaveProperty('correctOption');
    }
  });

  it('keeps public and trusted question IDs and options in parity', () => {
    expect(trustedQuestions.map(({ id }) => id)).toEqual(publicBank.questions.map(({ id }) => id));
    expect(trustedQuestions.map(({ id, prompt, options }) => ({ id, prompt, options })))
      .toEqual(publicBank.questions);
  });
});
