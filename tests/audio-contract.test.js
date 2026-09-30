import { describe, expect, it } from 'vitest';
import { createQuizAudioManager } from '../presentation/quiz/app.js';

class GainNodeDouble {
  constructor() { this.gain = { value: 0 }; this.connections = []; }
  connect(node) { this.connections.push(node); }
}

class AudioContextDouble {
  constructor() { this.destination = {}; this.gains = []; this.resumed = false; }
  createGain() { const node = new GainNodeDouble(); this.gains.push(node); return node; }
  createMediaElementSource(audio) { return { connect: (node) => { audio.bus = node; } }; }
  resume() { this.resumed = true; }
}

class AudioDouble {
  static instances = [];
  constructor(src) { this.src = src; this.played = 0; this.paused = 0; this.currentTime = 0; AudioDouble.instances.push(this); }
  play() { this.played += 1; return Promise.resolve(); }
  pause() { this.paused += 1; }
}

class UtteranceDouble {
  constructor(text) { this.text = text; }
}

function harness(options = {}) {
  const speech = {
    spoken: [],
    cancelled: 0,
    getVoices: () => [{ lang: 'vi-VN', name: 'Vietnamese' }],
    speak(utterance) { this.spoken.push(utterance); },
    cancel() { this.cancelled += 1; }
  };
  const audioContext = new AudioContextDouble();
  const timers = [];
  const manager = createQuizAudioManager({
    windowRef: { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; } },
    audioContext,
    Audio: AudioDouble,
    speechSynthesis: speech,
    SpeechSynthesisUtterance: UtteranceDouble,
    enabled: true,
    audioSettings: options.audioSettings
  });
  return { manager, audioContext, speech, timers };
}

describe('hybrid quiz audio contract', () => {
  it('waits for a user gesture, then starts music and queued SFX', () => {
    AudioDouble.instances = [];
    const { manager, audioContext } = harness();
    expect(manager.playAsset('correct')).toBe(false);
    expect(manager.pendingAssets()).toEqual(['correct']);
    manager.userGesture();
    expect(audioContext.resumed).toBe(true);
    expect(manager.music).not.toBeNull();
    expect(AudioDouble.instances.some((audio) => audio.src.includes('sfx-correct'))).toBe(true);
  });

  it('uses separate gain buses and ducks/restores music around Vietnamese speech', () => {
    const { manager, audioContext, speech } = harness();
    manager.userGesture();
    const [musicGain, sfxGain, voiceGain, masterGain] = audioContext.gains;
    expect([musicGain, sfxGain, voiceGain, masterGain]).toHaveLength(4);
    expect(manager.speak('Người chơi nhanh nhất')).toBe(true);
    expect(musicGain.gain.value).toBeLessThan(0.16);
    speech.spoken[0].onend();
    expect(musicGain.gain.value).toBe(0.16);
    expect(voiceGain.gain.value).toBeGreaterThan(sfxGain.gain.value);
  });

  it('applies saved master, music, SFX, and voice volumes independently', () => {
    AudioDouble.instances = [];
    const { manager, audioContext } = harness({
      audioSettings: {
        master: 62,
        music: 28,
        correct: 70,
        incorrect: 20,
        timeout: 10,
        welcome: 55,
        roomReady: 55,
        finalResults: 55,
        dynamicVoice: 55
      }
    });
    manager.userGesture();
    const [musicGain, sfxGain, voiceGain, masterGain] = audioContext.gains;
    expect(musicGain.gain.value).toBeCloseTo(0.28);
    expect(sfxGain.gain.value).toBeCloseTo(0.70);
    expect(voiceGain.gain.value).toBeCloseTo(0.55);
    expect(masterGain.gain.value).toBeCloseTo(0.62);
    manager.playAsset('incorrect');
    const incorrect = AudioDouble.instances.find((audio) => audio.src.includes('sfx-incorrect'));
    expect(incorrect.volume).toBeCloseTo(20 / 70);
  });

  it('speaks reveal and final top five, but not ordinary question transitions', () => {
    AudioDouble.instances = [];
    const { manager, speech } = harness();
    manager.userGesture();
    manager.handleEvent('question', { questionIndex: 1, announcement: {} });
    expect(speech.spoken).toHaveLength(0);
    manager.handleEvent('reveal', { questionIndex: 1, announcement: { text: 'Người trả lời nhanh nhất là An.' } });
    expect(speech.spoken).toHaveLength(1);
    manager.handleEvent('finished', {
      roomVersion: 20,
      finalResults: [{ displayName: 'An', totalScore: 1000 }, { displayName: 'Bình', totalScore: 800 }],
      announcement: {}
    });
    expect(speech.spoken).toHaveLength(2);
    expect(AudioDouble.instances.some((audio) => audio.src.includes('final-results'))).toBe(true);
    manager.handleEvent('finished', { roomVersion: 20, finalResults: [], announcement: {} });
    expect(speech.spoken).toHaveLength(2);
  });

  it('plays room-ready only for an explicit create/join lifecycle event', () => {
    AudioDouble.instances = [];
    const { manager } = harness();
    manager.userGesture();
    manager.handleEvent('snapshot', { roomCode: 'ABC123', announcement: { kind: 'room_ready' } });
    expect(AudioDouble.instances.some((audio) => audio.src.includes('room-ready'))).toBe(false);
    manager.handleEvent('room_ready', { roomCode: 'ABC123' });
    expect(AudioDouble.instances.some((audio) => audio.src.includes('room-ready'))).toBe(true);
    const count = AudioDouble.instances.filter((audio) => audio.src.includes('room-ready')).length;
    manager.handleEvent('room_ready', { roomCode: 'ABC123' });
    expect(AudioDouble.instances.filter((audio) => audio.src.includes('room-ready')).length).toBe(count);
  });

  it('keeps gameplay usable when speech is unavailable and mute covers every bus', () => {
    const { manager, audioContext } = harness();
    manager.userGesture();
    manager.setEnabled(false);
    expect(audioContext.gains[3].gain.value).toBe(0);
    expect(manager.speak('Không được đọc')).toBe(false);
    expect(manager.playAsset('incorrect')).toBe(false);
  });

});
