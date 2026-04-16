// Beekind Buzz Service Worker
const CACHE_NAME = 'beekind-buzz-v1';
const APP_URL = 'Beekind_Buzz_Management_App.html';

// Files to cache for offline use
const PRECACHE = [
  './',
  './Beekind_Buzz_Management_App.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE.filter(url => !url.includes('icon')));
    }).catch(err => console.log('Cache install error:', err))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: serve from cache, fall back to network
self.addEventListener('fetch', event => {
  // Don't intercept Firebase/Google API calls - they need live network
  const url = event.request.url;
  if (url.includes('firebase') || 
      url.includes('googleapis') || 
      url.includes('gstatic') ||
      url.includes('fonts.g') ||
      url.includes('identitytoolkit') ||
      url.includes('firestore')) {
    return; // Let network handle it
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for our own files
        if (response.ok && event.request.method === 'GET' && 
            url.includes('beekindbuzz.github.io')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for HTML pages
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
  const title = data.title || 'Beekind Buzz';
  const options = {
    body: data.body || 'You have a task due',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'beekind-notification',
    data: data.url || './',
    actions: [
      { action: 'open', title: 'Open app' },
      { action: 'dismiss', title: 'Dismiss' }
    ],
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('beekindbuzz.github.io') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('./Beekind_Buzz_Management_App.html');
    })
  );
});
