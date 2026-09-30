import {
  errorResponse,
  enforceRateLimit,
  forwardJson,
  getRoomStub,
  jsonResponse,
  normalizeCapabilityToken,
  normalizePlayerId,
  normalizeRole,
  normalizeRoomCode,
  readJson
} from './quiz/rooms.js';

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await readJson(request);
    const roomCode = normalizeRoomCode(body.roomCode);
    const playerId = normalizePlayerId(body.playerId);
    const capabilityToken = normalizeCapabilityToken(body.capabilityToken);
    const role = normalizeRole(body.role);
    if (role && role !== 'host' && role !== 'player') {
      return jsonResponse({ ok: false, error: 'Vai trò người chơi không hợp lệ.', code: 'invalid_role' }, 400);
    }
    enforceRateLimit(request, { action: 'finalize', roomCode, limit: 10, windowMs: 60_000 });

    // Deliberately discard score, elapsed time, correctness, rank, and any other
    // presentation fields. The room actor authenticates the capability and
    // computes/persists the authoritative final result.
    return await forwardJson(getRoomStub(env, roomCode), `/rooms/${roomCode}`, {
      type: 'finalize',
      playerId,
      capabilityToken
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Forwarded-For'
    }
  });
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return jsonResponse({ ok: false, error: 'Phương thức không được hỗ trợ.', code: 'method_not_allowed' }, 405, {
    Allow: 'POST, OPTIONS'
  });
}
