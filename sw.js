// Beekind Buzz Service Worker
// Handles: offline caching, push notifications, background sync
const CACHE_VERSION = 'beekind-buzz-v8';
const APP_FILE = './Beekind_Buzz_Management_App.html';
const PRECACHE = [
  './',
  APP_FILE,
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// ── Install: cache all app files ──────────────────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function(cache) {
        // Cache each file individually so one failure doesn't block all
        return Promise.all(
          PRECACHE.map(function(url) {
            return cache.add(url).catch(function(err) {
              console.log('[SW] Failed to cache:', url, err.message);
            });
          })
        );
      })
      .then(function() { return self.skipWaiting(); })
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(
          keys.filter(function(k) { return k !== CACHE_VERSION; })
              .map(function(k) { return caches.delete(k); })
        );
      })
      .then(function() { return self.clients.claim(); })
  );
});

// ── Fetch: serve from cache, fall back to network ────────────────────────────
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Never intercept: Firebase APIs, Google APIs, Anthropic API
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('googleapis.com') ||
      url.includes('gstatic.com') ||
      url.includes('identitytoolkit') ||
      url.includes('anthropic.com') ||
      url.includes('cloudfunctions.net') ||
      url.includes('open-meteo.com') ||
      event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(function(cached) {
        if (cached) {
          // Return cached version immediately
          // Also try to update cache in background (stale-while-revalidate)
          fetch(event.request)
            .then(function(response) {
              if (response && response.ok) {
                caches.open(CACHE_VERSION)
                  .then(function(cache) { cache.put(event.request, response); });
              }
            })
            .catch(function() {}); // Ignore network errors in background
          return cached;
        }
        // Not in cache - try network
        return fetch(event.request)
          .then(function(response) {
            if (response && response.ok && url.includes('beekindbuzz.github.io')) {
              var clone = response.clone();
              caches.open(CACHE_VERSION)
                .then(function(cache) { cache.put(event.request, clone); });
            }
            return response;
          })
          .catch(function() {
            // Network failed - serve app shell for navigation requests
            if (event.request.mode === 'navigate' ||
                event.request.destination === 'document') {
              return caches.match(APP_FILE);
            }
          });
      })
  );
});

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Beekind Buzz \uD83D\uDC1D', {
      body: data.body || 'You have a task due',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: data.tag || 'beekind',
      data: { url: data.url || './' },
      vibrate: [200, 100, 200],
    })
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || APP_FILE;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(list) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].url.includes('beekindbuzz.github.io') && 'focus' in list[i]) {
            return list[i].focus();
          }
        }
        return clients.openWindow(target);
      })
  );
});

// ── Firebase Messaging (background push via FCM) ─────────────────────────────
try {
  importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: "AIzaSyAz6xxvhmT1549z99U4SoUz5raC7x4XV1w",
    authDomain: "beekind-buzz-management-app.firebaseapp.com",
    projectId: "beekind-buzz-management-app",
    storageBucket: "beekind-buzz-management-app.firebasestorage.app",
    messagingSenderId: "579524120402",
    appId: "1:579524120402:web:0d539aa542d5baa6be348b"
  });
  var messaging = firebase.messaging();
  messaging.onBackgroundMessage(function(payload) {
    var n = payload.notification || {};
    self.registration.showNotification(n.title || 'Beekind Buzz', {
      body: n.body || 'You have a task due',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: 'bk-fcm'
    });
  });
} catch(e) {
  console.log('[SW] Firebase messaging init failed:', e.message);
}
