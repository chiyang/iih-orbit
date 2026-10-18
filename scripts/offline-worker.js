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

// Notification data contains identities only; never navigate to an arbitrary notification URL.
self.addEventListener('notificationclick', event => {
  const target = event.notification.data?.orbitReminder;
  if (!target || target.version !== 1 || !['generation', 'workspaceId', 'itemId'].every(key => typeof target[key] === 'string' && target[key].length > 0 && target[key].length <= 1500)
    || typeof target.sourceContext !== 'string' || target.sourceContext.length > 3000 || !event.notification.tag.startsWith('iih-orbit-start:')) return;
  const safe = {version: 1, generation: target.generation, workspaceId: target.workspaceId, itemId: target.itemId, sourceContext: target.sourceContext};
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const matches = clients.filter(client => client.url.startsWith(self.registration.scope)), client = matches.find(client => client.visibilityState === 'visible') || matches[0];
    if (client) {try {await client.focus(); client.postMessage({type: 'iih-orbit-notification-open', target: safe}); return;} catch { /* The window may have closed after matching. */ }}
    const url = new URL('./', self.registration.scope); url.hash = 'orbit-notification=' + encodeURIComponent(JSON.stringify(safe));
    await self.clients.openWindow(url.href);
  })());
});
