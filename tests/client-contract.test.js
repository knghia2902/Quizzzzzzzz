import { describe, expect, it } from 'vitest';
import html from '../presentation/quiz/index.html?raw';
import app from '../presentation/quiz/app.js?raw';

describe('semantic quiz client contract', () => {
  it('contains the Vietnamese host/player screens and accessible controls', () => {
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain('name="viewport"');
    for (const hook of ['entry', 'create', 'join']) {
      expect(html).toContain(`data-screen="${hook}"`);
    }
    for (const hook of ['host-lobby', 'player-lobby', 'question-panel', 'reveal-panel', 'paused-panel', 'finished-panel', 'final-top10-list', 'leaderboard']) {
      expect(html).toContain(hook);
    }
    expect(html).not.toContain('class="audio-icon"');
    expect(html).not.toContain('data-action="toggle-audio"');
    expect((html.match(/data-answer="[ABCD]"/g) || []).length).toBe(4);
    expect(html.match(/<button[^>]+data-answer=/g)).toHaveLength(4);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Kết thúc ván chơi? Người chơi sẽ không thể trả lời các câu còn lại.');
    expect(html).not.toMatch(/Kahoot|answer-edit|previous-question/i);
  });

  it('contains the mobile-first visual and safety contract', () => {
    expect(html).toMatch(/<link rel="stylesheet" href="style\.css(?:\?[^\"]+)?">/);
    expect(html).toContain('<link rel="icon" href="/presentation/quiz/favicon.svg"');
    expect(html).toContain('src="app.js?v=question-duration-settings-20260930-1"');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('data-role="timer"');
    expect(html).toContain('data-role="pause-banner"');
  });

  it('keeps the light visual direction and entry composition hooks', () => {
    expect(html).toContain('class="entry-visual"');
    expect(html).toContain('class="entry-stats"');
    expect(html).not.toContain('Âm thanh luôn bật');
  });

  it('keeps client authority and DOM safety visible in the controller source', () => {
    expect(app).toContain('textContent');
    expect(app).not.toContain('innerHTML');
    expect(app).toContain("type: 'answer'");
    expect(app).toContain("type: 'next'");
    expect(app).toContain("type: 'finish'");
    expect(app).toContain("/api/score");
    expect(app).not.toContain("/api/leaderboard?");
    expect(app).toContain('correctOption');
    expect(app).toContain('Còn ${seconds} giây');
    expect(app).toContain('state.warned.has(seconds)');
    expect(app).toContain("a: 'A'");
    expect(app).toContain("'1': 'A'");
  });
});
