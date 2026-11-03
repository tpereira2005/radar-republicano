// Service worker do Radar R: mostra as notificações push e abre o site ao tocar.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Radar R', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Radar R', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag, // sem tag, o Chrome recusa renotify
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
    for (const c of list) {
      if (c.url.startsWith(self.location.origin) && 'focus' in c) {
        if (c.url !== url && 'navigate' in c) { try { await c.navigate(url); } catch (err) { /* separador não controlado */ } }
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
