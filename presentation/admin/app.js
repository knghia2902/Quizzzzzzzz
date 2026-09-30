const root = document;
const $ = (selector) => root.querySelector(selector);
const status = $('[data-role="status"]');
const settingsPanel = $('[data-role="settings"]');
const settingsForm = $('[data-role="settings-form"]');
const previewForm = $('[data-role="preview-form"]');
const previewAudio = $('[data-role="preview-audio"]');
const quizSettingsPanel = $('[data-role="quiz-settings"]');
const quizSettingsForm = $('[data-role="quiz-settings-form"]');
const questionSetsPanel = $('[data-role="question-sets"]');
const activeQuestionSetSelect = $('[data-role="active-question-set"]');
const questionSetPickerTrigger = $('[data-role="question-set-picker-trigger"]');
const questionSetPickerMenu = $('[data-role="question-set-picker-menu"]');
const questionSetList = $('[data-role="question-set-list"]');
const questionSetModal = $('[data-role="question-set-modal"]');
const questionSetEditorForm = $('[data-role="question-set-editor-form"]');
const questionSetFile = $('[data-role="question-set-file"]');
const questionEditorList = $('[data-role="question-editor-list"]');
const questionSetEditorStatus = $('[data-role="question-set-editor-status"]');
const questionSetCount = $('[data-role="question-set-count"]');
const elevenLabsStatusCard = $('[data-role="elevenlabs-status-card"]');
const elevenLabsAccountList = $('[data-role="elevenlabs-account-list"]');
const engineSettings = [...root.querySelectorAll('[data-engine-settings]')];
const engineSelect = settingsForm?.elements.namedItem('engine');
const engineSelectTrigger = $('[data-role="engine-select-trigger"]');
const engineSelectMenu = $('[data-role="engine-select-menu"]');
const engineSelectOptions = [...root.querySelectorAll('[data-engine-option]')];
const settingsSelects = {
  voice: {
    select: settingsForm?.elements.namedItem('elevenlabs_voice_id'),
    trigger: $('[data-role="voice-select-trigger"]'),
    menu: $('[data-role="voice-select-menu"]')
  },
  model: {
    select: settingsForm?.elements.namedItem('elevenlabs_model_id'),
    trigger: $('[data-role="model-select-trigger"]'),
    menu: $('[data-role="model-select-menu"]')
  }
};

let previewUrl = null;
let questionSets = [];
let editorQuestions = [];
let editorMode = 'create';
let editorSetId = null;
const VOLUME_KEYS = ['master', 'music', 'correct', 'incorrect', 'welcome', 'roomReady', 'finalResults', 'dynamicVoice'];

function setStatus(message, state = '') {
  if (!status) return;
  status.hidden = !message;
  status.textContent = message;
  status.dataset.state = state;
}

function headers(extra = {}) {
  return { ...extra };
}

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: headers(init.headers || {}) });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) {
    if (response.status === 401) {
      window.location.replace('/admin');
    }
    const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function fillSettings(values) {
  for (const [name, value] of Object.entries(values)) {
    const input = settingsForm.elements.namedItem(name);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
  }
  for (const key of VOLUME_KEYS) {
    const input = root.querySelector(`[data-volume-input="${key}"]`);
    const output = root.querySelector(`[data-volume-output="${key}"]`);
    const value = Number(values.audio_volume?.[key]);
    if (input && Number.isFinite(value)) input.value = String(value);
    if (output && Number.isFinite(value)) output.value = `${Math.round(value)}%`;
    if (output && Number.isFinite(value)) output.textContent = `${Math.round(value)}%`;
  }
  const referenceState = $('[data-role="reference-state"]');
  const endpoint = $('[data-role="endpoint"]');
  if (referenceState) referenceState.textContent = values.reference_exists ? 'Đã tìm thấy file mẫu' : 'Thiếu file mẫu';
  if (endpoint) endpoint.textContent = values.engine === 'elevenlabs' ? 'Tích hợp trong Quiz' : '127.0.0.1:8786';
  const cloneSpeed = settingsForm.elements.namedItem('clone_speed');
  if (cloneSpeed) cloneSpeed.value = values.speed;
  syncSettingsSelect('voice', values.elevenlabs_voice_id);
  syncSettingsSelect('model', values.elevenlabs_model_id);
  updateEngineSettings(values.engine);
}

function syncSettingsSelect(kind, value) {
  const control = settingsSelects[kind];
  if (!control?.select || !control.trigger) return;
  const requested = String(value || control.select.value || '').trim();
  let option = [...control.select.options].find((item) => item.value === requested);
  if (!option && requested) {
    option = document.createElement('option');
    option.value = requested;
    option.textContent = kind === 'voice' ? 'Giọng đang dùng' : 'Mô hình đang dùng';
    control.select.append(option);
  }
  option ||= control.select.options[0];
  if (!option) return;
  control.select.value = option.value;
  control.trigger.textContent = option.textContent;
  control.menu?.querySelectorAll('[data-settings-option]').forEach((item) => {
    item.setAttribute('aria-selected', String(item.dataset.value === option.value));
  });
}

function setSettingsOptions(kind, items, fallbackLabel) {
  const control = settingsSelects[kind];
  if (!control?.select || !control.menu) return;
  const currentValue = control.select.value;
  const normalized = Array.isArray(items)
    ? items.filter((item) => item?.value && item?.label).map((item) => ({ value: String(item.value), label: String(item.label) }))
    : [];
  if (currentValue && !normalized.some((item) => item.value === currentValue)) {
    normalized.unshift({ value: currentValue, label: fallbackLabel });
  }
  control.select.replaceChildren();
  control.menu.replaceChildren();
  normalized.forEach(({ value, label }) => {
    const nativeOption = document.createElement('option');
    nativeOption.value = value;
    nativeOption.textContent = label;
    control.select.append(nativeOption);
    const menuOption = document.createElement('button');
    menuOption.type = 'button';
    menuOption.className = 'settings-select-option';
    menuOption.setAttribute('role', 'option');
    menuOption.dataset.settingsOption = kind;
    menuOption.dataset.value = value;
    menuOption.textContent = label;
    control.menu.append(menuOption);
  });
  syncSettingsSelect(kind, currentValue);
}

function closeSettingsMenus() {
  Object.values(settingsSelects).forEach(({ menu, trigger }) => {
    if (!menu || !trigger) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  });
}

Object.entries(settingsSelects).forEach(([kind, control]) => {
  control.trigger?.addEventListener('click', () => {
    closeEngineMenu();
    const isOpen = !control.menu.hidden;
    closeSettingsMenus();
    control.menu.hidden = isOpen;
    control.trigger.setAttribute('aria-expanded', String(!isOpen));
  });
  control.menu?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-settings-option]');
    if (!option) return;
    if (!control.select) return;
    syncSettingsSelect(kind, option.dataset.value);
    control.select.dispatchEvent(new Event('change', { bubbles: true }));
    closeSettingsMenus();
  });
});

function updateEngineSettings(engine) {
  syncEngineSelector(engine);
  for (const panel of engineSettings) {
    panel.hidden = panel.dataset.engineSettings === 'elevenlabs' ? engine !== 'elevenlabs' : engine === 'elevenlabs';
  }
}

function syncEngineSelector(value) {
  if (!engineSelect || !engineSelectTrigger) return;
  const option = [...engineSelect.options].find((item) => item.value === value) || engineSelect.options[0];
  if (!option) return;
  engineSelect.value = option.value;
  engineSelectTrigger.textContent = option.textContent;
  for (const item of engineSelectOptions) item.setAttribute('aria-selected', String(item.dataset.engineOption === option.value));
}

function closeEngineMenu() {
  if (!engineSelectMenu || !engineSelectTrigger) return;
  engineSelectMenu.hidden = true;
  engineSelectTrigger.setAttribute('aria-expanded', 'false');
}

function closeQuestionSetMenu() {
  if (!questionSetPickerMenu || !questionSetPickerTrigger) return;
  questionSetPickerMenu.hidden = true;
  questionSetPickerTrigger.setAttribute('aria-expanded', 'false');
}

engineSelectTrigger?.addEventListener('click', () => {
  const isOpen = !engineSelectMenu.hidden;
  engineSelectMenu.hidden = isOpen;
  engineSelectTrigger.setAttribute('aria-expanded', String(!isOpen));
});
engineSelectOptions.forEach((option) => option.addEventListener('click', () => {
  if (!engineSelect) return;
  engineSelect.value = option.dataset.engineOption;
  engineSelect.dispatchEvent(new Event('change', { bubbles: true }));
  closeEngineMenu();
}));
document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-role="engine-select"]')) closeEngineMenu();
  if (!event.target.closest('.settings-select')) closeSettingsMenus();
  if (!event.target.closest('[data-role="question-set-picker"]')) closeQuestionSetMenu();
});

questionSetPickerTrigger?.addEventListener('click', () => {
  const isOpen = !questionSetPickerMenu.hidden;
  questionSetPickerMenu.hidden = isOpen;
  questionSetPickerTrigger.setAttribute('aria-expanded', String(!isOpen));
});

async function loadSettings() {
  setStatus('Đang đọc cấu hình service…');
  try {
    const result = await api('/api/admin/tts-settings');
    fillSettings(result.settings);
    settingsPanel.hidden = false;
    settingsForm.removeAttribute('aria-busy');
    setStatus('');
  } catch (error) {
    settingsPanel.hidden = true;
    setStatus(error.status === 401 ? 'Launcher chưa kết nối quyền quản trị. Hãy chạy start-quiz.ps1.' : (error.message || 'Không đọc được cấu hình.'), 'error');
  }
}

async function loadElevenLabsOptions() {
  try {
    const result = await api('/api/admin/elevenlabs-options');
    const voices = (result.voices || []).map((item) => ({ value: item.voice_id, label: item.name }));
    const currentVoiceId = String(result.current_voice_id || '').trim();
    if (currentVoiceId && !voices.some((item) => item.value === currentVoiceId)) {
      voices.unshift({ value: currentVoiceId, label: `Giọng đang dùng · ${currentVoiceId}` });
    }
    setSettingsOptions('voice', voices, 'Giọng đang dùng');
    const models = (result.models || []).map((item) => ({ value: item.model_id, label: item.name }));
    setSettingsOptions('model', models, 'Mô hình đang dùng');
  } catch {
    // Keep the compact built-in options when the ElevenLabs catalog is unavailable.
  }
}

function fillQuizSettings(values) {
  const input = quizSettingsForm?.elements.namedItem('questionDurationSec');
  if (input) input.value = values.questionDurationSec;
  questionSets = Array.isArray(values.questionSets) ? values.questionSets : [];
  renderQuestionSets(values.activeQuestionSetId);
}

function renderQuestionSets(activeId = activeQuestionSetSelect?.value) {
  if (!activeQuestionSetSelect) return;
  activeQuestionSetSelect.replaceChildren();
  for (const set of questionSets) {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = set.name;
    activeQuestionSetSelect.append(option);
  }
  if (questionSets.some((set) => set.id === activeId)) activeQuestionSetSelect.value = activeId;
  else if (questionSets[0]) activeQuestionSetSelect.value = questionSets[0].id;

  const activeSet = questionSets.find((set) => set.id === activeQuestionSetSelect.value);
  if (questionSetPickerTrigger) {
    questionSetPickerTrigger.textContent = activeSet?.name || 'Chưa có bộ câu hỏi';
    questionSetPickerTrigger.disabled = !questionSets.length;
    questionSetPickerTrigger.setAttribute('aria-disabled', String(!questionSets.length));
  }
  if (questionSetPickerMenu) {
    questionSetPickerMenu.replaceChildren();
    if (!questionSets.length) questionSetPickerMenu.hidden = true;
    for (const set of questionSets) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'question-set-picker-option';
      option.setAttribute('role', 'option');
      option.dataset.questionSetOption = set.id;
      option.setAttribute('aria-selected', String(set.id === activeQuestionSetSelect.value));
      option.textContent = set.name;
      option.addEventListener('click', () => {
        activeQuestionSetSelect.value = set.id;
        renderQuestionSets(set.id);
        closeQuestionSetMenu();
        activeQuestionSetSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      questionSetPickerMenu.append(option);
    }
  }

  if (questionSetList) {
    questionSetList.replaceChildren();
    if (!questionSets.length) {
      const empty = document.createElement('li');
      empty.className = 'question-set-empty';
      empty.textContent = 'Chưa có bộ câu hỏi. Hãy tạo mới hoặc import file Excel.';
      questionSetList.append(empty);
    }
    for (const set of questionSets) {
      const item = document.createElement('li');
      item.className = 'question-set-item';
      const title = document.createElement('strong');
      title.textContent = set.name;
      const meta = document.createElement('span');
      meta.className = 'question-set-item-meta';
      meta.textContent = `${Array.isArray(set.questions) ? set.questions.length : 0} câu hỏi`;
      const actions = document.createElement('div');
      actions.className = 'question-set-item-actions';
      if (set.id === activeQuestionSetSelect.value) {
        const active = document.createElement('span');
        active.className = 'question-set-active';
        active.textContent = 'Đang dùng';
        actions.append(active);
      } else {
        const use = document.createElement('button');
        use.type = 'button';
        use.className = 'secondary-button';
        use.dataset.questionSetId = set.id;
        use.textContent = 'Dùng bộ này';
        actions.append(use);
      }
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'question-set-icon-button';
      edit.dataset.questionSetEdit = set.id;
      edit.setAttribute('aria-label', `Sửa bộ ${set.name}`);
      edit.title = 'Sửa bộ';
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.8 3.8 3.8-.8L18.7 7.8a2.1 2.1 0 0 0-3-3L4 16.5Z"></path><path d="m14.6 6.4 3 3"></path></svg>';
      actions.append(edit);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'question-set-icon-button question-set-delete-button';
      remove.dataset.questionSetDelete = set.id;
      remove.setAttribute('aria-label', `Xóa bộ ${set.name}`);
      remove.title = 'Xóa bộ';
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="m6 7 .8 13h10.4L18 7"></path><path d="M9 7V4h6v3"></path></svg>';
      actions.append(remove);
      item.append(title, meta, actions);
      questionSetList.append(item);
    }
  }
}

function selectedQuestionSet() {
  return questionSets.find((set) => set.id === activeQuestionSetSelect?.value) || questionSets[0] || null;
}

function blankQuestion(index = editorQuestions.length) {
  return {
    id: `q${String(index + 1).padStart(2, '0')}`,
    prompt: '',
    options: { A: '', B: '', C: '', D: '' },
    correctOption: 'A',
    explanation: ''
  };
}

function setEditorStatus(message, state = '') {
  if (!questionSetEditorStatus) return;
  questionSetEditorStatus.textContent = message;
  questionSetEditorStatus.dataset.state = state;
}

function renderQuestionEditor() {
  if (!questionEditorList) return;
  questionEditorList.replaceChildren();
  editorQuestions.forEach((question, index) => {
    const card = document.createElement('article');
    card.className = 'question-editor-card';
    card.dataset.questionIndex = String(index);

    const heading = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = `Câu ${index + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button question-remove-button';
    remove.dataset.action = 'remove-question';
    remove.dataset.questionIndex = String(index);
    remove.textContent = 'Xóa câu';
    remove.disabled = editorQuestions.length <= 1;
    heading.append(title, remove);

    const prompt = document.createElement('label');
    prompt.textContent = 'Nội dung câu hỏi';
    const promptInput = document.createElement('textarea');
    promptInput.rows = 2;
    promptInput.required = true;
    promptInput.dataset.field = 'prompt';
    promptInput.value = question.prompt || '';
    prompt.append(promptInput);

    const options = document.createElement('div');
    options.className = 'question-options-grid';
    for (const answer of ['A', 'B', 'C', 'D']) {
      const optionLabel = document.createElement('label');
      optionLabel.textContent = `Đáp án ${answer}`;
      const optionInput = document.createElement('input');
      optionInput.type = 'text';
      optionInput.required = true;
      optionInput.dataset.field = `option-${answer}`;
      optionInput.value = question.options?.[answer] || '';
      optionLabel.append(optionInput);
      options.append(optionLabel);
    }

    const footer = document.createElement('div');
    footer.className = 'question-editor-footer';
    const correctLabel = document.createElement('label');
    correctLabel.textContent = 'Đáp án đúng';
    const correctInput = document.createElement('select');
    correctInput.dataset.field = 'correctOption';
    for (const answer of ['A', 'B', 'C', 'D']) {
      const option = document.createElement('option');
      option.value = answer;
      option.textContent = answer;
      option.selected = answer === question.correctOption;
      correctInput.append(option);
    }
    correctLabel.append(correctInput);
    const explanationLabel = document.createElement('label');
    explanationLabel.textContent = 'Giải thích';
    const explanationInput = document.createElement('textarea');
    explanationInput.rows = 2;
    explanationInput.required = true;
    explanationInput.dataset.field = 'explanation';
    explanationInput.value = question.explanation || '';
    explanationLabel.append(explanationInput);
    footer.append(correctLabel, explanationLabel);
    card.append(heading, prompt, options, footer);
    questionEditorList.append(card);
  });
  if (questionSetCount) questionSetCount.textContent = `${editorQuestions.length}/20 câu`;
}

function collectEditorQuestions() {
  return [...root.querySelectorAll('.question-editor-card')].map((card, index) => ({
    id: editorQuestions[index]?.id || `q${String(index + 1).padStart(2, '0')}`,
    prompt: card.querySelector('[data-field="prompt"]')?.value.trim() || '',
    options: Object.fromEntries(['A', 'B', 'C', 'D'].map((answer) => [answer, card.querySelector(`[data-field="option-${answer}"]`)?.value.trim() || ''])),
    correctOption: card.querySelector('[data-field="correctOption"]')?.value || 'A',
    explanation: card.querySelector('[data-field="explanation"]')?.value.trim() || ''
  }));
}

function openQuestionSetEditor(mode = 'create', set = null) {
  if (!questionSetModal || !questionSetEditorForm) return;
  editorMode = mode;
  const nameInput = questionSetEditorForm.elements.namedItem('questionSetName');
  nameInput.value = mode === 'edit' && set ? set.name : '';
  nameInput.placeholder = mode === 'edit' ? 'Tên bộ câu hỏi' : 'Tên bộ câu hỏi mới';
  editorSetId = mode === 'edit' && set ? set.id : null;
  editorQuestions = (set?.questions || [blankQuestion()]).map((question, index) => ({
    id: question.id || `q${String(index + 1).padStart(2, '0')}`,
    prompt: question.prompt || '',
    options: { A: question.options?.A || '', B: question.options?.B || '', C: question.options?.C || '', D: question.options?.D || '' },
    correctOption: question.correctOption || 'A',
    explanation: question.explanation || ''
  }));
  renderQuestionEditor();
  setEditorStatus('');
  questionSetModal.hidden = false;
  document.body.classList.add('modal-open');
  questionSetEditorForm.elements.namedItem('questionSetName')?.focus();
}

function closeQuestionSetEditor() {
  if (!questionSetModal) return;
  questionSetModal.hidden = true;
  document.body.classList.remove('modal-open');
}

function parseQuestionSetDraft(nameValue, questions, existingId = null) {
  const name = String(nameValue || '').trim();
  if (!name) throw new Error('Hãy nhập tên bộ câu hỏi.');
  if (!Array.isArray(questions) || questions.length !== 20) throw new Error('Bộ câu hỏi phải có đúng 20 câu.');
  const seenIds = new Set();
  for (const [index, question] of questions.entries()) {
    if (!question?.prompt || !question?.explanation || !/^[ABCD]$/u.test(String(question.correctOption || '').toUpperCase())) {
      throw new Error(`Câu ${index + 1} thiếu nội dung, đáp án đúng hoặc giải thích.`);
    }
    if (seenIds.has(question.id)) throw new Error(`ID câu ${index + 1} bị trùng.`);
    seenIds.add(question.id);
    for (const answer of ['A', 'B', 'C', 'D']) {
      if (!question.options?.[answer]) throw new Error(`Câu ${index + 1} thiếu đáp án ${answer}.`);
    }
  }
  const id = existingId || `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    name,
    questions: questions.map((question, index) => ({
      id: String(question.id || `q${String(index + 1).padStart(2, '0')}`),
      prompt: String(question.prompt).trim(),
      options: Object.fromEntries(['A', 'B', 'C', 'D'].map((answer) => [answer, String(question.options[answer]).trim()])),
      correctOption: String(question.correctOption).trim().toUpperCase(),
      explanation: String(question.explanation).trim()
    }))
  };
}

function normalizedHeader(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '');
}

function parseDelimited(text) {
  const source = String(text || '').replace(/^\uFEFF/u, '');
  const delimiter = source.split(/\r?\n/u)[0].includes('\t') ? '\t' : source.split(/\r?\n/u)[0].includes(';') ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"' && quoted && next === '"') { cell += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === delimiter && !quoted) { row.push(cell.trim()); cell = ''; continue; }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(cell.trim()); cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += character;
  }
  if (cell || row.length) { row.push(cell.trim()); if (row.some((value) => value !== '')) rows.push(row); }
  return rows;
}

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

async function readXlsxEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (u32(view, offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error('File Excel không có cấu trúc XLSX hợp lệ.');
  const total = u16(view, end + 10);
  const directoryOffset = u32(view, end + 16);
  const entries = new Map();
  for (let index = 0, offset = directoryOffset; index < total; index += 1) {
    if (u32(view, offset) !== 0x02014b50) throw new Error('Không đọc được danh sách file trong Excel.');
    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const compressed = bytes.slice(localOffset + 30 + localNameLength + localExtraLength, localOffset + 30 + localNameLength + localExtraLength + compressedSize);
    if (method !== 0 && method !== 8) throw new Error('Excel dùng kiểu nén chưa được hỗ trợ.');
    const content = method === 8
      ? new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
      : compressed;
    entries.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlText(bytes) { return new TextDecoder().decode(bytes); }

async function readXlsxRows(file) {
  const entries = await readXlsxEntries(await file.arrayBuffer());
  const workbook = new DOMParser().parseFromString(xmlText(entries.get('xl/workbook.xml')), 'application/xml');
  const relationships = new DOMParser().parseFromString(xmlText(entries.get('xl/_rels/workbook.xml.rels')), 'application/xml');
  const sheet = workbook.getElementsByTagName('sheet')[0];
  const relationshipId = sheet?.getAttribute('r:id');
  const relationship = [...relationships.getElementsByTagName('Relationship')].find((item) => item.getAttribute('Id') === relationshipId);
  const target = relationship?.getAttribute('Target') || 'worksheets/sheet1.xml';
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//u, '')}`;
  const sheetXml = new DOMParser().parseFromString(xmlText(entries.get(sheetPath)), 'application/xml');
  const shared = entries.get('xl/sharedStrings.xml');
  const sharedStrings = shared ? [...new DOMParser().parseFromString(xmlText(shared), 'application/xml').getElementsByTagName('si')].map((item) => item.textContent || '') : [];
  const rows = [];
  for (const row of sheetXml.getElementsByTagName('row')) {
    const values = [];
    for (const cell of row.getElementsByTagName('c')) {
      const reference = cell.getAttribute('r') || '';
      const letters = reference.replace(/\d+/gu, '');
      let column = 0;
      for (const character of letters) column = column * 26 + character.charCodeAt(0) - 64;
      column -= 1;
      let value = cell.getElementsByTagName('v')[0]?.textContent || '';
      if (cell.getAttribute('t') === 's') value = sharedStrings[Number(value)] || '';
      if (cell.getAttribute('t') === 'inlineStr') value = cell.getElementsByTagName('is')[0]?.textContent || '';
      values[column] = value;
    }
    rows.push(values.map((value) => String(value ?? '').trim()));
  }
  return rows;
}

function rowsToQuestions(rows) {
  if (!rows.length) throw new Error('File không có dữ liệu.');
  const headers = rows[0].map(normalizedHeader);
  const findColumn = (aliases) => headers.findIndex((header) => aliases.includes(header));
  const columns = {
    id: findColumn(['id', 'macauhoi', 'cauid']),
    prompt: findColumn(['prompt', 'question', 'cauhoi', 'noidung', 'noidungcauhoi']),
    A: findColumn(['a', 'dapana', 'optiona', 'answera']),
    B: findColumn(['b', 'dapanb', 'optionb', 'answerb']),
    C: findColumn(['c', 'dapanc', 'optionc', 'answerc']),
    D: findColumn(['d', 'dapand', 'optiond', 'answerd']),
    correctOption: findColumn(['correctoption', 'correct', 'answer', 'dapandung', 'dapandung', 'dapandung']),
    explanation: findColumn(['explanation', 'giaithich', 'giainhap'])
  };
  if (columns.prompt < 0 || columns.A < 0 || columns.B < 0 || columns.C < 0 || columns.D < 0 || columns.correctOption < 0 || columns.explanation < 0) {
    throw new Error('Thiếu cột bắt buộc. Cần có Câu hỏi, A, B, C, D, Đáp án đúng và Giải thích.');
  }
  const dataRows = rows.slice(1).filter((row) => row.some((value) => value));
  if (!dataRows.length) throw new Error('File không có dòng câu hỏi.');
  if (dataRows.length > 20) throw new Error(`File có ${dataRows.length} câu, tối đa là 20 câu.`);
  return dataRows.map((row, index) => {
    let correct = String(row[columns.correctOption] || '').trim().toUpperCase();
    if (!/^[ABCD]$/u.test(correct)) {
      const answerIndex = ['A', 'B', 'C', 'D'].findIndex((answer) => String(row[columns[answer]] || '').trim() === String(row[columns.correctOption] || '').trim());
      correct = answerIndex >= 0 ? ['A', 'B', 'C', 'D'][answerIndex] : correct;
    }
    return {
      id: String(row[columns.id] || `q${String(index + 1).padStart(2, '0')}`).trim(),
      prompt: String(row[columns.prompt] || '').trim(),
      options: { A: String(row[columns.A] || '').trim(), B: String(row[columns.B] || '').trim(), C: String(row[columns.C] || '').trim(), D: String(row[columns.D] || '').trim() },
      correctOption: correct,
      explanation: String(columns.explanation >= 0 ? row[columns.explanation] || '' : '').trim()
    };
  });
}

async function importQuestionSetFile(file) {
  const extension = file.name.toLowerCase().split('.').pop();
  const rows = extension === 'xlsx' ? await readXlsxRows(file) : parseDelimited(await file.text());
  editorQuestions = rowsToQuestions(rows);
  renderQuestionEditor();
  if (editorMode !== 'edit' && !questionSetEditorForm.elements.namedItem('questionSetName').value.trim()) {
    questionSetEditorForm.elements.namedItem('questionSetName').value = file.name.replace(/\.[^.]+$/u, '');
  }
  setEditorStatus(`Đã nhập ${editorQuestions.length}/20 câu từ ${file.name}.${editorQuestions.length === 20 ? '' : ' Hãy thêm đủ 20 câu trước khi lưu.'}`, editorQuestions.length === 20 ? 'ok' : 'error');
}

async function persistQuizSettings(successMessage) {
  const questionDurationSec = Number(new FormData(quizSettingsForm).get('questionDurationSec'));
  if (!Number.isFinite(questionDurationSec) || questionDurationSec < 5 || questionDurationSec > 300) {
    throw new Error('Thời lượng phải từ 5 đến 300 giây.');
  }
  const result = await api('/api/admin/quiz-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionDurationSec, activeQuestionSetId: activeQuestionSetSelect?.value || null, questionSets })
  });
  fillQuizSettings(result.settings);
  setStatus(successMessage, 'ok');
  return result;
}

async function loadQuizSettings() {
  try {
    let result;
    try {
      result = await api('/api/admin/quiz-settings');
    } catch (error) {
      if (![500, 502, 503].includes(error.status)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await api('/api/admin/quiz-settings?retry=1');
    }
    fillQuizSettings(result.settings);
    quizSettingsPanel.hidden = false;
    if (questionSetsPanel) questionSetsPanel.hidden = false;
  } catch (error) {
    quizSettingsPanel.hidden = true;
    if (questionSetsPanel) questionSetsPanel.hidden = true;
    setStatus(error.message || 'Không đọc được cấu hình quiz.', 'error');
  }
}

async function loadAllSettings() {
  await Promise.all([loadSettings(), loadElevenLabsOptions(), loadQuizSettings(), loadElevenLabsStatus()]);
}

async function loadElevenLabsStatus() {
  if (!elevenLabsStatusCard) return;
  elevenLabsStatusCard.hidden = false;
  const pill = $('[data-role="elevenlabs-status-pill"]');
  const message = $('[data-role="elevenlabs-status-message"]');
  const error = $('[data-role="elevenlabs-account-error"]');
  try {
    const result = await api('/api/admin/elevenlabs-status');
    applyElevenLabsStatus(result, { pill, message, error });
  } catch (requestError) {
    if (pill) {
      pill.hidden = false;
      pill.textContent = 'OFFLINE';
      pill.dataset.state = 'error';
    }
    message.textContent = requestError.message || 'Không kiểm tra được ElevenLabs tool.';
    error.hidden = true;
  }
}

function applyElevenLabsStatus(result, { pill, message, error }) {
  const accounts = Array.isArray(result.accounts) ? result.accounts : [];
  const account = accounts.find((item) => item.status !== 'invalid_auth') || accounts[0];
  const ready = result.ok && Number(result.active_accounts) > 0;
  if (pill) {
    pill.hidden = ready;
    pill.textContent = ready ? '' : 'CẦN ĐĂNG NHẬP';
    pill.dataset.state = ready ? 'ok' : 'error';
  }
  const remaining = Number(result.total_remaining_characters || 0);
  const limit = Number(result.total_character_limit || accounts.reduce((sum, item) => sum + Number(item.character_limit || 0), 0) || 0);
  message.textContent = ready
    ? `Tổng Credit: ${remaining.toLocaleString('vi-VN')} / ${limit.toLocaleString('vi-VN')}`
    : 'Chưa có tài khoản ElevenLabs hợp lệ. Bấm Quét & Lấy Token ngay để cập nhật session.';
  const accountError = account?.error_message || '';
  error.hidden = !accountError;
  error.textContent = accountError ? `Chi tiết: ${accountError}` : '';
  if (elevenLabsAccountList) {
    elevenLabsAccountList.replaceChildren();
    for (const item of accounts) {
      const row = document.createElement('li');
      row.className = 'elevenlabs-account-row';
      const details = document.createElement('div');
      details.className = 'elevenlabs-account-details';
      const name = document.createElement('strong');
      name.textContent = item.name || item.email || 'Tài khoản ElevenLabs';
      const credit = document.createElement('span');
      credit.textContent = item.status === 'invalid_auth'
        ? 'Không khả dụng · cần đăng nhập lại'
        : `${Number(item.remaining_characters || 0).toLocaleString('vi-VN')} / ${Number(item.character_limit || 0).toLocaleString('vi-VN')} credit`;
      details.append(name, credit);
      const actions = document.createElement('div');
      actions.className = 'elevenlabs-account-actions';
      const state = document.createElement('span');
      state.className = 'account-status';
      state.dataset.state = item.status === 'active' ? 'ok' : 'error';
      state.textContent = item.status === 'active' ? 'Hoạt động' : (item.status || 'Chưa kiểm tra');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'account-delete-button';
      remove.dataset.accountId = item.id || '';
      remove.textContent = 'Xóa';
      remove.disabled = !item.id;
      actions.append(state, remove);
      row.append(details, actions);
      elevenLabsAccountList.append(row);
    }
    elevenLabsAccountList.hidden = accounts.length === 0;
  }
}

async function scanElevenLabs() {
  const button = $('[data-action="refresh-elevenlabs"]');
  if (!button) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Đang quét…';
  setStatus('Đang quét session ElevenLabs từ Chrome/Edge trên máy chạy Quiz…');
  try {
    const result = await api('/api/admin/elevenlabs-scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await loadElevenLabsStatus();
    const count = Number(result.scanned_accounts || 0);
    setStatus(count > 0 ? `Đã quét và cập nhật ${count} session ElevenLabs trên máy chạy Quiz.` : 'Đã quét máy chạy Quiz. Không tìm thấy session mới trong Chrome/Edge.', count > 0 ? 'ok' : '');
  } catch (error) {
    setStatus(error.message || 'Không quét được session ElevenLabs.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function addElevenLabsAccount() {
  const button = $('[data-action="add-elevenlabs"]');
  if (!button) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Đang mở…';
  setStatus('Đang mở phiên đăng nhập ElevenLabs riêng…');
  try {
    const result = await api('/api/admin/elevenlabs-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!result.ok) throw new Error(result.message || 'Không mở được phiên đăng nhập ElevenLabs.');
    setStatus('Đã mở cửa sổ ElevenLabs. Đăng nhập tài khoản mới ở đó; Quiz sẽ tự nhận session.');
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep(1500);
      const login = await api('/api/admin/elevenlabs-login-status');
      if (login.state === 'captured') {
        await loadElevenLabsStatus();
        setStatus('Đã thêm tài khoản ElevenLabs mới.', 'ok');
        return;
      }
      if (['error', 'timeout', 'unavailable'].includes(login.state)) {
        throw new Error(login.message || 'Phiên đăng nhập ElevenLabs không hoàn tất.');
      }
    }
    setStatus('Phiên đăng nhập vẫn đang chờ. Nếu đã đăng nhập, bấm Quét để cập nhật danh sách.');
  } catch (error) {
    setStatus(error.message || 'Không thêm được tài khoản ElevenLabs.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function deleteElevenLabsAccount(accountId, button) {
  if (!accountId || !button) return;
  if (!window.confirm('Xóa session ElevenLabs này khỏi Quiz?')) return;
  button.disabled = true;
  setStatus('Đang xóa tài khoản ElevenLabs…');
  try {
    await api('/api/admin/elevenlabs-account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId })
    });
    await loadElevenLabsStatus();
    setStatus('Đã xóa tài khoản ElevenLabs khỏi Quiz.', 'ok');
  } catch (error) {
    button.disabled = false;
    setStatus(error.message || 'Không xóa được tài khoản ElevenLabs.', 'error');
  }
}

async function logout() {
  try {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    window.location.replace('/admin');
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(settingsForm).entries());
  body.audio_volume = Object.fromEntries(VOLUME_KEYS.map((key) => [key, Number(body[`audio_${key}`])]));
  for (const key of VOLUME_KEYS) delete body[`audio_${key}`];
  body.speed = Number(body.engine === 'elevenlabs' ? body.speed : body.clone_speed);
  delete body.clone_speed;
  body.nfe_step = Number(body.nfe_step);
  body.max_chunk_duration = Number(body.max_chunk_duration);
  body.elevenlabs_stability = Number(body.elevenlabs_stability);
  body.elevenlabs_similarity_boost = Number(body.elevenlabs_similarity_boost);
  body.dynamic_voice_enabled = Boolean(settingsForm.elements.namedItem('dynamic_voice_enabled')?.checked);
  setStatus('Đang áp dụng cấu hình…');
  try {
    const result = await api('/api/admin/tts-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    fillSettings(result.settings);
    setStatus('Đã lưu. Cấu hình mới áp dụng cho audio tạo sau đó.', 'ok');
  } catch (error) { setStatus(error.message || 'Không lưu được cấu hình.', 'error'); }
}

async function saveQuizSettings(event) {
  event.preventDefault();
  setStatus('Đang lưu cài đặt quiz…');
  try {
    const result = await persistQuizSettings('Đã lưu cài đặt quiz. Áp dụng cho phòng tạo mới.');
    setStatus(`Đã lưu ${result.settings.questionDurationSec} giây/câu và bộ câu hỏi đang dùng.`, 'ok');
  } catch (error) { setStatus(error.message || 'Không lưu được cài đặt quiz.', 'error'); }
}

async function createQuestionSet(event) {
  event.preventDefault();
  try {
    const formData = new FormData(questionSetEditorForm);
    const isEditing = editorMode === 'edit';
    const draft = parseQuestionSetDraft(formData.get('questionSetName'), collectEditorQuestions(), isEditing ? editorSetId : null);
    if (isEditing) {
      questionSets = questionSets.map((set) => set.id === draft.id ? draft : set);
    } else {
      questionSets = [...questionSets, draft];
    }
    activeQuestionSetSelect.value = draft.id;
    setStatus(`Đang ${isEditing ? 'lưu thay đổi bộ câu hỏi' : 'tạo bộ câu hỏi mới'}…`);
    await persistQuizSettings(`${isEditing ? 'Đã cập nhật' : 'Đã tạo và chọn'} bộ “${draft.name}”.`);
    closeQuestionSetEditor();
  } catch (error) {
    setEditorStatus(error.message || 'Không lưu được bộ câu hỏi.', 'error');
  }
}

async function preview(event) {
  event.preventDefault();
  const text = new FormData(previewForm).get('text')?.toString().trim();
  if (!text) return;
  const currentSettings = Object.fromEntries(new FormData(settingsForm).entries());
  const previewSettings = Object.fromEntries([
    'engine', 'speed', 'nfe_step', 'max_chunk_duration', 'reference_audio', 'reference_text',
    'elevenlabs_voice_id', 'elevenlabs_model_id', 'elevenlabs_language_code', 'elevenlabs_stability', 'elevenlabs_similarity_boost'
  ].filter((key) => currentSettings[key] !== undefined).map((key) => [key, currentSettings[key]]));
  if (currentSettings.engine !== 'elevenlabs' && currentSettings.clone_speed !== undefined) {
    previewSettings.speed = currentSettings.clone_speed;
  }
  setStatus('Đang tạo audio thử…');
  previewAudio.hidden = true;
  try {
    const blob = await api('/api/admin/tts-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...previewSettings }) });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    previewAudio.src = previewUrl;
    previewAudio.hidden = false;
    await previewAudio.play().catch(() => {});
    setStatus(`Đã tạo audio thử theo Speed ${currentSettings.speed || '1.0'}x.`, 'ok');
  } catch (error) { setStatus(error.message || 'Không tạo được audio thử.', 'error'); }
}

settingsForm?.addEventListener('submit', saveSettings);
settingsForm?.elements.namedItem('engine')?.addEventListener('change', (event) => {
  updateEngineSettings(event.target.value);
});
quizSettingsForm?.addEventListener('submit', saveQuizSettings);
questionSetEditorForm?.addEventListener('submit', createQuestionSet);
activeQuestionSetSelect?.addEventListener('change', async () => {
  renderQuestionSets(activeQuestionSetSelect.value);
  setStatus('Đang lưu bộ câu hỏi đang dùng…');
  try { await persistQuizSettings('Đã đổi bộ câu hỏi. Áp dụng cho phòng tạo mới.'); }
  catch (error) { setStatus(error.message || 'Không đổi được bộ câu hỏi.', 'error'); }
});
questionSetList?.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-question-set-edit]');
  if (editButton) {
    const selected = questionSets.find((item) => item.id === editButton.dataset.questionSetEdit);
    if (!selected) return;
    openQuestionSetEditor('edit', selected);
    return;
  }
  const deleteButton = event.target.closest('[data-question-set-delete]');
  if (deleteButton) {
    const setId = deleteButton.dataset.questionSetDelete;
    const set = questionSets.find((item) => item.id === setId);
    if (!set) return;
    if (!window.confirm(`Xóa bộ “${set.name}”? Không thể hoàn tác.`)) return;
    deleteButton.disabled = true;
    setStatus('Đang xóa bộ câu hỏi…');
    const previousQuestionSets = questionSets;
    questionSets = questionSets.filter((item) => item.id !== setId);
    if (activeQuestionSetSelect.value === setId) activeQuestionSetSelect.value = questionSets[0]?.id || '';
    try {
      await persistQuizSettings(`Đã xóa bộ “${set.name}”.`);
    } catch (error) {
      questionSets = previousQuestionSets;
      renderQuestionSets(activeQuestionSetSelect.value);
      setStatus(error.message || 'Không xóa được bộ câu hỏi.', 'error');
    }
    return;
  }
  const button = event.target.closest('[data-question-set-id]');
  if (!button) return;
  activeQuestionSetSelect.value = button.dataset.questionSetId;
  renderQuestionSets(activeQuestionSetSelect.value);
  setStatus('Đang lưu bộ câu hỏi đang dùng…');
  try { await persistQuizSettings('Đã đổi bộ câu hỏi. Áp dụng cho phòng tạo mới.'); }
  catch (error) { setStatus(error.message || 'Không đổi được bộ câu hỏi.', 'error'); }
});
$('[data-action="open-question-set-editor"]')?.addEventListener('click', () => openQuestionSetEditor());
questionSetEditorForm?.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'close-question-set-editor') closeQuestionSetEditor();
  if (action === 'add-question') {
    if (editorQuestions.length >= 20) { setEditorStatus('Bộ đã đủ 20 câu.', 'error'); return; }
    editorQuestions.push(blankQuestion());
    renderQuestionEditor();
  }
  if (action === 'remove-question') {
    const index = Number(event.target.closest('[data-question-index]')?.dataset.questionIndex);
    if (Number.isInteger(index)) { editorQuestions.splice(index, 1); renderQuestionEditor(); }
  }
  if (action === 'import-question-set') questionSetFile?.click();
});
questionSetModal?.addEventListener('click', (event) => {
  if (event.target.matches('.question-set-modal-backdrop')) closeQuestionSetEditor();
});
questionSetModal?.querySelectorAll('[data-action="close-question-set-editor"]').forEach((button) => button.addEventListener('click', closeQuestionSetEditor));
questionSetFile?.addEventListener('change', async () => {
  const file = questionSetFile.files?.[0];
  questionSetFile.value = '';
  if (!file) return;
  try { await importQuestionSetFile(file); }
  catch (error) { setEditorStatus(error.message || 'Không đọc được file Excel.', 'error'); }
});
previewForm?.addEventListener('submit', preview);
for (const input of root.querySelectorAll('[data-volume-input]')) {
  input.addEventListener('input', () => {
    const output = root.querySelector(`[data-volume-output="${input.dataset.volumeInput}"]`);
    if (output) {
      output.value = `${input.value}%`;
      output.textContent = `${input.value}%`;
    }
  });
}
$('[data-action="reload"]')?.addEventListener('click', loadAllSettings);
$('[data-action="logout"]')?.addEventListener('click', logout);
$('[data-action="refresh-elevenlabs"]')?.addEventListener('click', scanElevenLabs);
$('[data-action="add-elevenlabs"]')?.addEventListener('click', addElevenLabsAccount);
elevenLabsAccountList?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-account-id]');
  if (button) void deleteElevenLabsAccount(button.dataset.accountId, button);
});
void loadAllSettings();
