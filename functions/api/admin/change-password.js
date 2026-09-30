import { createAdminCookie } from '../../admin-auth.js';
import { proxyTts } from './_tts.js';

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json', message: 'Dữ liệu không hợp lệ.' }, { status: 400 });
  }

  const username = String(body?.username || context.env.QUIZ_ADMIN_USER || '').trim();
  const newPassword = String(body?.newPassword || '');
  if (!newPassword.trim()) {
    return Response.json({ ok: false, error: 'invalid_password', message: 'Mật khẩu mới không được để trống.' }, { status: 400 });
  }

  const localResponse = await proxyTts(context, '/admin-change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, newPassword }),
  });
  const result = await localResponse.json().catch(() => ({}));
  if (!localResponse.ok) return Response.json(result, { status: localResponse.status, headers: { 'cache-control': 'no-store' } });

  return Response.json({ ok: true, username }, {
    headers: {
      'Cache-Control': 'no-store',
      'Set-Cookie': await createAdminCookie(context.request, context.env, username, false),
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
