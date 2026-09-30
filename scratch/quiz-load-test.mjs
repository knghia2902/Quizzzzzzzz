import crypto from 'node:crypto';

const roomCode = String(process.argv[2] || process.env.QUIZ_ROOM || '').trim().toUpperCase();
const baseUrl = String(process.env.QUIZ_BASE_URL || 'http://127.0.0.1:8788').replace(/\/$/u, '');
const DEFAULT_BOT_COUNT = 20;
const MAX_BOT_COUNT = 99;
const EXTRA_BOT_NAME_COUNT = 80;
const countArgument = process.argv.slice(3).find((argument) => /^\d+$/u.test(argument) || /^--count=\d+$/u.test(argument));
const rawPlayerCount = countArgument?.startsWith('--count=')
  ? countArgument.slice('--count='.length)
  : countArgument || process.env.QUIZ_PLAYER_COUNT || String(DEFAULT_BOT_COUNT);
const playerCount = Number(rawPlayerCount);

const seedBotNames = [
  'Ngọc Ánh', 'Bình Luận', 'Hữu Duyên', 'Lê Minh', 'Mai Ly',
  'Nhật Minh', 'Đại Vũ', 'Lý Liên', 'Văn Thanh', 'Anh Vũ',
  'Nguyễn An', 'Minh Anh', 'Quang Huy', 'Phương Thảo', 'Hoàng Nam',
  'Thu Hà', 'Gia Hân', 'Đức Anh', 'Mai Linh', 'Tuấn Kiệt',
  'Thanh Tâm', 'Hải Yến', 'Trung Kiên', 'Lan Anh', 'Mạnh Hùng'
];

const botSurnames = [
  'Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ',
  'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý'
];
const botMiddles = [
  '', 'Minh', 'Ngọc', 'Gia', 'Thanh', 'Quốc', 'Hải', 'Đức',
  'Thùy', 'Phương', 'Khánh', 'Anh'
];
const botGivenNames = [
  'An', 'Bảo', 'Châu', 'Duy', 'Hân', 'Khang', 'Linh', 'Long', 'Mai',
  'My', 'Nam', 'Nhi', 'Phong', 'Quân', 'Trang', 'Tuấn', 'Vy', 'Yến',
  'Tâm', 'Thảo', 'Huy', 'Kiên', 'Lan', 'Sơn', 'Vân', 'Quỳnh', 'Tùng',
  'Đạt', 'Hương', 'Hiếu'
];

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Dùng: node scratch/quiz-load-test.mjs <MÃ_PHÒNG> [SỐ_LƯỢNG_BOT]');
  console.log(`Mặc định: ${DEFAULT_BOT_COUNT} bot; có thể dùng --count=N hoặc QUIZ_PLAYER_COUNT=N.`);
  console.log(`Tool có ${seedBotNames.length + EXTRA_BOT_NAME_COUNT} tên bot và tối đa ${MAX_BOT_COUNT} bot/phòng (chừa 1 chỗ cho chủ phòng).`);
  process.exit(0);
}

if (!/^[A-Z0-9]{6}$/u.test(roomCode)) {
  console.error('Dùng: node scratch/quiz-load-test.mjs <MÃ_PHÒNG> [SỐ_LƯỢNG_BOT]');
  process.exit(1);
}

if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > MAX_BOT_COUNT) {
  console.error(`Số lượng bot phải là số nguyên từ 1 đến ${MAX_BOT_COUNT}.`);
  process.exit(1);
}

function shuffle(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function randomItem(values) {
  return values[crypto.randomInt(values.length)];
}

function createRandomBotNames(count, occupiedNames) {
  const generatedNames = [];
  const names = new Set(occupiedNames);
  let attempts = 0;

  while (generatedNames.length < count && attempts < count * 100) {
    attempts += 1;
    const name = [randomItem(botSurnames), randomItem(botMiddles), randomItem(botGivenNames)]
      .filter(Boolean)
      .join(' ');
    const wordCount = name.split(/\s+/u).length;
    if (wordCount < 2 || wordCount > 3 || names.has(name)) continue;
    names.add(name);
    generatedNames.push(name);
  }

  for (let index = generatedNames.length; index < count; index += 1) {
    let attempt = 0;
    let fallback;
    do {
      fallback = [
        botSurnames[(index + attempt) % botSurnames.length],
        botMiddles[(index * 3 + attempt) % botMiddles.length],
        botGivenNames[(index * 7 + attempt) % botGivenNames.length]
      ].filter(Boolean).join(' ');
      attempt += 1;
    } while (names.has(fallback));

    if (fallback.split(/\s+/u).length < 2 || fallback.split(/\s+/u).length > 3) {
      throw new Error('Không tạo được tên người hợp lệ gồm 2 hoặc 3 chữ.');
    }
    names.add(fallback);
    generatedNames.push(fallback);
  }

  return generatedNames;
}

async function join(nickname) {
  const response = await fetch(`${baseUrl}/api/quiz/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'join', roomCode, nickname })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(`${nickname}: ${response.status} ${payload.error || 'join_failed'}`);
  return payload;
}

function answerDelayMs(snapshot, botIndex, botCount) {
  const questionDurationMs = Math.max(5_000, Number(snapshot.questionDurationSec || 30) * 1_000);
  const startMs = Math.min(500, Math.max(150, Math.round(questionDurationMs * 0.12)));
  const endMs = Math.max(startMs + 250, Math.min(questionDurationMs - 750, Math.round(questionDurationMs * 0.7)));
  const fraction = botCount <= 1 ? 0 : botIndex / (botCount - 1);
  const slotMs = Math.round(startMs + fraction * (endMs - startMs));
  const jitterMs = Math.min(250, Math.max(1, Math.floor((endMs - startMs) / Math.max(botCount, 1))));
  return slotMs + crypto.randomInt(jitterMs + 1);
}

function answerLater(credentials, sentQuestions, managedBotNames, botIndex, botCount) {
  const displayName = String(credentials.player?.displayName || '').trim();
  if (!managedBotNames.has(displayName)) {
    console.warn(`Bỏ qua người chơi ngoài danh sách bot: ${displayName || '(không rõ tên)'}`);
    return null;
  }

  const socketUrl = new URL(`/api/quiz/rooms/${roomCode}/socket`, baseUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  socketUrl.search = new URLSearchParams({
    playerId: credentials.player.playerId,
    capabilityToken: credentials.capabilityToken
  });
  const socket = new WebSocket(socketUrl);
  socket.addEventListener('message', (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    const snapshot = payload.snapshot;
    if (snapshot?.phase === 'finished') {
      socket.close();
      return;
    }
    if (snapshot?.phase !== 'question') return;
    const questionIndex = Number(snapshot.questionIndex);
    if (sentQuestions.has(questionIndex)) return;
    sentQuestions.add(questionIndex);
    const option = ['A', 'B', 'C', 'D'][crypto.randomInt(4)];
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'answer', option }));
    }, answerDelayMs(snapshot, botIndex, botCount));
  });
  return socket;
}

const botNamePool = [
  ...seedBotNames,
  ...createRandomBotNames(EXTRA_BOT_NAME_COUNT, new Set(seedBotNames))
];
const names = shuffle(botNamePool).slice(0, playerCount);
const players = await Promise.all(names.map(async (requestedName) => {
  const credentials = await join(requestedName);
  const displayName = String(credentials.player?.displayName || requestedName).trim();
  return { requestedName, displayName, credentials };
}));
const managedBotNames = new Set(players.map(({ displayName }) => displayName));
console.log(JSON.stringify({
  requested: playerCount,
  joined: players.length,
  botNames: players.map(({ displayName }) => displayName),
  realPlayersIgnored: true
}, null, 2));

const sockets = players
  .map(({ credentials }, index) => answerLater(credentials, new Set(), managedBotNames, index, players.length))
  .filter(Boolean);
console.log('Đã kết nối bot. Hãy bắt đầu phòng từ giao diện chủ phòng. Người chơi ngoài danh sách bot sẽ không bị tự động trả lời.');

await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (sockets.every((socket) => socket.readyState === WebSocket.CLOSED)) {
      clearInterval(timer);
      resolve();
    }
  }, 1000);
});
