// Firebase Messaging Service Worker
// Must be at root of GitHub Pages domain for background push to work
// https://beekindbuzz.github.io/firebase-messaging-sw.js

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

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage(function(payload) {
  console.log('[firebase-messaging-sw.js] Background message received:', payload);

  var title = (payload.notification && payload.notification.title)
    || (payload.data && payload.data.title)
    || 'Beekind Buzz';

  var body = (payload.notification && payload.notification.body)
    || (payload.data && payload.data.body)
    || 'You have pending tasks.';

  self.registration.showNotification(title, {
    body: body,
    icon: 'https://beekindbuzz.github.io/beekind-buzz/icon-192.png',
    badge: 'https://beekindbuzz.github.io/beekind-buzz/icon-192.png',
    tag: 'bk-push',
    vibrate: [200, 100, 200],
    data: { url: 'https://beekindbuzz.github.io/beekind-buzz/Beekind_Buzz_Management_App.html' }
  });
});

// Handle notification click - open the app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url)
    || 'https://beekindbuzz.github.io/beekind-buzz/Beekind_Buzz_Management_App.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
