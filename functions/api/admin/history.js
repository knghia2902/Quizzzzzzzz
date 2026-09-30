import { getRoomAllocatorStub } from '../quiz/rooms.js';

export async function onRequestDelete(context) {
  return getRoomAllocatorStub(context.env).fetch(new Request('https://quiz-room.internal/history', {
    method: 'DELETE',
    headers: { 'X-Quiz-Internal': 'history-admin-clear' }
  }));
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { Allow: 'DELETE, OPTIONS' } });
}

export async function onRequest(context) {
  if (context.request.method === 'DELETE') return onRequestDelete(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'DELETE, OPTIONS' } });
}
