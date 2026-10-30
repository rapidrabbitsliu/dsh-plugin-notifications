import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HttpError, validateEndpoint, validateSubscription, authorize, normalizeOrigin, readJson, openStore, createNotifier, registerListeners, safeExcerpt } from './core.js';

const endpoint = 'https://fcm.googleapis.com/fcm/send/device1';
const subscription = (url = endpoint) => ({ endpoint: url, keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } });
const webPush = { generateVAPIDKeys: () => ({ publicKey: 'persistent-public', privateKey: 'persistent-private' }) };
const owner = { id: 'browser', principal: { kind: 'owner' } };
const connection = { admit: () => ({ peer: owner }), browserPeer: owner };
const request = (extra = {}) => ({ method: 'POST', headers: { host: 'localhost:3090', origin: 'http://localhost:3090' }, socket: {}, ...extra });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-notifications-test-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return { directory, store: await openStore({ storageDir: directory, webPush, ...options }) };
}

test('endpoint allowlist rejects SSRF, credentials, redirects-by-host and insecure URLs', () => {
  for (const url of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://evil.test/x', 'https://fcm.googleapis.com.evil.test/x', 'https://push.apple.com.evil.test/x', 'https://evil@fcm.googleapis.com/x', 'https://fcm.googleapis.com:4430/x', 'https://fcm.googleapis.com/x#secret']) {
    assert.throws(() => validateEndpoint(url), HttpError, url);
  }
  for (const url of [endpoint, 'https://updates.push.services.mozilla.com/wpush/v2/device', 'https://web.push.apple.com/device']) assert.equal(validateEndpoint(url), url);
  assert.throws(() => validateSubscription({ endpoint, keys: {} }), HttpError);
  assert.deepEqual(validateSubscription(subscription()).keys, subscription().keys);
});

test('authentication is live owner-browser only; Origin strictly same-origin', () => {
  assert.doesNotThrow(() => authorize(request(), connection));
  for (const origin of [undefined, 'null', 'https://evil.test', 'http://localhost:3090.evil.test', 'http://localhost:3090/']) {
    assert.throws(() => authorize(request({ headers: { host: 'localhost:3090', origin } }), connection), { status: 403 });
  }
  assert.throws(() => authorize(request(), { ...connection, admit: () => ({ rejection: 401 }) }), { status: 401 });
  assert.throws(() => authorize(request(), { ...connection, admit: () => ({ peer: { id: 'api', principal: { kind: 'owner' } } }) }), { status: 403 });
  assert.throws(() => authorize(request(), { ...connection, admit: () => ({ peer: { id: 'browser', principal: { kind: 'guest' } } }) }), { status: 403 });
  assert.throws(() => authorize(request({ headers: { host: 'localhost:3090', origin: 'https://public.test', 'x-forwarded-host': 'public.test', 'x-forwarded-proto': 'https' } }), connection), { status: 403 });
  assert.doesNotThrow(() => authorize(request({ headers: { host: 'internal:3090', origin: 'https://public.test' } }), connection, normalizeOrigin('https://public.test')));
  assert.throws(() => normalizeOrigin('https://public.test/prefix'));
  assert.throws(() => authorize(request({ headers: { host: 'localhost:3090', origin: 'http://localhost:3090', 'sec-fetch-site': 'cross-site' } }), connection), { status: 403 });
  assert.doesNotThrow(() => authorize(request({ method: 'GET', headers: { host: 'localhost:3090' } }), connection));
});

test('multiple explicit HTTPS origins remain isolated by original Host', () => {
  const origins = ['https://dsh-local.example.com', 'https://dsh.example.com'];
  for (const origin of origins) assert.doesNotThrow(() => authorize(request({ headers: { host: new URL(origin).host, origin } }), connection, origins));
  assert.throws(() => authorize(request({ headers: { host: 'dsh.example.com', origin: origins[0] } }), connection, origins), { status: 403 });
  assert.throws(() => authorize(request({ headers: { host: 'evil.test', origin: 'https://evil.test' } }), connection, origins), { status: 403 });
});

test('HTTP loopback works alongside HTTPS configuration without weakening admission or origin', () => {
  for (const config of ['https://public.test', ['https://public.test']]) {
    for (const host of ['localhost:3080', '127.0.0.1:3080', '[::1]:3080', 'localhost']) {
      const req = request({ headers: { host, origin: `http://${host}` } });
      assert.doesNotThrow(() => authorize(req, connection, config));
      assert.throws(() => authorize(req, { admit: () => ({ rejection: 401 }) }, config), { status: 401 });
    }
    for (const host of ['192.168.1.20:3080', '100.64.0.1:3080', 'localhost.evil.test:3080', '127.0.0.1.evil.test:3080']) {
      assert.throws(() => authorize(request({ headers: { host, origin: `http://${host}` } }), connection, config), { status: 403 });
    }
    for (const origin of ['http://localhost:3081', 'http://127.0.0.1:3080', 'https://localhost:3080', 'null', undefined]) {
      assert.throws(() => authorize(request({ headers: { host: 'localhost:3080', origin } }), connection, config), { status: 403 });
    }
    assert.throws(() => authorize(request({ headers: { host: 'localhost:3080', origin: 'http://localhost:3080', 'sec-fetch-site': 'cross-site' } }), connection, config), { status: 403 });
  }
});

test('request parser enforces JSON and both declared and streaming limits', async () => {
  function body(text, headers = {}) {
    const req = Readable.from([Buffer.from(text)]);
    req.headers = { 'content-type': 'application/json', ...headers };
    return req;
  }
  assert.deepEqual(await readJson(body('{"endpoint":"x"}')), { endpoint: 'x' });
  await assert.rejects(readJson(body('{}', { 'content-type': 'text/plain' })), { status: 415 });
  await assert.rejects(readJson(body('{}', { 'content-length': '20000' })), { status: 413 });
  await assert.rejects(readJson(body('x'.repeat(20)), 16), { status: 413 });
  await assert.rejects(readJson(body('[]')), { status: 400 });
  await assert.rejects(readJson(body('{bad')), { status: 400 });
});

test('VAPID keys and multi-device subscriptions survive reopening; updates are bounded and atomic', async t => {
  const { directory, store } = await fixture(t, { maxSubscriptions: 2 });
  await store.subscribe(subscription());
  await store.subscribe(subscription(`${endpoint}2`));
  await store.subscribe(subscription());
  await assert.rejects(store.subscribe(subscription(`${endpoint}3`)), { status: 409 });
  assert.equal(store.list().length, 2);
  const reopened = await openStore({ storageDir: directory, webPush: { generateVAPIDKeys: () => { throw Error('must not regenerate'); } } });
  assert.equal(reopened.publicKey, store.publicKey);
  assert.deepEqual(reopened.vapid, store.vapid);
  assert.equal(reopened.list().length, 2);
  await reopened.unsubscribe(endpoint);
  assert.equal(reopened.list().length, 1);
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(state.subscriptions.length, 1);
});

test('parallel writes persist all devices without lost updates', async t => {
  const { directory, store } = await fixture(t);
  await Promise.all([1, 2, 3].map(i => store.subscribe(subscription(`${endpoint}${i}`))));
  const reopened = await openStore({ storageDir: directory, webPush });
  assert.equal(reopened.list().length, 3);
});

test('410 deletes stale subscription; failures isolated and payload has no sensitive content', async t => {
  const { store } = await fixture(t);
  await store.subscribe(subscription());
  await store.subscribe(subscription(`${endpoint}2`));
  const seen = [];
  const notifier = createNotifier({ store, webPush: { sendNotification: async (sub, data) => {
    seen.push(JSON.parse(data));
    if (sub.endpoint === endpoint) throw { statusCode: 410 };
  } } });
  const payload = { title: '通知', body: '请查看 DSH', tag: 'test', url: '/' };
  assert.equal(await notifier.dispatch(payload), true);
  assert.equal(store.get(endpoint), undefined);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], payload);
  const failing = createNotifier({ store, warn: () => { throw Error('logger broken'); }, webPush: { sendNotification: () => { throw Error('offline'); } } });
  assert.equal(await failing.dispatch(payload), false);
  assert.equal(store.list().length, 1);
});

test('explicit outbound agent is passed only to push transport', async t => {
  const { store } = await fixture(t);
  await store.subscribe(subscription());
  const agent = {};
  let options;
  const notifier = createNotifier({ store, agent, webPush: { sendNotification: async (sub, data, config) => { options = config; } } });
  assert.equal(await notifier.dispatch({ title: 'test' }), true);
  assert.equal(options.agent, agent);
});

test('HTTP CONNECT proxy option reaches web-push without conflicting agent', async t => {
  const { store } = await fixture(t);
  await store.subscribe(subscription());
  let options;
  const proxy = 'http://192.0.2.1:7898';
  const notifier = createNotifier({ store, proxy, agent: {}, webPush: { sendNotification: async (sub, data, config) => { options = config; } } });
  assert.equal(await notifier.dispatch({ title: 'test' }), true);
  assert.equal(options.proxy, proxy);
  assert.equal(options.agent, undefined);
});

test('push diagnostics classify timeout/status without disclosing provider secrets', async t => {
  const { store } = await fixture(t);
  await store.subscribe(subscription());
  for (const [error, expected] of [[new Error('Socket timeout secret-endpoint'), '网络超时'], [{ statusCode: 403, body: 'private provider body' }, 'HTTP 403'], [{ code: 'ECONNREFUSED', message: 'secret' }, 'ECONNREFUSED']]) {
    const warnings = [];
    const notifier = createNotifier({ store, warn: value => warnings.push(value), webPush: { sendNotification: async () => { throw error; } } });
    assert.equal(await notifier.dispatch({ title: 'test' }), false);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(expected));
    assert.doesNotMatch(warnings[0], /secret|private|endpoint|https:/);
  }
});

test('event listeners prepend waterfalls, return next unchanged, never await push or expose reasons', async () => {
  const listeners = new Map();
  const sent = [];
  const ctx = { on: (event, listener, options) => listeners.set(event, { listener, options }) };
  const notifier = { dispatch: payload => { sent.push(payload); return new Promise(() => {}); } };
  registerListeners(ctx, notifier);
  for (const event of ['approval/request', 'user-questions/request']) {
    const { listener, options } = listeners.get(event);
    assert.equal(options.prepend, true);
    let called = 0;
    const answer = Promise.resolve({ original: true });
    assert.equal(listener({ agent: { id: 'session1' }, reason: 'TOP SECRET', questions: [{ question: 'PRIVATE' }] }, () => { called++; return answer; }), answer);
    assert.equal(called, 1);
    assert.deepEqual(await answer, { original: true });
  }
  listeners.get('agent/status').listener({ agent: { id: 'session1' }, status: 'idle' });
  listeners.get('agent/status').listener({ agent: { id: 'session1' }, status: 'running' });
  listeners.get('agent/error').listener({ agent: { id: 'session1' }, error: Error('TOP SECRET') });
  assert.equal(sent.length, 4);
  assert.equal(sent[0].title, '需要你的批准');
  assert.equal(sent[1].title, '需要你的回答');
  assert.notEqual(sent[0].tag, sent[1].tag);
  assert.equal(JSON.stringify(sent).includes('TOP SECRET'), false);
  assert.equal(JSON.stringify(sent).includes('PRIVATE'), false);
  for (const payload of sent) assert.deepEqual(Object.keys(payload).sort(), ['body', 'tag', 'title', 'url']);
  const thrown = Error('next rejection');
  assert.throws(() => listeners.get('approval/request').listener({}, () => { throw thrown; }), e => e === thrown);
});

test('summary filter removes sensitive lines, paths, URLs and limits characters', () => {
  const text = safeExcerpt('测试通过\nTOKEN=supersecret\n查看 https://private.example/a\n访问 C:\\Users\\person\\file\n完成');
  assert.equal(text, '测试通过 完成');
  assert.equal(Array.from(safeExcerpt('测'.repeat(200))).length, 140);
});

test('turn notifications use bounded redacted summaries and precise outcomes', () => {
  const listeners = new Map(), sent = [];
  const session = { id: 's' };
  const ctx = { on: (name, cb) => listeners.set(name, cb), get: name => ({ sessions: { get: () => session }, sessionTitle: { get: () => ({ title: '修复通知' }) }, sessionProjections: { stateOf: () => ({ turn: 1, summary: '修复已完成，测试通过' }) } })[name] };
  registerListeners(ctx, { dispatch: value => { sent.push(value); return Promise.resolve(true); } });
  listeners.get('session/event')(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  listeners.get('session/event')(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'SECRET' } } } });
  assert.equal(sent[0].title, '任务本轮完成');
  assert.match(sent[0].body, /修复通知.*修复已完成/);
  assert.equal(sent[1].title, '任务本轮失败');
  listeners.get('tools/result')({ agent: { id: 's' }, name: 'pwsh', arguments: { command: 'PRIVATE COMMAND' } }, { isError: true, error: { message: 'SECRET' } });
  assert.match(sent[2].body, /pwsh.*失败/);
  assert.doesNotMatch(JSON.stringify(sent), /SECRET|PRIVATE COMMAND/);
});

test('synchronously throwing notifier cannot swallow next; rejected pushes are handled', async () => {
  for (const dispatch of [() => { throw Error('sync push failed'); }, () => Promise.reject(Error('async push failed'))]) {
    const listeners = new Map();
    registerListeners({ on: (event, listener) => listeners.set(event, listener) }, { dispatch });
    const result = Promise.resolve('allowed-once');
    assert.equal(listeners.get('approval/request')({}, () => result), result);
    assert.equal(listeners.get('user-questions/request')({}, () => result), result);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('bounded notification queue and close prevent unbounded work', async t => {
  const { store } = await fixture(t);
  await store.subscribe(subscription());
  let finish;
  const notifier = createNotifier({ store, maxPending: 1, webPush: { sendNotification: () => new Promise(resolve => { finish = resolve; }) } });
  const first = notifier.dispatch({ title: 'x' });
  assert.equal(await notifier.dispatch({ title: 'dropped' }), false);
  finish();
  assert.equal(await first, true);
  notifier.close();
  assert.equal(await notifier.dispatch({ title: 'closed' }), false);
  await notifier.drain();
});
