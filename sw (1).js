// Beekind Buzz Service Worker v2
const CACHE_NAME = 'beekind-buzz-v2';
const PRECACHE = [
  './',
  './Beekind_Buzz_Management_App.html',
  './manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE).catch(()=>{}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = event.request.url;
  // Pass through Firebase, Google APIs and fonts - never cache these
  if (url.includes('firebase') || url.includes('googleapis') ||
      url.includes('gstatic') || url.includes('identitytoolkit') ||
      url.includes('firestore') || url.includes('fonts.g')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET' &&
            url.includes('beekindbuzz.github.io')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        if (event.request.destination === 'document') {
          return caches.match('./Beekind_Buzz_Management_App.html');
        }
      });
    })
  );
});

// Push notifications
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || 'Beekind Buzz', {
    body: data.body || 'You have a task due',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'beekind',
    data: data.url || './',
    vibrate: [200, 100, 200],
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      for (const c of list) {
        if (c.url.includes('beekindbuzz.github.io') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('./Beekind_Buzz_Management_App.html');
    })
  );
});
