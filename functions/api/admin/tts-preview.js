import { proxyTts } from './_tts.js';

export async function onRequestPost(context) {
  const body = await context.request.arrayBuffer();
  return proxyTts(context, '/preview', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}
