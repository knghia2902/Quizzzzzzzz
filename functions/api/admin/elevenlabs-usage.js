import { proxyTts } from './_tts.js';

export async function onRequestGet(context) {
  return proxyTts(context, '/elevenlabs-usage');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { Allow: 'GET, OPTIONS' } });
}
