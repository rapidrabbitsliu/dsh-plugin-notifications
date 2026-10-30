import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createECDH, randomBytes } from 'node:crypto';
import { apply } from './index.js';

test('Host integration: real VAPID, authenticated routes, subscription and cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-notifications-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const routes = new Map();
  const events = new Map();
  const cleanups = [];
  const peer = { id: 'browser-owner', principal: { kind: 'owner' } };
  const ctx = {
    connection: { browserPeer: peer, admit: req => req.headers.cookie === 'test-owner' ? { peer } : { rejection: 401 } },
    webServer: { register: route => { assert.equal(routes.has(route.path), false); routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    effect: fn => { const dispose = fn(); if (dispose) cleanups.push(dispose); },
    on: (name, fn) => { events.set(name, fn); cleanups.push(() => events.delete(name)); },
  };
  await apply(ctx, { storageDir: directory });
  assert.equal(routes.size, 7);
  assert.equal(events.size, 4);
  async function call(path, method = 'GET', body, authenticated = true) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.socket = {};
    req.headers = { host: 'localhost:3090', origin: 'http://localhost:3090', 'content-type': 'application/json', ...(authenticated ? { cookie: 'test-owner' } : {}) };
    const res = { status: undefined, headers: {}, headersSent: false, destroyed: false, writableEnded: false,
      setHeader(name, value) { this.headers[name] = value; },
      writeHead(status, headers) { this.status = status; this.headers = { ...this.headers, ...headers }; this.headersSent = true; },
      end(body) { this.body = body; this.writableEnded = true; },
    };
    await routes.get('/dsh-notifications' + path)(req, res);
    return res;
  }
  assert.equal((await call('/config', 'GET', undefined, false)).status, 401);
  assert.equal((await call('/diagnostics', 'GET', undefined, false)).status, 401);
  const counters = await call('/diagnostics');
  assert.deepEqual(JSON.parse(counters.body), { question: { received: 0, accepted: 0, failed: 0 }, approval: { received: 0, accepted: 0, failed: 0 } });
  const config = await call('/config');
  assert.equal(config.status, 200);
  const publicKey = JSON.parse(config.body).publicKey;
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  const sw = await call('/sw.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers['Service-Worker-Allowed'], '/dsh-notifications/');
  assert.match(sw.body.toString(), /notificationclick/);
  const icon = await call('/icon.svg');
  assert.equal(icon.status, 200);
  assert.match(icon.body.toString(), /^<svg/);
  assert.equal((await call('/subscribe', 'GET')).status, 405);
  assert.equal((await call('/subscribe', 'POST', { subscription: { endpoint: 'https://127.0.0.1/private' } })).status, 400);
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/integration-test', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  assert.equal((await call('/subscribe', 'POST', { subscription })).status, 200);
  assert.equal((await call('/unsubscribe', 'POST', { endpoint: subscription.endpoint })).status, 200);
  assert.equal((await call('/test', 'POST', { endpoint: subscription.endpoint })).status, 404);
  for (const dispose of cleanups.reverse()) await dispose();
  assert.equal(routes.size, 0);
  assert.equal(events.size, 0);
});
