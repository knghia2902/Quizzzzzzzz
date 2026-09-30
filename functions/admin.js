export async function onRequest(context) {
  const assetUrl = new URL('/presentation/admin/index.html', context.request.url);
  const asset = await context.env.ASSETS.fetch(new Request(assetUrl, {
    method: 'GET',
    headers: { Accept: 'text/html' },
  }));
  if (!asset.ok) return asset;

  const headers = new Headers(asset.headers);
  headers.set('content-type', 'text/html; charset=UTF-8');
  headers.set('cache-control', 'no-store');
  return new Response(asset.body, { status: 200, headers });
}
