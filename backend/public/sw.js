/* Quetza — service worker minimo, solo per installabilità PWA.
   Network-first per tutto: l'app deve sempre mostrare l'ultima versione
   quando c'è connessione — la cache serve solo da fallback per l'avvio
   offline o a connessione molto lenta, mai per bypassare il server mentre
   è raggiungibile (altrimenti un aggiornamento del codice resterebbe
   invisibile finché la cache non viene invalidata). */
const CACHE_VERSION = 'quetza-shell-v1';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Mai intercettare API, callback di autenticazione o note condivise:
  // devono sempre riflettere lo stato reale del server, mai una cache stale.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/share/')) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
