import { proxyTts } from './_tts.js';

export async function onRequestDelete(context) {
  const body = await context.request.text();
  return proxyTts(context, '/elevenlabs-account', {
    method: 'DELETE',
    body: body || '{}',
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { Allow: 'DELETE, OPTIONS' } });
}

export async function onRequest(context) {
  if (context.request.method === 'DELETE') return onRequestDelete(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'DELETE, OPTIONS' } });
}
