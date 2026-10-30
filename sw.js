// Dedicated push-only scope: does not intercept the DSH shell or any fetch.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch { /* Show a safe fallback. */ }
    await self.registration.showNotification(String(data.title || 'DSH').slice(0, 120), {
      body: String(data.body || '任务状态已改变 / Task status changed').slice(0, 300),
      tag: String(data.tag || 'dsh-notifications').slice(0, 160),
      icon: '/dsh-notifications/icon.svg',
      data: { url: '/' },
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow('/');
  })());
});
