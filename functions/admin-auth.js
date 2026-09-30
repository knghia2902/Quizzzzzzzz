const COOKIE_NAME = 'quiz_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function signature(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}

function getSecret(env) {
  return String(env.QUIZ_ADMIN_SESSION_SECRET || env.QUIZ_TTS_ADMIN_TOKEN || '').trim();
}

function getCookie(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : '';
}

export async function getAdminSession(request, env) {
  const secret = getSecret(env);
  const expectedUser = String(env.QUIZ_ADMIN_USER || '').trim();
  if (!secret || !expectedUser) return { valid: false, mustChange: false, username: '' };

  const parts = getCookie(request).split('.');
  if (parts.length !== 4) return { valid: false, mustChange: false, username: '' };
  const [user, expiry, mustChangeFlag, suppliedSignature] = parts;
  if (user !== expectedUser || Number(expiry) < Math.floor(Date.now() / 1000)) return { valid: false, mustChange: false, username: '' };
  const expectedSignature = await signature(`${user}.${expiry}.${mustChangeFlag}`, secret);
  if (expectedSignature.length !== suppliedSignature.length) return { valid: false, mustChange: false, username: '' };
  let mismatch = 0;
  for (let index = 0; index < expectedSignature.length; index += 1) {
    mismatch |= expectedSignature.charCodeAt(index) ^ suppliedSignature.charCodeAt(index);
  }
  return { valid: mismatch === 0, mustChange: mustChangeFlag === '1', username: user };
}

export async function isAdminAuthenticated(request, env) {
  return (await getAdminSession(request, env)).valid;
}

export async function createAdminCookie(request, env, username, mustChange = false) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const flag = mustChange ? '1' : '0';
  const value = `${username}.${expiry}.${flag}.${await signature(`${username}.${expiry}.${flag}`, getSecret(env))}`;
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearAdminCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}
