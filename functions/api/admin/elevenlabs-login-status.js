import { proxyTts } from './_tts.js';

export async function onRequestGet(context) {
  return proxyTts(context, '/elevenlabs-login-status');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { Allow: 'GET, OPTIONS' } });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'GET, OPTIONS' } });
}
