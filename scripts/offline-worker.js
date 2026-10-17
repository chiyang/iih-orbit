// No skipWaiting: an update must wait until existing editors have closed.
const PREFIX = 'orbit-shell:' + self.registration.scope + ':';
const CACHE = PREFIX + VERSION;
const urls = new Map(ASSETS.map(([path, hash]) => [new URL(path, self.registration.scope).href, hash]));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      // Verify the entire release, including lazy chunks, before declaring it usable.
      for (const [url, expected] of urls) {
        const response = await fetch(new Request(url, {cache: 'reload', credentials: 'same-origin'}));
        if (!response.ok || response.redirected) throw new Error('Offline asset unavailable: ' + url);
        const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
        const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        if (actual !== expected) throw new Error('Offline release changed during installation');
        await cache.put(url, response);
      }
    } catch (error) {await caches.delete(CACHE); throw error;}
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    // Cover the first visit too, so lazy screens work if the network drops without a reload.
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  const shell = request.mode === 'navigate';
  if (!shell && !urls.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const response = await cache.match(shell ? new URL('index.html', self.registration.scope).href : request);
    return response || fetch(request);
  })());
});
