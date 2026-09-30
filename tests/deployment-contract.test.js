import { describe, expect, it } from 'vitest';
import rootWrangler from '../wrangler.toml?raw';
import workerWrangler from '../presentation/workers/wrangler.toml?raw';
import workerApi from '../presentation/workers/api.js?raw';
import readme from '../README.md?raw';
import packageJson from '../package.json?raw';

describe('Quiz deployment contract', () => {
  it('keeps the local SQLite Durable Object and Pages proxy binding', () => {
    expect(rootWrangler).not.toContain('binding = "DB"');
    expect(rootWrangler).toContain('name = "QUIZ_ROOM"');
    expect(rootWrangler).toContain('class_name = "QuizRoom"');
    expect(rootWrangler).toContain('script_name = "quiz-room-worker"');
    expect(workerWrangler).toContain('main = "api.js"');
    expect(workerWrangler).toContain('storage = "sqlite"');
    expect(workerApi).toContain('export { QuizRoom }');
  });

  it('documents local SQLite, API, audio, and public quiz boundaries', () => {
    for (const marker of ['presentation/quiz/', 'wrangler', 'storage = "sqlite"', '/api/score', '/api/leaderboard', 'quiz.natime.vn', 'LICENSE.md']) {
      expect(readme).toContain(marker);
    }
    expect(JSON.parse(packageJson).scripts.test).toContain('vitest run');
  });
});
