import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function worker() {
  const listeners = new Map();
  const notifications = [];
  const opened = [];
  let focused = false;
  const context = { URL, self: {
    location: { origin: 'https://dsh.example' },
    addEventListener: (name, fn) => listeners.set(name, fn),
    skipWaiting: async () => {},
    registration: { showNotification: async (...args) => notifications.push(args) },
    clients: { matchAll: async () => [], openWindow: async url => opened.push(url) },
  } };
  vm.runInNewContext(await readFile(new URL('./sw.js', import.meta.url), 'utf8'), context);
  async function dispatch(name, data) {
    let pending;
    listeners.get(name)({ ...data, waitUntil: promise => { pending = promise; } });
    await pending;
  }
  return { context, notifications, opened, dispatch, listeners };
}
test('push displays a notification, does not trust destination URL', async () => {
  const w = await worker();
  await w.dispatch('push', { data: { json: () => ({ title: '任务运行中', body: '通知', url: 'https://evil.example' }) } });
  assert.equal(w.notifications[0][0], '任务运行中');
  assert.equal(w.notifications[0][1].data.url, '/');
  assert.equal(w.listeners.has('fetch'), false);
});
test('malformed or absent push payload still displays a visible notification', async () => {
  const w = await worker();
  await w.dispatch('push', { data: { json() { throw Error('bad'); } } });
  await w.dispatch('push', {});
  assert.equal(w.notifications.length, 2);
});
test('notification click opens only the DSH origin', async () => {
  const w = await worker();
  let closed = false;
  await w.dispatch('notificationclick', { notification: { close: () => { closed = true; }, data: { url: 'https://evil.example' } } });
  assert.equal(closed, true);
  assert.deepEqual(w.opened, ['/']);
});
test('notification click focuses an existing DSH window', async () => {
  const w = await worker();
  let focused = false;
  w.context.self.clients.matchAll = async () => [{ url: 'https://dsh.example/session', focus: async () => { focused = true; } }];
  await w.dispatch('notificationclick', { notification: { close() {} } });
  assert.equal(focused, true);
  assert.deepEqual(w.opened, []);
});
