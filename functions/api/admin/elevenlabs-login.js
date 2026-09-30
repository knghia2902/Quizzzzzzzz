import { proxyTts } from './_tts.js';

export async function onRequestPost(context) {
  return proxyTts(context, '/elevenlabs-login', { method: 'POST', body: '{}' });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}
