import { describe, expect, it } from 'vitest';
import roomReady from '../presentation/quiz/audio/room-ready.mp3?url';
import finalResults from '../presentation/quiz/audio/final-results.mp3?url';
import welcome from '../presentation/quiz/audio/welcome.mp3?url';
import backgroundMusic from '../presentation/quiz/audio/background-music.mp3?url';
import sfxCorrect from '../presentation/quiz/audio/sfx-correct.mp3?url';
import sfxIncorrect from '../presentation/quiz/audio/sfx-incorrect.mp3?url';
import license from '../presentation/quiz/audio/LICENSE.md?raw';

const assets = {
  'room-ready.mp3': roomReady,
  'final-results.mp3': finalResults,
  'welcome.mp3': welcome,
  'background-music.mp3': backgroundMusic,
  'sfx-correct.mp3': sfxCorrect,
  'sfx-incorrect.mp3': sfxIncorrect,
};

describe('quiz audio asset contract', () => {
  it('ships every non-empty fixed cue, music track, and SFX', () => {
    for (const [name, url] of Object.entries(assets)) {
      expect(url, name).toBeTruthy();
      expect(url, name).toMatch(/\.mp3/);
    }
  });

  it('keeps source/license attribution for every shipped asset', () => {
    for (const asset of Object.keys(assets)) expect(license).toContain(asset);
    expect(license).toContain('edge-tts');
    expect(license).toContain('replaced/re-reviewed');
  });
});
