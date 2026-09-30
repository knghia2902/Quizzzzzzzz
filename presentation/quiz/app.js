const ANSWERS = ['A', 'B', 'C', 'D'];
const QUESTION_COUNT = 20;
export const DEFAULT_QUESTION_DURATION_SEC = 30;
const MIN_QUESTION_DURATION_SEC = 5;
const MAX_QUESTION_DURATION_SEC = 300;
export const QUIZ_SESSION_STORAGE_KEY = 'quiz_room_session';
export const QUIZ_RESULT_STORAGE_PREFIX = 'quiz_room_result:';
export const QUIZ_HISTORY_STORAGE_KEY = 'quiz_room_history';
export const QUIZ_RUNTIME_SESSION_STORAGE_KEY = 'quiz_room_runtime_session';
export const QUIZ_WELCOME_STORAGE_KEY = 'quiz_welcome_voice_played_v1';
export const QUIZ_SESSION_FIELDS = Object.freeze([
  'roomCode',
  'role',
  'playerId',
  'reconnectToken',
  'roomVersion',
  'audioEnabled'
]);
const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
const EFFECT_DURATION_MS = Object.freeze({ confetti: 700, shake: 400 });

export const QUIZ_AUDIO_ASSETS = Object.freeze({
  roomReady: '/presentation/quiz/audio/room-ready.mp3',
  finalResults: '/presentation/quiz/audio/final-results.mp3',
  welcome: '/presentation/quiz/audio/welcome.mp3',
  backgroundMusic: '/presentation/quiz/audio/background-music.mp3',
  correct: '/presentation/quiz/audio/sfx-correct.mp3',
  incorrect: '/presentation/quiz/audio/sfx-incorrect.mp3'
});

export const QUIZ_AUDIO_VOLUME_DEFAULTS = Object.freeze({
  master: 100,
  music: 16,
  welcome: 80,
  roomReady: 80,
  finalResults: 80,
  dynamicVoice: 80,
  correct: 45,
  incorrect: 45
});
const QUIZ_AUDIO_GAIN = Object.freeze({ music: 0.16, sfx: 0.45, voice: 0.8, master: 1, duckedMusic: 0.05 });
const FINISHED_SYNC_DELAY_MS = 800;

function normalizeQuestionDurationSec(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_QUESTION_DURATION_SEC;
  return Math.min(MAX_QUESTION_DURATION_SEC, Math.max(MIN_QUESTION_DURATION_SEC, Math.round(seconds)));
}

function normalizeAudioVolumes(values = {}) {
  return Object.fromEntries(Object.entries(QUIZ_AUDIO_VOLUME_DEFAULTS).map(([key, fallback]) => {
    const value = Number(values?.[key]);
    return [key, Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback];
  }));
}

function isVietnameseVoice(voice) {
  return /^vi(?:-|_)?vn$/i.test(String(voice?.lang || '').replace('_', '-'));
}

export function topFiveAnnouncement(rows = []) {
  const topTen = rows.filter((row) => row?.displayName).slice(0, 10);
  if (!topTen.length) return 'Chưa có bảng xếp hạng chung cuộc.';
  return topTen.map((row) => `${row.displayName}, ${Number(row.totalScore || 0).toLocaleString('vi-VN')} điểm`).join('; ');
}

export const topTenAnnouncement = topFiveAnnouncement;

/**
 * Browser-only media manager. It deliberately degrades to visible text when a
 * device blocks autoplay, has no Web Audio API, or has no Vietnamese voice.
 */
export function createQuizAudioManager(options = {}) {
  const windowRef = options.windowRef || globalThis;
  const AudioContextCtor = options.AudioContext || windowRef.AudioContext || windowRef.webkitAudioContext;
  const AudioCtor = options.Audio || windowRef.Audio;
  const documentRef = options.documentRef || windowRef.document;
  const speech = options.speechSynthesis || windowRef.speechSynthesis;
  const UtteranceCtor = options.SpeechSynthesisUtterance || windowRef.SpeechSynthesisUtterance;
  let context = options.audioContext || null;
  let graph = null;
  let music = null;
  let enabled = options.enabled !== false;
  let hasUserGesture = false;
  let activeSpeech = null;
  let pendingAssets = [];
  let finalResultsPlaying = false;
  let pendingFinalVoice = null;
  let audioVolumes = normalizeAudioVolumes(options.audioSettings);
  let musicBaseGain = audioVolumes.music / 100;
  const useWebAudio = options.useWebAudio !== false;
  const handled = new Set();

  function assetBus(name) {
    return ['correct', 'incorrect'].includes(name) ? 'sfxGain' : 'voiceGain';
  }

  function busPeak(name) {
    const keys = name === 'sfxGain'
      ? ['correct', 'incorrect']
      : ['welcome', 'roomReady', 'finalResults', 'dynamicVoice'];
    return Math.max(1, ...keys.map((key) => Number(audioVolumes[key] || 0))) / 100;
  }

  function assetElementVolume(name, bus) {
    if (name === 'music') return useWebAudio ? 1 : Number(audioVolumes.music || 0) / 100;
    const value = Number(audioVolumes[name] || 0) / 100;
    return useWebAudio ? value / busPeak(bus) : value;
  }

  function ensureGraph() {
    if (graph) return graph;
    if (!context && typeof AudioContextCtor === 'function') {
      try { context = new AudioContextCtor(); } catch { return null; }
    }
    if (!context?.createGain || !context.destination) return null;
    try {
      const musicGain = context.createGain();
      const sfxGain = context.createGain();
      const voiceGain = context.createGain();
      const masterGain = context.createGain();
      musicGain.gain.value = musicBaseGain;
      sfxGain.gain.value = busPeak('sfxGain');
      voiceGain.gain.value = busPeak('voiceGain');
      masterGain.gain.value = enabled ? audioVolumes.master / 100 : 0;
      musicGain.connect(masterGain);
      sfxGain.connect(masterGain);
      voiceGain.connect(masterGain);
      masterGain.connect(context.destination);
      graph = { musicGain, sfxGain, voiceGain, masterGain };
      return graph;
    } catch { return null; }
  }

  function connectMedia(audio, bus) {
    const currentGraph = ensureGraph();
    if (!currentGraph || !audio || !context?.createMediaElementSource) return null;
    try {
      const source = context.createMediaElementSource(audio);
      source.connect(currentGraph[bus]);
      return source;
    } catch { return null; }
  }

  function makeAudio(asset, bus, loop = false, volumeName = null) {
    try {
      let audio = null;
      if (typeof AudioCtor === 'function') {
        try { audio = new AudioCtor(asset); } catch { /* fall through to DOM audio */ }
      }
      if (!audio) audio = documentRef?.createElement?.('audio');
      if (!audio) {
        try { windowRef.console?.warn?.('[quiz-audio] Không tạo được audio element', { hasAudioCtor: typeof AudioCtor === 'function', hasDocumentAudio: Boolean(documentRef?.createElement) }); } catch { /* diagnostics are optional */ }
        return null;
      }
      audio.preload = 'auto';
      audio.setAttribute?.('playsinline', '');
      audio.setAttribute?.('aria-hidden', 'true');
      if (audio.dataset) audio.dataset.quizAudio = bus;
      audio.loop = loop;
      audio.src = asset;
      try {
        audio.defaultPlaybackRate = 1;
        audio.playbackRate = 1;
      } catch { /* media doubles may omit playback rate */ }
      if (documentRef?.body?.appendChild && !audio.parentNode) documentRef.body.appendChild(audio);
      try { audio.volume = assetElementVolume(volumeName, bus); } catch { /* media doubles may omit volume */ }
      if (useWebAudio) connectMedia(audio, bus);
      return audio;
    } catch { return null; }
  }

  function playElement(audio, { onStarted, onRejected } = {}) {
    if (!audio?.play) return false;
    try {
      const result = audio.play();
      if (result?.then) result.then(() => onStarted?.()).catch((error) => {
        onRejected?.(error);
        try { windowRef.console?.warn?.('[quiz-audio] play() bị từ chối', error?.name || 'unknown', audio.src); } catch { /* diagnostics are optional */ }
      });
      else onStarted?.();
      return true;
    } catch (error) {
      onRejected?.(error);
      return false;
    }
  }

  function startMusic() {
    if (!enabled || !hasUserGesture) return false;
    if (!music) music = makeAudio(QUIZ_AUDIO_ASSETS.backgroundMusic, 'music', true, 'music');
    if (!music) return false;
    return playElement(music);
  }

  function playAsset(name, options = {}) {
    const allowAutoplayAttempt = options.allowAutoplay === true;
    if (!enabled || (!hasUserGesture && !allowAutoplayAttempt)) {
      if (enabled && !pendingAssets.includes(name)) pendingAssets.push(name);
      return false;
    }
    const asset = QUIZ_AUDIO_ASSETS[name];
    if (!asset) return false;
    const bus = assetBus(name);
    const audio = makeAudio(asset, bus, false, name);
    if (audio?.addEventListener && !audio.loop) audio.addEventListener('ended', () => {
      audio.remove?.();
      options.onEnded?.();
    }, { once: true });
    return playElement(audio, options);
  }

  async function playRemoteVoice(url) {
    if (!enabled || !hasUserGesture || !url) return false;
    cancelSpeech();
    let audio = null;
    const cleanup = () => {
      try { audio?.pause?.(); } catch { /* best effort */ }
      try { audio?.remove?.(); } catch { /* best effort */ }
      restoreMusic();
    };
    try {
      // Stream the same-origin MP3 directly instead of buffering it through
      // fetch/blob first. This removes one full download/decode delay.
      duckMusic();
      audio = makeAudio(url, 'voiceGain', false, 'dynamicVoice');
      if (!audio) { cleanup(); return false; }
      if (audio.addEventListener) audio.addEventListener('ended', cleanup, { once: true });
      return await new Promise((resolve) => {
        const started = playElement(audio, {
          onStarted: () => resolve(true),
          onRejected: () => { cleanup(); resolve(false); }
        });
        if (!started) { cleanup(); resolve(false); }
      });
    } catch {
      cleanup();
      return false;
    }
  }

  function playQueuedFinalVoice(request) {
    if (!request?.url) return;
    if (finalResultsPlaying) {
      pendingFinalVoice = request;
      return;
    }
    void playRemoteVoice(request.url).then((played) => {
      if (!played && request.fallbackText) speak(request.fallbackText);
    });
  }

  function startFinalResultsSequence(snapshot, voiceUrl) {
    const announcement = snapshot.announcement || {};
    const fallbackText = announcement.text || 'Màn chơi đã kết thúc.';
    const request = voiceUrl ? { url: voiceUrl, fallbackText } : null;
    const playNext = () => {
      finalResultsPlaying = false;
      const next = pendingFinalVoice || request;
      pendingFinalVoice = null;
      playQueuedFinalVoice(next);
    };
    finalResultsPlaying = true;
    const started = playAsset('finalResults', { onEnded: playNext, onRejected: playNext });
    if (!started) {
      finalResultsPlaying = false;
      playQueuedFinalVoice(request);
    }
  }

  function restoreMusic() {
    if (graph?.musicGain?.gain) graph.musicGain.gain.value = musicBaseGain;
    else if (music) try { music.volume = musicBaseGain; } catch { /* best effort */ }
  }

  function duckMusic() {
    const duckedGain = musicBaseGain > 0 ? musicBaseGain * (QUIZ_AUDIO_GAIN.duckedMusic / QUIZ_AUDIO_GAIN.music) : 0;
    if (graph?.musicGain?.gain) graph.musicGain.gain.value = duckedGain;
    else if (music) try { music.volume = duckedGain; } catch { /* best effort */ }
  }

  function setVolumes(nextVolumes = {}) {
    audioVolumes = normalizeAudioVolumes(nextVolumes);
    musicBaseGain = audioVolumes.music / 100;
    if (graph?.musicGain?.gain) graph.musicGain.gain.value = musicBaseGain;
    if (graph?.sfxGain?.gain) graph.sfxGain.gain.value = busPeak('sfxGain');
    if (graph?.voiceGain?.gain) graph.voiceGain.gain.value = busPeak('voiceGain');
    if (graph?.masterGain?.gain) graph.masterGain.gain.value = enabled ? audioVolumes.master / 100 : 0;
    if (music && !useWebAudio) {
      try { music.volume = musicBaseGain; } catch { /* best effort */ }
    }
    return { ...audioVolumes };
  }

  function cancelSpeech() {
    if (!activeSpeech) return;
    try { speech?.cancel?.(); } catch { /* unsupported speech engines may throw */ }
    activeSpeech = null;
    restoreMusic();
  }

  function speak(message) {
    const textValue = String(message || '').trim();
    if (!textValue || !enabled || !hasUserGesture || !speech || typeof UtteranceCtor !== 'function') return false;
    const voices = typeof speech.getVoices === 'function' ? speech.getVoices() : [];
    const voice = voices.find(isVietnameseVoice);
    if (!voice) return false;
    cancelSpeech();
    let utterance;
    try {
      utterance = new UtteranceCtor(textValue);
      utterance.lang = 'vi-VN';
      utterance.voice = voice;
      duckMusic();
      const finish = () => {
        if (activeSpeech === utterance) {
          activeSpeech = null;
          restoreMusic();
        }
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      activeSpeech = utterance;
      speech.speak(utterance);
      return true;
    } catch {
      restoreMusic();
      activeSpeech = null;
      return false;
    }
  }

  function enableAfterUserGesture() {
    hasUserGesture = true;
    try { context?.resume?.(); } catch { /* autoplay policy is non-fatal */ }
    ensureGraph();
    startMusic();
    const queued = pendingAssets;
    pendingAssets = [];
    queued.forEach((name) => {
      if (!playAsset(name)) pendingAssets.push(name);
    });
    return true;
  }

  function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    const currentGraph = ensureGraph();
    if (currentGraph?.masterGain?.gain) currentGraph.masterGain.gain.value = enabled ? QUIZ_AUDIO_GAIN.master : 0;
    if (!enabled) {
      try { music?.pause?.(); } catch { /* media cleanup is best effort */ }
      cancelSpeech();
      pendingAssets = [];
    } else if (hasUserGesture) {
      startMusic();
    }
    return enabled;
  }

  function eventKey(eventName, snapshot = {}) {
    return `${eventName}:${snapshot.questionIndex ?? ''}:${snapshot.roomVersion ?? ''}`;
  }

  function handleEvent(eventName, snapshot = {}, options = {}) {
    const announcement = snapshot.announcement || {};
    const questionKey = snapshot.question?.id || snapshot.questionIndex || 'room';
    // Room-ready is a local lifecycle cue: play it only after a successful
    // create/join action. Do not infer it from restored snapshots, otherwise
    // a page reload or reconnect would announce the room again.
    if (eventName === 'room_ready') {
      const key = `room-ready:${snapshot.roomCode || 'room'}`;
      if (!handled.has(key)) { handled.add(key); playAsset('roomReady'); }
    }
    if (eventName === 'reveal' && !handled.has(`reveal:${questionKey}`)) {
      handled.add(`reveal:${questionKey}`);
      const fallbackText = announcement.text || (announcement.kind === 'no_correct_answer' ? 'Chưa có người trả lời đúng câu này.' : '');
      if (options.voiceUrl) void playRemoteVoice(options.voiceUrl).then((played) => { if (!played) speak(fallbackText); });
      else if (announcement.kind !== 'fastest_correct') speak(fallbackText);
    }
    if (eventName === 'voice_ready' && !handled.has(`voice-ready:${questionKey}:${announcement.voiceAssetId || ''}`)) {
      handled.add(`voice-ready:${questionKey}:${announcement.voiceAssetId || ''}`);
      const fallbackText = announcement.text || '';
      if (announcement.kind === 'final_results') playQueuedFinalVoice({ url: options.voiceUrl, fallbackText });
      else if (options.voiceUrl) void playRemoteVoice(options.voiceUrl).then((played) => { if (!played) speak(fallbackText); });
      else speak(fallbackText);
    }
    if (eventName === 'finished') {
      const key = eventKey('finished', snapshot);
      if (!handled.has(key)) {
        handled.add(key);
        const fallbackText = announcement.text || 'Màn chơi đã kết thúc.';
        if (announcement.kind === 'final_results') startFinalResultsSequence(snapshot, options.voiceUrl);
        else {
          playAsset('finalResults');
          if (options.voiceUrl) void playRemoteVoice(options.voiceUrl).then((played) => { if (!played) speak(fallbackText); });
          else speak(fallbackText);
        }
      }
    }
  }

  return {
    get context() { return context; },
    get graph() { return graph; },
    get enabled() { return enabled; },
    get userGestureEnabled() { return hasUserGesture; },
    get music() { return music; },
    get activeSpeech() { return activeSpeech; },
    userGesture: enableAfterUserGesture,
    setEnabled,
    setVolumes,
    get volumes() { return { ...audioVolumes }; },
    startMusic,
    playAsset,
    playRemoteVoice,
    speak,
    duckMusic,
    restoreMusic,
    cancelSpeech,
    handleEvent,
    pendingAssets: () => [...pendingAssets]
  };
}

export function sessionMetadata(session, audioEnabled = false) {
  if (!session) return null;
  const metadata = {};
  for (const field of QUIZ_SESSION_FIELDS) {
    if (field === 'audioEnabled') metadata[field] = Boolean(audioEnabled);
    else if (session[field] != null && session[field] !== '') metadata[field] = session[field];
  }
  return metadata;
}

function cleanOptions(options = {}) {
  return Object.fromEntries(ANSWERS.map((letter) => [letter, String(options[letter] ?? '')]));
}

export function resolveQuestion(snapshot, questionBank = { questions: [] }) {
  const remote = snapshot?.question || {};
  const id = remote.id || remote.qID || `q${String(Number(snapshot?.questionIndex ?? 0) + 1).padStart(2, '0')}`;
  const local = (questionBank.questions || []).find((question) => question.id === id);
  const source = local || remote;
  return {
    id,
    prompt: String(source.prompt || ''),
    options: cleanOptions(source.options)
  };
}

export function projectSnapshot(snapshot, role = 'player', questionBank = { questions: [] }) {
  const question = snapshot?.question ? resolveQuestion(snapshot, questionBank) : null;
  const reveal = snapshot?.reveal || null;
  const player = (snapshot?.participants || []).find((candidate) => candidate.role === role);
  const activeAnswer = player && snapshot?.answers ? snapshot.answers[player.playerId] : null;
  return {
    role,
    phase: snapshot?.phase || 'lobby',
    roomCode: String(snapshot?.roomCode || ''),
    roomVersion: Number(snapshot?.roomVersion || 0),
    questionIndex: Number(snapshot?.questionIndex ?? -1),
    question,
    reveal: reveal ? {
      correctOption: ANSWERS.includes(reveal.correctOption) ? reveal.correctOption : null,
      explanation: String(reveal.explanation || ''),
      reason: String(reveal.reason || '')
    } : null,
    activeAnswer: activeAnswer ? { accepted: true } : null,
    leaderboard: Array.isArray(snapshot?.leaderboard) ? snapshot.leaderboard : [],
    finalResults: Array.isArray(snapshot?.finalResults) ? snapshot.finalResults : [],
    deadlineAt: snapshot?.deadlineAt || null,
    serverNow: snapshot?.serverNow || null,
    remainingMs: snapshot?.remainingMs ?? null,
    autoAdvance: Boolean(snapshot?.autoAdvance),
    announcement: snapshot?.announcement ? String(snapshot.announcement.text || '') : ''
  };
}

export function readSessionMetadata(source = globalThis) {
  const isRealBrowserWindow = typeof window !== 'undefined' && source === window;
  const store = source?.getItem ? source : (isRealBrowserWindow ? source?.sessionStorage : source?.localStorage);
  if (!store) return null;
  try {
    const parsed = JSON.parse(store.getItem(QUIZ_SESSION_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const metadata = sessionMetadata(parsed, parsed.audioEnabled);
    return metadata?.roomCode && metadata?.role && metadata?.playerId ? metadata : null;
  } catch {
    return null;
  }
}

function finishedResultStorageKey(session) {
  if (!session?.roomCode || !session?.playerId) return null;
  return `${QUIZ_RESULT_STORAGE_PREFIX}${session.roomCode}:${session.playerId}`;
}

function formatHistoryDate(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return 'Không rõ thời gian';
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function readRuntimeSession(source = globalThis) {
  const store = source?.sessionStorage;
  if (!store) return null;
  try {
    const parsed = JSON.parse(store.getItem(QUIZ_RUNTIME_SESSION_STORAGE_KEY) || 'null');
    return parsed?.roomCode && parsed?.playerId && parsed?.capabilityToken ? parsed : null;
  } catch {
    return null;
  }
}

function readFinishedSnapshot(source, session) {
  const store = source?.getItem ? source : source?.localStorage;
  const key = finishedResultStorageKey(session);
  if (!store || !key) return null;
  try {
    const saved = JSON.parse(store.getItem(key) || 'null');
    const snapshot = saved?.snapshot;
    return snapshot?.phase === 'finished' && snapshot.roomCode === session.roomCode ? snapshot : null;
  } catch {
    return null;
  }
}

function text(node, value) {
  if (node) node.textContent = value == null ? '' : String(value);
}

function formatScore(value) {
  return `${Number(value || 0).toLocaleString('vi-VN')} điểm`;
}

function roomWebSocketUrl(windowRef, roomCode, session, reconnectToken) {
  const location = windowRef?.location || { protocol: 'http:', host: 'localhost' };
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({
    playerId: session.playerId,
    capabilityToken: session.capabilityToken
  });
  if (reconnectToken) query.set('reconnectToken', reconnectToken);
  return `${protocol}//${location.host}/api/quiz/rooms/${encodeURIComponent(roomCode)}/socket?${query}`;
}

function hasCapabilityToken(session) {
  return typeof session?.capabilityToken === 'string' && session.capabilityToken.trim().length > 0;
}

export function createQuizController(options = {}) {
  const documentRef = options.documentRef || (typeof document !== 'undefined' ? document : null);
  const windowRef = options.windowRef || (typeof window !== 'undefined' ? window : globalThis);
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const root = options.root || documentRef;
  const questionBank = options.questionBank || { questions: [] };
  const commandTransport = options.commandTransport || null;
  const now = options.now || (() => Date.now());
  const state = {
    role: null,
    session: null,
    snapshot: null,
    phase: 'entry',
    connection: 'disconnected',
    transport: 'disconnected',
    audioEnabled: true,
    clockOffset: 0,
    answerSubmitted: false,
    answerPending: false,
    selectedOption: null,
    revealedCorrectOption: null,
    lastQuestionId: null,
    warned: new Set(),
    lastResult: null,
    socket: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    awaitingResume: false,
    reconnectRejected: false,
    lastAuthoritativeEvent: null,
    effects: [],
    lastEffect: null,
    finalizing: false,
    timerHandle: null,
    finishedSyncTimer: null,
    finishedSyncInFlight: false,
    previousFocus: null,
    history: [],
    welcomePending: false,
    questionDurationSec: DEFAULT_QUESTION_DURATION_SEC
  };
  state.audioEnabled = typeof options.audioEnabled === 'boolean' ? options.audioEnabled : preferredAudio();
  const audioManager = options.audioManager || createQuizAudioManager({
    windowRef,
    documentRef,
    enabled: state.audioEnabled,
    AudioContext: options.AudioContext,
    Audio: options.Audio,
    useWebAudio: false,
    fetch: fetchImpl,
    speechSynthesis: options.speechSynthesis,
    SpeechSynthesisUtterance: options.SpeechSynthesisUtterance
  });

  async function loadAudioSettings() {
    if (!fetchImpl || !windowRef?.location?.host || typeof window === 'undefined' || windowRef !== window || typeof audioManager.setVolumes !== 'function') return;
    try {
      const response = await fetchImpl('/api/audio-settings', { headers: { Accept: 'application/json' } });
      if (!response?.ok || typeof response.json !== 'function') return;
      const payload = await response.json();
      if (payload?.audio_volume && typeof audioManager.setVolumes === 'function') {
        audioManager.setVolumes(payload.audio_volume);
      }
    } catch {
      // Keep the built-in safe defaults when the local settings service is down.
    }
  }

  async function loadQuizSettings() {
    if (!fetchImpl || typeof window === 'undefined' || windowRef !== window) return;
    try {
      const response = await fetchImpl('/api/quiz-settings', { headers: { Accept: 'application/json' } });
      if (!response?.ok || typeof response.json !== 'function') return;
      const payload = await response.json();
      const seconds = Number(payload?.settings?.questionDurationSec);
      if (Number.isFinite(seconds) && seconds >= MIN_QUESTION_DURATION_SEC && seconds <= MAX_QUESTION_DURATION_SEC) {
        state.questionDurationSec = normalizeQuestionDurationSec(seconds);
      }
    } catch {
      // Keep the safe default when the settings endpoint is unavailable.
    }
  }

  const query = (selector) => root?.querySelector?.(selector) || null;
  const queryAll = (selector) => [...(root?.querySelectorAll?.(selector) || [])];
  const byRole = (role) => query(`[data-role="${role}"]`);
  const action = (name) => query(`[data-action="${name}"]`);

  function storage() {
    try { return windowRef?.localStorage || null; } catch { return null; }
  }

  function sessionStore() {
    try {
      const isRealBrowserWindow = typeof window !== 'undefined' && windowRef === window;
      return isRealBrowserWindow ? windowRef?.sessionStorage || null : storage();
    } catch { return null; }
  }

  function runtimeStorage() {
    try { return windowRef?.sessionStorage || null; } catch { return null; }
  }

  function persistSession(session = state.session) {
    const store = sessionStore();
    if (!store || !session) return false;
    try {
      store.setItem(QUIZ_SESSION_STORAGE_KEY, JSON.stringify(sessionMetadata(session, state.audioEnabled)));
      return true;
    } catch { /* metadata is optional */ return false; }
  }

  function persistRuntimeSession(session = state.session) {
    const store = runtimeStorage();
    if (!store || !session?.roomCode || !session?.playerId || !session?.capabilityToken) return false;
    try {
      store.setItem(QUIZ_RUNTIME_SESSION_STORAGE_KEY, JSON.stringify({
        roomCode: session.roomCode,
        playerId: session.playerId,
        role: session.role,
        capabilityToken: session.capabilityToken,
        reconnectToken: session.reconnectToken || null
      }));
      return true;
    } catch { return false; }
  }

  function clearReconnectCapability() {
    if (!state.session) return;
    state.session = { ...state.session, reconnectToken: null };
    persistSession(state.session);
    persistRuntimeSession(state.session);
  }

  function clearPersistedSession() {
    try { sessionStore()?.removeItem(QUIZ_SESSION_STORAGE_KEY); } catch { /* session storage is optional */ }
    try { runtimeStorage()?.removeItem(QUIZ_RUNTIME_SESSION_STORAGE_KEY); } catch { /* runtime metadata is optional */ }
  }

  function persistFinishedSnapshot(snapshot = state.snapshot) {
    const store = storage();
    const key = finishedResultStorageKey(state.session);
    if (!store || !key || snapshot?.phase !== 'finished') return false;
    try {
      store.setItem(key, JSON.stringify({ snapshot, savedAt: now() }));
      return true;
    } catch { return false; }
  }

  function clearFinishedSnapshot(session = state.session) {
    const store = storage();
    const key = finishedResultStorageKey(session);
    if (!store || !key) return false;
    try { store.removeItem(key); return true; } catch { return false; }
  }

  function rotateReconnectToken(token, snapshot) {
    if (typeof token !== 'string' || !token) return false;
    const nextSession = { ...state.session, reconnectToken: token };
    if (snapshot && Number.isFinite(Number(snapshot.roomVersion))) nextSession.roomVersion = Number(snapshot.roomVersion);
    // Persist the replacement in one storage write before any later reconnect can read it.
    persistSession(nextSession);
    persistRuntimeSession(nextSession);
    state.session = nextSession;
    return true;
  }

  function preferredAudio() {
    return true;
  }

  function welcomeWasPlayed() {
    try { return storage()?.getItem(QUIZ_WELCOME_STORAGE_KEY) === '1'; } catch { return false; }
  }

  function markWelcomePlayed() {
    try { storage()?.setItem(QUIZ_WELCOME_STORAGE_KEY, '1'); } catch { /* localStorage is optional */ }
  }

  function queueWelcomeVoice() {
    if (welcomeWasPlayed()) return false;
    state.welcomePending = true;
    return audioManager.playAsset('welcome', {
      allowAutoplay: true,
      onStarted: () => {
        state.welcomePending = false;
        markWelcomePlayed();
      },
      onRejected: () => { audioManager.playAsset('welcome'); }
    });
  }

  function finalizeWelcomeVoice() {
    if (!state.welcomePending) return;
    if (!audioManager.pendingAssets().includes('welcome')) {
      state.welcomePending = false;
      markWelcomePlayed();
    }
  }

  function unlockAudio() {
    state.audioEnabled = true;
    audioManager.setEnabled(true);
    audioManager.userGesture();
    finalizeWelcomeVoice();
    persistSession();
  }

  function renderHistory(rows = state.history) {
    const list = byRole('history-list');
    const empty = byRole('history-empty');
    if (!list || !documentRef) return;
    list.replaceChildren();
    rows.forEach((entry, entryIndex) => {
      const item = documentRef.createElement('li');
      const trigger = documentRef.createElement('button');
      trigger.type = 'button';
      trigger.className = 'history-entry';
      trigger.dataset.historyIndex = String(entryIndex);
      const header = documentRef.createElement('div');
      header.className = 'history-entry-header';
      const room = documentRef.createElement('strong');
      text(room, 'Phòng ' + (entry.roomCode || '—'));
      const date = documentRef.createElement('time');
      date.dateTime = new Date(Number(entry.finishedAt) || 0).toISOString();
      text(date, formatHistoryDate(entry.finishedAt));
      header.append(room, date);
      const meta = documentRef.createElement('p');
      meta.className = 'history-meta';
      text(meta, String(entry.playerCount || 0) + ' người chơi · ' + String(entry.questionCount || 0) + ' câu hỏi');
      const top = documentRef.createElement('p');
      top.className = 'history-top';
      const leaders = Array.isArray(entry.leaderboard) ? entry.leaderboard.slice(0, 3) : [];
      text(top, leaders.length
        ? leaders.map((row) => String(row.rank) + '. ' + row.displayName + ' — ' + formatScore(row.totalScore)).join('  ·  ')
        : 'Chưa có bảng điểm.');
      trigger.append(header, meta, top);
      item.append(trigger);
      list.append(item);
    });
    empty.hidden = rows.length > 0;
  }

  function closeHistoryDialog() {
    const dialog = byRole('history-dialog');
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    else dialog?.removeAttribute('open');
  }

  function showHistoryEntry(index) {
    const entry = state.history[Number(index)];
    const dialog = byRole('history-dialog');
    const list = byRole('history-dialog-list');
    const empty = byRole('history-dialog-empty');
    if (!entry || !dialog || !list || !documentRef) return;
    text(byRole('history-dialog-heading'), `Phòng ${entry.roomCode || '—'}`);
    text(byRole('history-dialog-meta'), `${formatHistoryDate(entry.finishedAt)} · ${String(entry.playerCount || 0)} người chơi · ${String(entry.questionCount || 0)} câu hỏi`);
    list.replaceChildren();
    const rows = Array.isArray(entry.leaderboard) ? entry.leaderboard : [];
    rows.forEach((rowData, rowIndex) => {
      const row = documentRef.createElement('li');
      row.className = 'leaderboard-row';
      const rank = documentRef.createElement('span');
      rank.className = 'rank';
      text(rank, String(rowData.rank || rowIndex + 1));
      const name = documentRef.createElement('span');
      name.className = 'leaderboard-name';
      text(name, rowData.displayName || 'Người chơi');
      const score = documentRef.createElement('span');
      score.className = 'score';
      text(score, formatScore(rowData.totalScore));
      row.append(rank, name, score);
      list.append(row);
    });
    empty.hidden = rows.length > 0;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  async function loadHistory() {
    if (!documentRef) return;
    const error = byRole('history-error');
    if (error) error.hidden = true;
    try {
      const body = await request('/api/history');
      state.history = Array.isArray(body.history) ? body.history : [];
      try { storage()?.setItem(QUIZ_HISTORY_STORAGE_KEY, JSON.stringify(state.history)); } catch { /* optional cache */ }
    } catch {
      try { state.history = JSON.parse(storage()?.getItem(QUIZ_HISTORY_STORAGE_KEY) || '[]'); } catch { state.history = []; }
      if (error) error.hidden = false;
    }
    renderHistory();
  }

  function reducedMotion() {
    if (typeof options.reducedMotion === 'boolean') return options.reducedMotion;
    try { return Boolean(windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
  }

  function visibleStatus() {
    if (state.transport === 'reconnecting' || state.transport === 'offline') return state.transport;
    if (state.snapshot?.phase === 'paused_host_disconnect') return 'paused';
    if (state.role === 'player' && state.answerSubmitted) return 'answer-recorded';
    return state.transport;
  }

  function renderConnectionStatus(copy) {
    const status = visibleStatus();
    state.connection = status;
    const band = byRole('status-band');
    if (band) band.dataset.state = status;
    const defaultCopy = state.lastAuthoritativeEvent === 'correct' && status === 'answer-recorded'
      ? 'Đã ghi nhận câu trả lời đúng'
      : ({
      connected: 'Đã kết nối',
      reconnecting: 'Mất kết nối. Đang thử kết nối lại…',
      offline: 'Mất kết nối. Bạn có thể thử lại hoặc về trang đầu.',
      paused: 'Phòng đang tạm dừng vì chủ phòng mất kết nối',
      'answer-recorded': 'Đã ghi nhận câu trả lời'
    }[status] || 'Đang kết nối');
    text(byRole('connection-status'), copy || defaultCopy);
  }

  function setConnection(status, copy) {
    state.transport = status;
    renderConnectionStatus(copy);
  }

  async function request(url, init) {
    if (!fetchImpl) throw new Error('fetch_unavailable');
    const response = await fetchImpl(url, init);
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok || body.ok === false) {
      const error = new Error(body.error || 'Dịch vụ quiz tạm thời không khả dụng.');
      error.code = body.code;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function dynamicVoiceUrl(snapshot) {
    const assetId = snapshot?.announcement?.voiceAssetId;
    const session = state.session;
    const roomCode = snapshot?.roomCode || session?.roomCode;
    if (!assetId || !roomCode || !session?.playerId || !session?.capabilityToken) return null;
    const query = new URLSearchParams({
      playerId: session.playerId,
      capabilityToken: session.capabilityToken
    });
    if (snapshot?.phase === 'finished') query.set('finished', '1');
    return `/api/quiz/rooms/${encodeURIComponent(roomCode)}/voice/${encodeURIComponent(assetId)}?${query}`;
  }

  function showScreen(name) {
    state.phase = name;
    queryAll('[data-screen]').forEach((screen) => {
      const visible = screen.dataset.screen === name;
      screen.hidden = !visible;
      screen.setAttribute('aria-hidden', String(!visible));
    });
    const shell = byRole('quiz-shell');
    if (shell) shell.dataset.state = name;
  }

  function setRole(role) {
    state.role = role;
    text(byRole('role-badge'), role === 'host' ? 'Chủ phòng' : 'Người chơi');
    const badge = byRole('role-badge');
    if (badge) badge.hidden = false;
  }

  function renderParticipants(participants = []) {
    const list = byRole('participant-list');
    if (list && documentRef) {
      list.replaceChildren();
      participants.filter((candidate) => candidate.role === 'player').forEach((participant) => {
        const row = documentRef.createElement('li');
        row.className = 'participant-row';
        const name = documentRef.createElement('span');
        text(name, participant.displayName);
        const status = documentRef.createElement('span');
        status.className = 'participant-status';
        status.dataset.state = participant.status === 'online' ? 'online' : 'offline';
        text(status, participant.status === 'online' ? 'Đang trực tuyến' : 'Đang ngoại tuyến');
        row.append(name, status);
        list.append(row);
      });
    }
    text(byRole('participant-count'), String(participants.filter((candidate) => candidate.role === 'player').length));
    text(byRole('participant-count-player'), String(participants.length));
  }

  function renderLeaderboard(rows, listRole, emptyRole, countRole) {
    const list = byRole(listRole);
    const empty = byRole(emptyRole);
    if (list && documentRef) {
      list.replaceChildren();
      rows.forEach((rowData, index) => {
        const row = documentRef.createElement('li');
        row.className = 'leaderboard-row';
        const rank = documentRef.createElement('span');
        rank.className = 'rank';
        text(rank, String(rowData.rank || index + 1));
        const name = documentRef.createElement('span');
        name.className = 'leaderboard-name';
        text(name, rowData.displayName || 'Người chơi');
        const score = documentRef.createElement('span');
        score.className = 'score';
        text(score, formatScore(rowData.totalScore));
        row.append(rank, name, score);
        list.append(row);
      });
    }
    if (empty) empty.hidden = rows.length > 0;
    text(byRole(countRole), rows.length ? `${rows.length} người` : '');
  }

  function renderQuestion(snapshot) {
    const projected = projectSnapshot(snapshot, state.role, questionBank);
    const question = projected.question;
    if (!question) {
      text(byRole('error-message'), 'Không thể tải bộ câu hỏi. Vui lòng thử lại.');
      return;
    }
    text(byRole('question-progress'), `Câu ${projected.questionIndex + 1}/${QUESTION_COUNT}`);
    text(byRole('question-heading'), question.prompt);
    const remaining = snapshot.phase === 'paused_host_disconnect'
      ? Number(projected.remainingMs || 0)
      : projected.deadlineAt
        ? Math.max(0, Number(projected.deadlineAt) - (now() - state.clockOffset))
        : Number(projected.remainingMs || 0);
    updateTimer(remaining, snapshot.phase === 'paused_host_disconnect');
    const hostAnswers = byRole('host-answers');
    if (hostAnswers && documentRef) {
      hostAnswers.replaceChildren();
      ANSWERS.forEach((letter) => {
        const row = documentRef.createElement('div');
        row.className = 'answer-option';
        const marker = documentRef.createElement('span');
        marker.className = 'answer-letter';
        text(marker, letter);
        const answer = documentRef.createElement('span');
        text(answer, question.options[letter]);
        row.append(marker, answer);
        hostAnswers.append(row);
      });
    }
    ANSWERS.forEach((letter) => text(query(`[data-answer-text="${letter}"]`), question.options[letter]));
    const isPlayerQuestion = state.role === 'player' && snapshot.phase === 'question';
    const playerAnswers = byRole('player-answers');
    const selectedOption = state.selectedOption;
    const canAnswer = Boolean(commandTransport) || state.transport === 'connected';
    queryAll('[data-answer]').forEach((button) => {
      button.hidden = !isPlayerQuestion;
      button.disabled = !isPlayerQuestion || !canAnswer || state.answerSubmitted || state.answerPending;
      if (!state.answerSubmitted && !state.answerPending) delete button.dataset.state;
      if (state.answerPending && button.dataset.answer === selectedOption) button.dataset.state = 'selected';
      else if (state.answerPending) delete button.dataset.state;
      if (state.answerSubmitted && snapshot.answers?.[state.session?.playerId]?.accepted) {
        if (button.dataset.answer === selectedOption) {
          button.dataset.state = state.lastAuthoritativeEvent === 'correct' || state.lastAuthoritativeEvent === 'incorrect'
            ? state.lastAuthoritativeEvent
            : 'selected';
        } else if (button.dataset.answer === state.revealedCorrectOption) button.dataset.state = 'correct';
        else delete button.dataset.state;
      }
    });
    if (hostAnswers) hostAnswers.hidden = state.role !== 'host';
    if (playerAnswers) playerAnswers.hidden = !isPlayerQuestion;
    const shortcut = byRole('shortcut-help');
    if (shortcut) shortcut.hidden = !isPlayerQuestion;
    text(byRole('answer-count'), state.role === 'host' ? `${Object.values(snapshot.answers || {}).filter(Boolean).length} đã trả lời` : '');
    text(byRole('answer-status'), state.answerSubmitted ? 'Đã ghi nhận câu trả lời.' : state.answerPending ? 'Đang gửi câu trả lời…' : '');
  }

  function updateTimer(remainingMs, paused = false) {
    const seconds = Math.max(0, Math.ceil(Number(remainingMs || 0) / 1000));
    const timer = byRole('timer');
    text(byRole('timer-value'), String(seconds));
    if (timer) {
      const status = paused ? 'paused' : seconds <= 0 ? 'expired' : seconds <= 5 ? 'critical' : seconds <= 10 ? 'warning' : 'normal';
      timer.dataset.state = status;
      timer.setAttribute('aria-label', paused ? 'Phòng đang tạm dừng' : `Còn ${seconds} giây`);
    }
    const progress = byRole('timer-progress');
    if (progress) {
      if (!progress.style) progress.style = {};
      const duration = normalizeQuestionDurationSec(state.questionDurationSec);
      progress.style.transform = `scaleX(${Math.max(0, Math.min(1, seconds / duration))})`;
    }
    if (!paused && (seconds === 10 || seconds === 5) && !state.warned.has(seconds)) {
      state.warned.add(seconds);
      announce(`Còn ${seconds} giây`);
    }
  }

  function syncTimerLoop(phase) {
    if (phase === 'question' && !state.timerHandle && windowRef?.setInterval) {
      state.timerHandle = windowRef.setInterval(() => {
        if (state.snapshot?.phase === 'question') renderQuestion(state.snapshot);
        else syncTimerLoop(state.snapshot?.phase);
      }, 250);
    } else if (phase !== 'question' && state.timerHandle && windowRef?.clearInterval) {
      windowRef.clearInterval(state.timerHandle);
      state.timerHandle = null;
    }
  }

  function clearFinishedSync() {
    if (state.finishedSyncTimer && windowRef?.clearTimeout) windowRef.clearTimeout(state.finishedSyncTimer);
    state.finishedSyncTimer = null;
  }

  async function reconcileFinishedSnapshot() {
    if (state.finishedSyncInFlight || state.snapshot?.phase !== 'reveal' || !state.session) return;
    state.finishedSyncInFlight = true;
    try {
      const params = new URLSearchParams({
        roomCode: state.session.roomCode,
        playerId: state.session.playerId,
        capabilityToken: state.session.capabilityToken,
        finished: '1'
      });
      const body = await request(`/api/quiz/rooms?${params}`);
      if (body.snapshot?.phase === 'finished') {
        applyMessage({ event: 'finished', snapshot: body.snapshot });
      }
    } catch {
      // The WebSocket remains the primary transport; a temporary API failure
      // should not interrupt the reveal screen or the reconnect loop.
    } finally {
      state.finishedSyncInFlight = false;
      if (state.snapshot?.phase === 'reveal') scheduleFinishedSync();
    }
  }

  function scheduleFinishedSync() {
    if (state.finishedSyncTimer || !windowRef?.setTimeout || !state.session || state.snapshot?.phase !== 'reveal') return;
    state.finishedSyncTimer = windowRef.setTimeout(() => {
      state.finishedSyncTimer = null;
      reconcileFinishedSnapshot();
    }, FINISHED_SYNC_DELAY_MS);
  }

  function renderReveal(snapshot) {
    const question = resolveQuestion(snapshot, questionBank);
    const reveal = snapshot.reveal || {};
    const correct = ANSWERS.includes(reveal.correctOption) ? reveal.correctOption : '';
    text(byRole('correct-answer'), correct ? `Đáp án đúng: ${correct}. ${question.options[correct] || ''}` : '');
    text(byRole('explanation'), reveal.explanation || '');
    const mine = snapshot.leaderboard?.find((row) => row.playerId === state.session?.playerId);
    const answerAccepted = Boolean(snapshot.answers?.[state.session?.playerId]);
    if (snapshot.reveal?.reason === 'timeout' && !answerAccepted) text(byRole('result-message'), 'Hết giờ. Bạn chưa chọn đáp án nên câu này được tính 0 điểm.');
    else if (state.lastAuthoritativeEvent === 'incorrect') text(byRole('result-message'), 'Đã ghi nhận câu trả lời. Đáp án chưa chính xác.');
    else if (state.lastAuthoritativeEvent === 'correct') text(byRole('result-message'), 'Chính xác! Điểm được cập nhật từ máy chủ.');
    else if (!answerAccepted) text(byRole('result-message'), 'Bạn chưa chọn đáp án. Câu này được tính 0 điểm.');
    else if (mine) text(byRole('result-message'), '');
    else text(byRole('result-message'), 'Đã ghi nhận câu trả lời.');
    text(byRole('announcement'), '');
    text(byRole('announcement-footer'), 'Bạn sẽ luôn thấy thông báo bằng chữ khi âm thanh bị tắt.');
  }

  function renderFinished(snapshot) {
    const mine = (snapshot.finalResults || snapshot.leaderboard || []).find((row) => row.playerId === state.session?.playerId);
    text(byRole('final-score'), String(mine?.totalScore || 0).toLocaleString('vi-VN'));
    text(byRole('final-rank'), mine ? `Xếp hạng ${mine.rank}` : '');
    text(byRole('final-announcement'), snapshot.announcement?.text || '');
    const topTen = (snapshot.finalResults?.length ? snapshot.finalResults : snapshot.leaderboard || []).slice(0, 10);
    renderLeaderboard(topTen, 'final-top10-list', 'final-top10-empty', 'final-top10-count');
    renderLeaderboard(snapshot.leaderboard || [], 'leaderboard-list', 'room-leaderboard-empty', 'leaderboard-count');
  }

  function render() {
    const duration = normalizeQuestionDurationSec(state.questionDurationSec);
    state.questionDurationSec = duration;
    const snapshotDuration = Number(state.snapshot?.questionDurationSec);
    if (Number.isFinite(snapshotDuration) && snapshotDuration >= MIN_QUESTION_DURATION_SEC && snapshotDuration <= MAX_QUESTION_DURATION_SEC) {
      state.questionDurationSec = normalizeQuestionDurationSec(snapshotDuration);
    }
    const effectiveDuration = state.questionDurationSec;
    text(byRole('entry-duration-label'), `${effectiveDuration} GIÂY / CÂU`);
    text(byRole('entry-duration-value'), `${effectiveDuration}s`);
    const snapshot = state.snapshot;
    if (!snapshot) {
      showScreen(state.phase === 'entry' ? 'entry' : state.phase);
      return;
    }
    const phase = snapshot.phase;
    syncTimerLoop(phase);
    if (phase === 'reveal') scheduleFinishedSync();
    else clearFinishedSync();
    if (phase === 'finished') showScreen('room');
    else if (phase === 'lobby') showScreen('room');
    else showScreen('room');
    const hostLobby = byRole('host-lobby');
    const playerLobby = byRole('player-lobby');
    const questionPanel = byRole('question-panel');
    const revealPanel = byRole('reveal-panel');
    const finishedPanel = byRole('finished-panel');
    const hostRail = byRole('host-rail');
    const hostControls = byRole('host-controls');
    const pausedPanel = byRole('paused-panel');
    [hostLobby, playerLobby, questionPanel, revealPanel, finishedPanel, hostRail].forEach((node) => { if (node) node.hidden = true; });
    if (pausedPanel) pausedPanel.hidden = phase !== 'paused_host_disconnect';
    if (hostControls) hostControls.hidden = phase === 'finished';
    text(byRole('room-code'), snapshot.roomCode || state.session?.roomCode || '');
    text(byRole('player-name'), state.session?.displayName || '');
    renderParticipants(snapshot.participants || []);
    renderLeaderboard(snapshot.leaderboard || [], 'leaderboard-list', 'room-leaderboard-empty', 'leaderboard-count');
    if (state.role === 'host' && hostRail) hostRail.hidden = false;
    if (phase === 'lobby') {
      if (state.role === 'host' && hostLobby) hostLobby.hidden = false;
      if (state.role === 'player' && playerLobby) playerLobby.hidden = false;
    } else if (phase === 'question' || phase === 'paused_host_disconnect') {
      if (questionPanel) questionPanel.hidden = false;
      renderQuestion(snapshot);
      if (phase === 'paused_host_disconnect') updateTimer(snapshot.remainingMs, true);
    } else if (phase === 'reveal') {
      if (revealPanel) revealPanel.hidden = false;
      renderReveal(snapshot);
    } else if (phase === 'finished') {
      if (finishedPanel) finishedPanel.hidden = false;
      renderFinished(snapshot);
    }
    const paused = phase === 'paused_host_disconnect';
    const pauseBanner = byRole('pause-banner');
    if (pauseBanner) pauseBanner.hidden = !paused;
    const status = byRole('status-band');
    if (status) status.dataset.state = state.connection;
    renderControls();
  }

  function announce(message) {
    text(byRole('announcement'), message);
    text(byRole('announcement-footer'), message || 'Bạn sẽ luôn thấy thông báo bằng chữ khi âm thanh bị tắt.');
  }

  function playCue(eventName) {
    const hook = options.audioHook || options.onAudio;
    if (typeof hook === 'function') hook(eventName, state.snapshot, { enabled: state.audioEnabled });
    if (!state.audioEnabled) return;
    if (['correct', 'incorrect'].includes(eventName)) audioManager.playAsset(eventName);
  }

  function setResultState(resultState) {
    const shell = byRole('quiz-shell');
    const targets = [shell, byRole('question-panel'), byRole('reveal-panel')].filter(Boolean);
    for (const target of targets) {
      if (target.dataset) target.dataset.result = resultState;
      if (target.classList) {
        ['is-success', 'is-error', 'is-timeout', 'is-reveal', 'is-finished'].forEach((className) => target.classList.remove(className));
        const className = `is-${resultState}`;
        if (['is-success', 'is-error', 'is-timeout', 'is-reveal', 'is-finished'].includes(className)) target.classList.add(className);
      }
    }
  }

  function triggerEffect(effectName, eventName) {
    state.lastEffect = eventName;
    state.effects.push({ event: eventName, effect: effectName, at: now() });
    if (state.effects.length > 20) state.effects.shift();
    const hook = options.effectHook || options.onEffect;
    if (typeof hook === 'function') hook(effectName, { event: eventName, reducedMotion: reducedMotion() });
    if (reducedMotion()) return;
    const target = byRole('quiz-shell') || byRole('question-panel') || root;
    if (!target?.classList) return;
    target.classList.remove(effectName);
    target.classList.add(effectName);
    if (windowRef?.setTimeout) windowRef.setTimeout(() => target.classList.remove(effectName), EFFECT_DURATION_MS[effectName] || 500);
  }

  function markAuthoritativeAnswer(eventName, correctOption = null) {
    state.answerPending = false;
    state.answerSubmitted = true;
    if (ANSWERS.includes(correctOption)) state.revealedCorrectOption = correctOption;
    queryAll('[data-answer]').forEach((button) => {
      button.disabled = true;
      if (button.dataset.answer === state.selectedOption) button.dataset.state = eventName;
      else if (button.dataset.answer === state.revealedCorrectOption) button.dataset.state = 'correct';
      else delete button.dataset.state;
    });
    setConnection(state.transport, eventName === 'correct' ? 'Đã ghi nhận câu trả lời đúng' : 'Đã ghi nhận câu trả lời');
    announce(eventName === 'correct' ? 'Bạn trả lời đúng.' : 'Bạn đã trả lời. Đáp án chưa chính xác.');
  }

  function applyAuthoritativeEffects(eventName, payload, snapshot) {
    const derivedEvent = eventName === 'reveal' && snapshot?.reveal?.reason === 'timeout' ? 'timeout' : eventName;
    if (!['correct', 'incorrect', 'timeout', 'reveal', 'finished'].includes(derivedEvent)) return;
    if (['correct', 'incorrect'].includes(derivedEvent) && payload?.result?.accepted !== true) return;
    state.lastAuthoritativeEvent = derivedEvent;
    if (derivedEvent === 'correct' || derivedEvent === 'incorrect') {
      markAuthoritativeAnswer(derivedEvent, payload?.result?.correctOption);
      setResultState(derivedEvent === 'correct' ? 'success' : 'error');
      playCue(derivedEvent);
      triggerEffect(derivedEvent === 'correct' ? 'confetti' : 'shake', derivedEvent);
    } else if (derivedEvent === 'timeout') {
      state.answerPending = false;
      state.answerSubmitted = Boolean(snapshot?.answers?.[state.session?.playerId]);
      setResultState('timeout');
      announce('Hết giờ. Đáp án được mở để giải thích.');
      playCue('timeout');
      triggerEffect('shake', 'timeout');
      if (eventName === 'reveal') playCue('reveal');
    } else if (derivedEvent === 'reveal') {
      setResultState('reveal');
      announce(snapshot?.announcement?.text || 'Đáp án đã được mở.');
      playCue('reveal');
    } else if (derivedEvent === 'finished') {
      setResultState('finished');
      announce(snapshot?.announcement?.text || 'Ván chơi đã kết thúc.');
      playCue('finished');
      triggerEffect('confetti', 'finished');
    }
  }

  function renderControls() {
    const connected = state.transport === 'connected' || Boolean(commandTransport);
    const paused = state.snapshot?.phase === 'paused_host_disconnect';
    for (const name of ['start-quiz', 'next-question', 'finish-quiz', 'toggle-auto']) {
      const node = action(name);
      if (node) node.disabled = !connected || paused;
    }
    renderConnectionStatus();
  }

  async function sendCommand(command) {
    if (commandTransport) return commandTransport(command, state);
    if (!state.socket || state.socket.readyState !== 1) throw new Error('socket_unavailable');
    state.socket.send(JSON.stringify(command));
    return null;
  }

  async function submitAnswer(option) {
    if (state.role !== 'player' || state.snapshot?.phase !== 'question' || state.answerSubmitted || state.answerPending || !ANSWERS.includes(option) || (state.transport !== 'connected' && !commandTransport)) return false;
    audioManager.userGesture();
    state.answerPending = true;
    state.selectedOption = option;
    queryAll('[data-answer]').forEach((button) => { button.disabled = true; });
    query(`[data-answer="${option}"]`)?.setAttribute('data-state', 'selected');
    try {
      const result = await sendCommand({ type: 'answer', option });
      if (result) applyMessage(result);
      if (!result) text(byRole('answer-status'), 'Đang gửi câu trả lời…');
      return true;
    } catch (error) {
      state.answerPending = false;
      queryAll('[data-answer]').forEach((button) => { button.disabled = false; });
      text(byRole('answer-status'), error.message || 'Không thể ghi nhận câu trả lời.');
      return false;
    }
  }

  async function createOrJoin(event, role) {
    event.preventDefault();
    audioManager.userGesture();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    const payload = { type: role === 'host' ? 'create' : 'join', role, nickname: values.nickname };
    if (role === 'player') payload.roomCode = String(values.roomCode || '').trim().toUpperCase();
    try {
      setConnection('reconnecting', 'Đang kết nối');
      const body = await request('/api/quiz/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      state.session = { ...body.player, roomCode: body.snapshot.roomCode, capabilityToken: body.capabilityToken, reconnectToken: body.reconnectToken, roomVersion: body.snapshot.roomVersion };
      state.audioEnabled = preferredAudio();
      audioManager.setEnabled(state.audioEnabled);
      persistSession();
      persistRuntimeSession();
      state.snapshot = body.snapshot;
      setRole(role);
      setConnection('connected');
      audioManager.handleEvent('room_ready', body.snapshot);
      render();
      byRole(role === 'host' ? 'host-lobby-heading' : 'player-lobby-heading')?.focus();
      connectSocket();
    } catch (error) {
      setConnection('offline');
      const target = role === 'host' ? byRole('host-nickname-error') : (error.code === 'invalid_nickname' ? byRole('player-nickname-error') : byRole('room-code-error'));
      if (target) { target.hidden = false; text(target, error.message || 'Không thể kết nối.'); }
    }
  }

  function scheduleReconnect() {
    if (!state.session || state.reconnectTimer || state.reconnectRejected || !windowRef?.setTimeout) return;
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_INITIAL_DELAY_MS * (2 ** state.reconnectAttempt));
    state.reconnectAttempt += 1;
    state.reconnectTimer = windowRef.setTimeout(() => {
      state.reconnectTimer = null;
      connectSocket();
    }, delay);
  }

  function rejectReconnect(message = 'Phiên kết nối đã hết hạn. Vui lòng vào lại phòng.') {
    state.reconnectRejected = true;
    clearReconnectCapability();
    setConnection('offline', message);
    text(byRole('error-message'), message);
    showScreen('error');
    render();
  }

  function connectSocket() {
    if (!state.session || !windowRef) return;
    if (!hasCapabilityToken(state.session)) {
      rejectReconnect('Phiên phòng không còn thông tin xác thực. Vui lòng vào lại phòng.');
      return;
    }
    const factory = options.webSocketFactory || ((url) => new windowRef.WebSocket(url));
    try {
      state.awaitingResume = Boolean(state.session.reconnectToken && state.reconnectAttempt > 0);
      state.reconnectRejected = false;
      setConnection(state.awaitingResume ? 'reconnecting' : 'reconnecting', state.awaitingResume ? 'Đang khôi phục phiên…' : 'Đang kết nối');
      state.socket = factory(roomWebSocketUrl(windowRef, state.session.roomCode, state.session, state.awaitingResume ? state.session.reconnectToken : null));
      const socket = state.socket;
      socket.addEventListener?.('open', () => {
        if (state.socket !== socket) return;
        if (!state.awaitingResume) {
          state.reconnectAttempt = 0;
          setConnection('connected');
          render();
        }
      });
      socket.addEventListener?.('message', (event) => { if (state.socket !== socket) return; try { applyMessage(JSON.parse(event.data)); } catch { /* protocol errors arrive as structured server events */ } });
      socket.addEventListener?.('close', (event) => {
        if (state.socket !== socket) return;
        state.socket = null;
        if (event?.code === 4001 || event?.reason === 'invalid_reconnect') {
          rejectReconnect();
          return;
        }
        state.answerPending = false;
        setConnection('reconnecting');
        render();
        scheduleReconnect();
      });
      socket.addEventListener?.('error', (event) => {
        if (state.socket !== socket) return;
        if (event?.code === 'invalid_reconnect') rejectReconnect();
        else setConnection('reconnecting');
      });
    } catch {
      setConnection('offline');
      render();
      scheduleReconnect();
    }
  }

  async function persistFinalResult() {
    if (state.finalizing || !state.session || state.snapshot?.phase !== 'finished') return;
    persistFinishedSnapshot();
    state.finalizing = true;
    render();
    if (state.role === 'host') {
      try {
        const resultId = state.snapshot.resultId || `${state.session.roomCode}:${state.session.playerId}`;
        await request('/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          roomCode: state.session.roomCode,
          playerId: state.session.playerId,
          capabilityToken: state.session.capabilityToken,
          resultId
        }) });
      } catch {
        // The finished room snapshot remains authoritative even if the optional
        // idempotent persistence acknowledgement is temporarily unavailable.
      }
    }
    state.finalizing = false;
    render();
  }

  async function restoreSessionSnapshot() {
    const params = new URLSearchParams({
      roomCode: state.session.roomCode,
      playerId: state.session.playerId,
      capabilityToken: state.session.capabilityToken,
      finished: '1'
    });
    const body = await request(`/api/quiz/rooms?${params}`);
    state.snapshot = body.snapshot;
    if (state.snapshot.phase === 'finished') persistFinishedSnapshot(state.snapshot);
    setConnection('connected');
    render();
    if (state.snapshot.phase !== 'finished') connectSocket();
  }

  function applyMessage(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.event === 'error' || payload.ok === false) {
      if (payload.code === 'invalid_reconnect') {
        rejectReconnect(payload.error || 'Phiên kết nối đã hết hạn. Vui lòng vào lại phòng.');
        return;
      }
      text(byRole('error-message'), payload.error || 'Chưa thể kết nối lại. Kiểm tra mạng rồi thử lại.');
      if (!state.snapshot) showScreen('error');
      return;
    }
    if (payload.event === 'resumed' && payload.reconnectToken) {
      rotateReconnectToken(payload.reconnectToken, payload.snapshot);
      state.awaitingResume = false;
      state.reconnectAttempt = 0;
      setConnection('connected', 'Đã khôi phục phiên');
      if (!payload.snapshot) render();
    }
    if (payload.snapshot) {
      const currentVersion = Number(state.snapshot?.roomVersion);
      const incomingVersion = Number(payload.snapshot.roomVersion);
      if (Number.isFinite(currentVersion) && Number.isFinite(incomingVersion) && incomingVersion < currentVersion) return;
      const previousPhase = state.snapshot?.phase;
      state.snapshot = payload.snapshot;
      if (Number.isFinite(Number(payload.snapshot.roomVersion))) {
        state.session = state.session ? { ...state.session, roomVersion: Number(payload.snapshot.roomVersion) } : state.session;
        persistSession();
      }
      if (Number.isFinite(Number(payload.snapshot.serverNow))) state.clockOffset = now() - Number(payload.snapshot.serverNow);
      const questionId = payload.snapshot.question?.id;
      if (questionId !== state.lastQuestionId) {
        state.lastQuestionId = questionId;
        state.answerSubmitted = Boolean(payload.snapshot.answers?.[state.session?.playerId]);
        state.answerPending = false;
        state.selectedOption = null;
        state.revealedCorrectOption = null;
        state.lastAuthoritativeEvent = null;
        setResultState('idle');
        state.warned.clear();
        byRole('question-heading')?.focus();
      } else if (payload.snapshot.answers?.[state.session?.playerId]?.accepted) {
        state.answerPending = false;
        state.answerSubmitted = true;
      }
      const ownAnswerAccepted = Boolean(payload.snapshot.answers?.[state.session?.playerId]?.accepted);
      if ((payload.event === 'correct' || payload.event === 'incorrect') && ownAnswerAccepted) {
        state.lastResult = { event: payload.event, accepted: payload.result?.accepted === true };
      }
      applyAuthoritativeEffects(ownAnswerAccepted ? payload.event : (['correct', 'incorrect'].includes(payload.event) ? null : payload.event), payload, payload.snapshot);
      if (state.audioEnabled) audioManager.handleEvent(payload.event, payload.snapshot, { voiceUrl: dynamicVoiceUrl(payload.snapshot) });
      if (payload.event === 'finished' || payload.snapshot.phase === 'finished') {
        persistFinishedSnapshot(payload.snapshot);
      }
      render();
      if (payload.event === 'finished' || payload.snapshot.phase === 'finished') persistFinalResult();
      if (previousPhase !== 'question' && payload.snapshot.phase === 'question') byRole('question-heading')?.focus();
    }
  }

  function openConfirmation() {
    const dialog = byRole('confirm-dialog');
    if (!dialog) return;
    state.previousFocus = documentRef?.activeElement || null;
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    dialog.querySelector('[data-action="cancel-confirm"]')?.focus();
  }

  function closeConfirmation() {
    const dialog = byRole('confirm-dialog');
    if (dialog?.open && typeof dialog.close === 'function') dialog.close(); else dialog?.removeAttribute('open');
    state.previousFocus?.focus?.();
    state.previousFocus = null;
  }

  async function copyRoomCode() {
    const code = state.snapshot?.roomCode || state.session?.roomCode || '';
    if (!code) return;
    let copied = false;
    try { if (windowRef.navigator?.clipboard?.writeText) { await windowRef.navigator.clipboard.writeText(code); copied = true; } } catch { copied = false; }
    if (!copied && documentRef) {
      const selection = documentRef.getSelection?.();
      const range = documentRef.createRange?.();
      const node = byRole('room-code');
      try { if (range && selection && node) { range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range); copied = documentRef.execCommand?.('copy') || false; selection.removeAllRanges(); } } catch { copied = false; }
    }
    text(byRole('copy-feedback'), copied ? 'Đã sao chép mã phòng' : 'Mã phòng đã được chọn, bạn có thể sao chép.');
  }

  async function shareRoom() {
    const code = state.snapshot?.roomCode || state.session?.roomCode || '';
    try { if (windowRef.navigator?.share) await windowRef.navigator.share({ title: 'Quizzzzzzzz', text: `Tham gia phòng ${code}` }); else await copyRoomCode(); } catch { /* user cancellation is not an error */ }
  }

  function onKeydown(event) {
    const dialog = byRole('confirm-dialog');
    if (dialog?.open) {
      if (event.key === 'Escape') { event.preventDefault(); closeConfirmation(); return; }
      if (event.key === 'Tab') {
        const focusable = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((node) => !node.disabled && !node.hidden);
        if (focusable.length) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && documentRef.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && documentRef.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      return;
    }
    if (state.role !== 'player' || state.snapshot?.phase !== 'question' || state.answerSubmitted) return;
    const map = { a: 'A', b: 'B', c: 'C', d: 'D', '1': 'A', '2': 'B', '3': 'C', '4': 'D' };
    const option = map[String(event.key || '').toLowerCase()];
    if (!option || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
    event.preventDefault();
    submitAnswer(option);
  }

  function bind() {
    if (!root?.addEventListener) return;
    action('show-create')?.addEventListener('click', () => showScreen('create'));
    action('show-join')?.addEventListener('click', () => showScreen('join'));
    action('refresh-history')?.addEventListener('click', () => { void loadHistory(); });
    byRole('history-list')?.addEventListener('click', (event) => {
      const trigger = event.target?.closest?.('[data-history-index]');
      if (trigger) showHistoryEntry(trigger.dataset.historyIndex);
    });
    query('[data-form="create"]')?.addEventListener('submit', (event) => createOrJoin(event, 'host'));
    query('[data-form="join"]')?.addEventListener('submit', (event) => createOrJoin(event, 'player'));
    queryAll('[data-action="back-entry"]').forEach((node) => node.addEventListener('click', () => showScreen('entry')));
    queryAll('[data-answer]').forEach((node) => node.addEventListener('click', () => submitAnswer(node.dataset.answer)));
    action('start-quiz')?.addEventListener('click', () => { unlockAudio(); if (state.role === 'host') sendCommand({ type: 'start' }); });
    action('next-question')?.addEventListener('click', () => { unlockAudio(); if (state.role === 'host') sendCommand({ type: 'next' }); });
    action('toggle-auto')?.addEventListener('change', (event) => { if (state.role === 'host') sendCommand({ type: 'setAutoAdvance', enabled: event.target.checked }); });
    action('finish-quiz')?.addEventListener('click', () => { if (state.role === 'host') openConfirmation(); });
    action('confirm-finish')?.addEventListener('click', (event) => {
      event.preventDefault();
      unlockAudio();
      if (state.role === 'host') { closeConfirmation(); void sendCommand({ type: 'finish' }); }
    });
    action('cancel-confirm')?.addEventListener('click', closeConfirmation);
    action('copy-code')?.addEventListener('click', copyRoomCode);
    action('share-room')?.addEventListener('click', shareRoom);
    action('new-room')?.addEventListener('click', () => {
      clearFinishedSnapshot();
      clearPersistedSession();
      state.session = null;
      state.snapshot = null;
      state.role = null;
      state.reconnectRejected = false;
      state.reconnectAttempt = 0;
      showScreen('entry');
      setConnection('disconnected', 'Đang kết nối');
      render();
      void loadHistory();
    });
    action('retry')?.addEventListener('click', () => state.session ? connectSocket() : showScreen('entry'));
    byRole('confirm-dialog')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeConfirmation(); });
    action('close-history')?.addEventListener('click', closeHistoryDialog);
    byRole('history-dialog')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeHistoryDialog(); });
    windowRef?.addEventListener?.('keydown', onKeydown);
    // Browsers require a real user gesture before allowing audible playback.
    // Keep retrying on ordinary interactions so a restored room can unlock
    // audio even when its first pointer event was consumed by the browser.
    for (const eventName of ['pointerdown', 'touchstart', 'click', 'keydown']) {
      windowRef?.addEventListener?.(eventName, unlockAudio, { passive: true });
    }
  }

  async function start() {
    bind();
    await loadAudioSettings();
    state.audioEnabled = typeof options.audioEnabled === 'boolean' ? options.audioEnabled : preferredAudio();
    audioManager.setEnabled(state.audioEnabled);
    setConnection('disconnected', 'Đang kết nối');
    const saved = !state.session ? readSessionMetadata(windowRef) : null;
    if (!state.session && !saved) await loadQuizSettings();
    render();
    queueWelcomeVoice();
    void loadHistory();
    if (!state.session) {
      if (saved) {
        const runtime = readRuntimeSession(windowRef);
        state.session = runtime?.roomCode === saved.roomCode && runtime?.playerId === saved.playerId
          ? { ...saved, ...runtime }
          : saved;
        state.audioEnabled = true;
        audioManager.setEnabled(state.audioEnabled);
        setRole(saved.role);
        const finishedSnapshot = readFinishedSnapshot(windowRef, saved);
        if (finishedSnapshot) {
          state.snapshot = finishedSnapshot;
          setConnection('offline', 'Đã khôi phục kết quả đã lưu');
          render();
          return;
        }
        if (hasCapabilityToken(state.session)) {
          try {
            await restoreSessionSnapshot();
            return;
          } catch (error) {
            if (error?.code === 'room_finished' || error?.status === 401) {
              rejectReconnect('Phiên phòng đã kết thúc và không thể khôi phục credential.');
              return;
            }
          }
        }
        setConnection('offline', 'Đã tìm thấy phiên cũ. Vui lòng vào lại phòng để cấp quyền kết nối.');
        text(byRole('error-message'), 'Phiên cũ chỉ lưu thông tin tối thiểu; hãy vào lại phòng để tiếp tục an toàn.');
        showScreen('error');
        render();
      }
      return;
    }
    setRole(state.session.role);
    try {
      await restoreSessionSnapshot();
    } catch (error) {
      if (error?.status === 401 || error?.code === 'invalid_capability' || !hasCapabilityToken(state.session)) {
        rejectReconnect('Phiên phòng đã hết hạn hoặc không hợp lệ. Vui lòng vào lại phòng.');
        return;
      }
      setConnection('reconnecting');
      render();
      connectSocket();
    }
  }

  return {
    state,
    start,
    bind,
    render,
    applyMessage,
    sendCommand,
    submitAnswer,
    persistFinalResult,
    persistFinishedSnapshot,
    copyRoomCode,
    persistSession,
    clearPersistedSession,
    scheduleReconnect,
    connectSocket,
    project: () => projectSnapshot(state.snapshot, state.role, questionBank)
  };
}

if (typeof document !== 'undefined' && document.querySelector('[data-role="quiz-shell"]')) {
  const controller = createQuizController();
  window.quizController = controller;
  controller.start();
}
