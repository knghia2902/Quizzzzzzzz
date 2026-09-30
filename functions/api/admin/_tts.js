const DEFAULT_TTS_BASE_URL = 'http://127.0.0.1:8786';

export function ttsBaseUrl(env) {
  return String(env.LOCAL_TTS_BASE_URL || DEFAULT_TTS_BASE_URL).trim().replace(/\/$/, '');
}

export function adminToken(request, env) {
  return request.headers.get('X-Admin-Token') || String(env.QUIZ_TTS_ADMIN_TOKEN || '').trim();
}

export async function proxyTts(context, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('X-Admin-Token', adminToken(context.request, context.env));
  headers.set('X-Quiz-Local-Admin', '1');
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  try {
    const response = await fetch(`${ttsBaseUrl(context.env)}${path}`, { ...init, headers });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (error) {
    return Response.json({
      ok: false,
      error: 'tts_unavailable',
      message: 'Không kết nối được service TTS local. Hãy kiểm tra server 8786.',
      detail: String(error?.message || error),
    }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
