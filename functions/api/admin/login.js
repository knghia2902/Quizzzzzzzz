import { createAdminCookie } from '../../admin-auth.js';
import { proxyTts } from './_tts.js';

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json', message: 'Dữ liệu đăng nhập không hợp lệ.' }, { status: 400 });
  }

  const localResponse = await proxyTts(context, '/admin-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: body?.username, password: body?.password }),
  });
  const result = await localResponse.json().catch(() => ({}));
  if (!localResponse.ok) return Response.json(result, { status: localResponse.status, headers: { 'cache-control': 'no-store' } });

  return Response.json({ ok: true, username: result.username, mustChange: Boolean(result.must_change) }, {
    headers: {
      'Cache-Control': 'no-store',
      'Set-Cookie': await createAdminCookie(context.request, context.env, result.username, Boolean(result.must_change)),
    },
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
