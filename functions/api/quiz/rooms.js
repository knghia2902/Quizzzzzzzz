const MAX_BODY_BYTES = 8 * 1024;
const MAX_TOKEN_LENGTH = 256;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/u;
const PLAYER_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/u;
const TOKEN_PATTERN = /^[A-Fa-f0-9]{64}$/u;
const ROLE_PATTERN = /^(host|player)$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const ROOM_ALLOCATOR_ID = '__quiz_room_allocator__';
const CLASSROOM_JOIN_RATE_LIMIT = 100;

const rateBuckets = new Map();

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

export function errorResponse(error) {
  if (error instanceof ApiError) {
    return jsonResponse({ ok: false, error: error.message, code: error.code }, error.status);
  }
  return jsonResponse({ ok: false, error: 'Dịch vụ quiz tạm thời không khả dụng.', code: 'service_unavailable' }, 503);
}

export function normalizeRoomCode(value) {
  if (typeof value !== 'string') {
    throw new ApiError('Mã phòng không hợp lệ.', 400, 'invalid_room_code');
  }
  const roomCode = value.trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(roomCode)) {
    throw new ApiError('Mã phòng phải gồm đúng 6 ký tự chữ hoặc số.', 400, 'invalid_room_code');
  }
  return roomCode;
}

export function normalizeNickname(value) {
  if (typeof value !== 'string') {
    throw new ApiError('Biệt danh không hợp lệ.', 400, 'invalid_nickname');
  }
  const nickname = value.trim().replace(/\s+/gu, ' ');
  if (!nickname || nickname.length > 32 || CONTROL_CHARACTER_PATTERN.test(nickname)) {
    throw new ApiError('Biệt danh phải dài từ 1 đến 32 ký tự.', 400, 'invalid_nickname');
  }
  return nickname;
}

export function normalizePlayerId(value) {
  if (typeof value !== 'string' || !PLAYER_ID_PATTERN.test(value)) {
    throw new ApiError('Danh tính người chơi không hợp lệ.', 400, 'invalid_player_id');
  }
  return value;
}

export function normalizeCapabilityToken(value, field = 'capabilityToken') {
  if (typeof value !== 'string' || value.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(value)) {
    throw new ApiError(`${field === 'reconnectToken' ? 'Reconnect token' : 'Capability'} không hợp lệ.`, 401, `invalid_${field === 'reconnectToken' ? 'reconnect' : 'capability'}`);
  }
  return value;
}

export function normalizeRole(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ROLE_PATTERN.test(value)) {
    throw new ApiError('Vai trò người chơi không hợp lệ.', 400, 'invalid_role');
  }
  return value;
}

export function requestIp(request) {
  const forwarded = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  return (forwarded.split(',')[0] || 'anonymous').trim().slice(0, 128) || 'anonymous';
}

export function enforceRateLimit(request, { action, roomCode = '', limit = 30, windowMs = 10_000 }) {
  const now = Date.now();
  const key = `${action}:${requestIp(request)}:${roomCode}`;
  const previous = rateBuckets.get(key) || [];
  const recent = previous.filter((timestamp) => timestamp > now - windowMs);
  if (recent.length >= limit) {
    throw new ApiError('Bạn gửi yêu cầu quá nhanh. Vui lòng thử lại sau.', 429, 'rate_limited');
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  if (rateBuckets.size > 2000) {
    for (const [bucketKey, timestamps] of rateBuckets) {
      if (!timestamps.some((timestamp) => timestamp > now - windowMs)) rateBuckets.delete(bucketKey);
    }
  }
}

export async function readJson(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new ApiError('Yêu cầu phải có Content-Type application/json.', 415, 'unsupported_media_type');
  }
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new ApiError('Dữ liệu gửi lên quá lớn.', 413, 'body_too_large');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError('Dữ liệu gửi lên quá lớn.', 413, 'body_too_large');
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not_object');
    return body;
  } catch {
    throw new ApiError('JSON không hợp lệ.', 400, 'invalid_json');
  }
}

export function requireRoomBinding(env) {
  if (!env?.QUIZ_ROOM || typeof env.QUIZ_ROOM.idFromName !== 'function' || typeof env.QUIZ_ROOM.get !== 'function') {
    throw new ApiError('Dịch vụ phòng chơi chưa được cấu hình.', 503, 'missing_room_binding');
  }
  return env.QUIZ_ROOM;
}

export function getRoomStub(env, roomCode) {
  const binding = requireRoomBinding(env);
  try {
    return binding.get(binding.idFromName(roomCode));
  } catch {
    throw new ApiError('Không thể kết nối đến dịch vụ phòng chơi.', 503, 'room_binding_error');
  }
}

export function getRoomAllocatorStub(env) {
  return getRoomStub(env, ROOM_ALLOCATOR_ID);
}

export async function forwardJson(stub, path, payload, method = 'POST') {
  try {
    return await stub.fetch(new Request(`https://quiz-room.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: method === 'GET' ? undefined : JSON.stringify(payload)
    }));
  } catch {
    throw new ApiError('Dịch vụ phòng chơi tạm thời không khả dụng.', 503, 'room_service_unavailable');
  }
}

function assertAction(body) {
  const action = body.type || body.action;
  if (action !== 'create' && action !== 'join') {
    throw new ApiError('Thao tác phòng chơi không hợp lệ.', 400, 'invalid_room_action');
  }
  return action;
}

async function handleCreateOrJoin(context) {
  const { request, env } = context;
  const body = await readJson(request);
  const action = assertAction(body);
  const nickname = normalizeNickname(body.nickname);
  const role = normalizeRole(body.role);
  if (role && role !== (action === 'create' ? 'host' : 'player')) {
    throw new ApiError('Vai trò không khớp với thao tác phòng.', 403, 'role_mismatch');
  }
  let roomCode = null;
  if (action === 'join') {
    roomCode = normalizeRoomCode(body.roomCode);
  } else if (body.roomCode !== undefined) {
    throw new ApiError('Mã phòng được tạo bởi máy chủ.', 400, 'room_code_server_generated');
  }
  enforceRateLimit(request, {
    action,
    roomCode: roomCode || 'new',
    limit: action === 'create' ? 5 : CLASSROOM_JOIN_RATE_LIMIT,
    windowMs: 60_000
  });
  const stub = action === 'create' ? getRoomAllocatorStub(env) : getRoomStub(env, roomCode);
  return forwardJson(
    stub,
    action === 'create' ? '/allocate' : `/rooms/${roomCode}`,
    { type: action, nickname }
  );
}

async function handleSnapshot(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const roomCode = normalizeRoomCode(url.searchParams.get('roomCode'));
  const playerId = normalizePlayerId(url.searchParams.get('playerId'));
  const capabilityToken = normalizeCapabilityToken(url.searchParams.get('capabilityToken'));
  enforceRateLimit(request, { action: 'snapshot', roomCode, limit: 60, windowMs: 60_000 });
  const query = new URLSearchParams({ playerId, capabilityToken });
  if (url.searchParams.get('finished') === '1') query.set('finished', '1');
  return forwardJson(getRoomStub(env, roomCode), `/rooms/${roomCode}?${query.toString()}`, null, 'GET');
}

export async function onRequestPost(context) {
  try {
    return await handleCreateOrJoin(context);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestGet(context) {
  try {
    return await handleSnapshot(context);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Forwarded-For'
    }
  });
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return jsonResponse({ ok: false, error: 'Phương thức không được hỗ trợ.', code: 'method_not_allowed' }, 405, {
    Allow: 'GET, POST, OPTIONS'
  });
}
