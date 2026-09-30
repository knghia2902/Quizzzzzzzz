import {
  errorResponse,
  getRoomStub,
  normalizeRoomCode
} from '../../../rooms.js';

function roomCodeFromContext(context) {
  const value = context.params?.roomCode || new URL(context.request.url).pathname.split('/').at(-3);
  return normalizeRoomCode(value);
}

export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const roomCode = roomCodeFromContext(context);
    const url = new URL(request.url);
    const target = new URL(`https://quiz-room.internal/rooms/${roomCode}/voice/${encodeURIComponent(context.params?.assetId || '')}`);
    target.search = url.search;
    return await getRoomStub(env, roomCode).fetch(new Request(target, {
      method: 'GET',
      headers: request.headers
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return new Response(JSON.stringify({ ok: false, error: 'Phương thức không được hỗ trợ.', code: 'method_not_allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET' }
  });
}
