import { getRoomAllocatorStub } from '../quiz/rooms.js';

async function forward(context, method) {
  const body = method === 'PUT' ? await context.request.arrayBuffer() : undefined;
  return getRoomAllocatorStub(context.env).fetch(new Request('https://quiz-room.internal/settings', {
    method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Quiz-Internal': 'admin-settings'
    },
    body
  }));
}

export async function onRequestGet(context) {
  return forward(context, 'GET');
}

export async function onRequestPut(context) {
  return forward(context, 'PUT');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { Allow: 'GET, PUT, OPTIONS' } });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'PUT') return onRequestPut(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'GET, PUT, OPTIONS' } });
}
