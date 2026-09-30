import {
  errorResponse,
  enforceRateLimit,
  getRoomStub,
  jsonResponse,
  normalizeCapabilityToken,
  normalizePlayerId,
  normalizeRole,
  normalizeRoomCode
} from '../../rooms.js';

const CLASSROOM_SOCKET_RATE_LIMIT = 100;

function roomCodeFromContext(context) {
  const value = context.params?.roomCode || new URL(context.request.url).pathname.split('/').at(-2);
  return normalizeRoomCode(value);
}

export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return jsonResponse({ ok: false, error: 'Yêu cầu phải nâng cấp lên WebSocket.', code: 'websocket_upgrade_required' }, 426);
    }
    const roomCode = roomCodeFromContext(context);
    const url = new URL(request.url);
    const playerId = normalizePlayerId(url.searchParams.get('playerId'));
    const capabilityToken = normalizeCapabilityToken(url.searchParams.get('capabilityToken'));
    const reconnectToken = url.searchParams.get('reconnectToken');
    if (reconnectToken !== null) normalizeCapabilityToken(reconnectToken, 'reconnectToken');
    normalizeRole(url.searchParams.get('role') || undefined);
    enforceRateLimit(request, { action: 'websocket', roomCode, limit: CLASSROOM_SOCKET_RATE_LIMIT, windowMs: 60_000 });

    const target = new URL(`https://quiz-room.internal/rooms/${roomCode}`);
    target.searchParams.set('playerId', playerId);
    target.searchParams.set('capabilityToken', capabilityToken);
    if (reconnectToken !== null) target.searchParams.set('reconnectToken', reconnectToken);
    const headers = new Headers(request.headers);
    headers.set('Upgrade', 'websocket');
    return await getRoomStub(env, roomCode).fetch(new Request(target, {
      method: 'GET',
      headers
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Connection'
    }
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return jsonResponse({ ok: false, error: 'Phương thức không được hỗ trợ.', code: 'method_not_allowed' }, 405, {
    Allow: 'GET, OPTIONS'
  });
}
