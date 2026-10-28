const CACHE = 'fieldnotes-shell-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/icon.svg', '/src/app.js', '/src/crdt.js', '/src/store.js', '/src/backup.js', '/src/peer.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('fieldnotes-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  const path = new URL(event.request.url).pathname;
  if (!SHELL.includes(path)) return;
  // Only immutable app-shell assets are cached. Notes never go through HTTP.
  event.respondWith(caches.open(CACHE).then(cache => cache.match(path)).then(cached => cached || fetch(event.request)));
});
