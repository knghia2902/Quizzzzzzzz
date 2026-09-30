import {
  ApiError,
  errorResponse,
  enforceRateLimit,
  getRoomAllocatorStub,
  jsonResponse
} from './quiz/rooms.js';

export async function onRequestGet(context) {
  try {
    enforceRateLimit(context.request, { action: 'history', roomCode: 'all', limit: 30, windowMs: 60_000 });
    return await getRoomAllocatorStub(context.env).fetch(new Request('https://quiz-room.internal/history', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    }));
  } catch (error) {
    return errorResponse(error instanceof ApiError ? error : new ApiError('Không thể tải lịch sử ván chơi.', 503, 'history_unavailable'));
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Forwarded-For'
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
