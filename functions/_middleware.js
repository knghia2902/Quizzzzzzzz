import { getAdminSession } from './admin-auth.js';

const ADMIN_AUTH_PATHS = new Set(['/api/admin/login', '/api/admin/logout']);
const PASSWORD_CHANGE_PATH = '/api/admin/change-password';

async function loginPage(context) {
  const loginUrl = new URL('/presentation/admin-login/index.html', context.request.url);
  const response = await context.env.ASSETS.fetch(new Request(loginUrl, context.request));
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/html; charset=UTF-8');
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const isAdminPage = url.pathname === '/admin'
    || url.pathname === '/admin/'
    || url.pathname === '/presentation/admin/'
    || url.pathname === '/presentation/admin/index.html';
  const isAdminApi = url.pathname.startsWith('/api/admin/');
  const isAuthApi = ADMIN_AUTH_PATHS.has(url.pathname);
  const session = await getAdminSession(context.request, context.env);

  if (isAdminPage && (!session.valid || session.mustChange)) return loginPage(context);
  if (isAdminApi && !isAuthApi && !session.valid) {
    return Response.json({ ok: false, error: 'admin_auth_required', message: 'Vui lòng đăng nhập quản trị.' }, { status: 401, headers: { 'cache-control': 'no-store' } });
  }
  if (isAdminApi && session.mustChange && url.pathname !== PASSWORD_CHANGE_PATH) {
    return Response.json({ ok: false, error: 'password_change_required', message: 'Vui lòng đổi mật khẩu quản trị trước.' }, { status: 403, headers: { 'cache-control': 'no-store' } });
  }

  if (url.pathname === '/') {
    const quizUrl = new URL('/presentation/quiz/', url);
    const quizResponse = await context.env.ASSETS.fetch(new Request(quizUrl, context.request));
    if (!quizResponse.ok) return quizResponse;

    const html = (await quizResponse.text()).replace(
      '<head>',
      '<head><base href="/presentation/quiz/">',
    );
    const headers = new Headers(quizResponse.headers);
    headers.set('content-type', 'text/html; charset=UTF-8');
    headers.set('cache-control', 'no-store');
    return new Response(html, { status: quizResponse.status, headers });
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    const adminUrl = new URL('/presentation/admin/index.html', url);
    const adminResponse = await context.env.ASSETS.fetch(new Request(adminUrl, context.request));
    if (!adminResponse.ok) return adminResponse;

    const html = (await adminResponse.text()).replace(
      '<head>',
      '<head><base href="/presentation/admin/">',
    );
    const headers = new Headers(adminResponse.headers);
    headers.set('content-type', 'text/html; charset=UTF-8');
    headers.set('cache-control', 'no-store');
    return new Response(html, { status: adminResponse.status, headers });
  }

  return context.next();
}
