import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Push endpoints are network destinations, not arbitrary URLs supplied by clients.
export function validateEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new HttpError(400, '无效的推送地址');
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, '无效的推送地址'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
    || host === 'web.push.apple.com' || host.endsWith('.push.apple.com');
  if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port || url.hash) {
    throw new HttpError(400, '不支持此推送服务');
  }
  return value;
}

export function validateSubscription(value) {
  if (!value || typeof value !== 'object') throw new HttpError(400, '缺少订阅');
  const endpoint = validateEndpoint(value.endpoint);
  const { p256dh, auth } = value.keys ?? {};
  const key = (s, bytes) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s)
    && Buffer.from(s, 'base64url').length === bytes;
  if (!key(p256dh, 65) || Buffer.from(p256dh, 'base64url')[0] !== 4 || !key(auth, 16)) {
    throw new HttpError(400, '无效的订阅密钥');
  }
  return { endpoint, expirationTime: null, keys: { p256dh, auth } };
}

function header(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function normalizeOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('publicOrigin 必须是完整 HTTP(S) origin（不能包含路径）');
  return url.origin;
}

export function authorize(req, connection, publicOrigin) {
  // Use the same live credentials, Host trust and Origin fence as the DSH API.
  const admission = connection.admit(req);
  if ('rejection' in admission) throw new HttpError(admission.rejection, '认证失败');
  if (admission.peer.principal.kind !== 'owner' || admission.peer.id !== connection.browserPeer.id) {
    throw new HttpError(403, '仅限已登录的浏览器所有者');
  }
  if (req.method === 'POST') {
    const origin = header(req, 'origin');
    const host = header(req, 'host');
    let expected;
    try {
      const local = new URL(`http://${host}`);
      const loopback = typeof host === 'string' && local.host === host
        && ['localhost', '127.0.0.1', '[::1]'].includes(local.hostname);
      // Exact original authority only; no forwarded-host trust or LAN HTTP exemption.
      expected = loopback && !req.socket?.encrypted && origin === local.origin ? local.origin : Array.isArray(publicOrigin)
        ? publicOrigin.find(value => new URL(value).host === host)
        : publicOrigin ?? normalizeOrigin(`${req.socket?.encrypted ? 'https:' : 'http:'}//${host}`);
    }
    catch { throw new HttpError(403, 'Origin 不匹配'); }
    // No absent/null Origin, suffix checks, or X-Forwarded-* trust.
    if (!origin || origin !== expected) throw new HttpError(403, 'Origin 不匹配');
    const site = header(req, 'sec-fetch-site');
    if (site && site !== 'same-origin') throw new HttpError(403, '拒绝跨站请求');
  }
}

export async function readJson(req, maxBytes = 16384) {
  if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type') ?? '')) {
    throw new HttpError(415, '仅接受 application/json');
  }
  const declared = header(req, 'content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new HttpError(413, '请求过大');
  let size = 0;
  const chunks = [];
  const timeout = setTimeout(() => req.destroy(new Error('request timeout')), 10000);
  timeout.unref?.();
  try {
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new HttpError(413, '请求过大');
      chunks.push(bytes);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, '无效的 JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '需要 JSON 对象');
    return body;
  } finally { clearTimeout(timeout); }
}

export async function openStore({ storageDir, profileDir = process.env.DSH_PROFILE_DIR, webPush, maxSubscriptions = 32 }) {
  if (!Number.isInteger(maxSubscriptions) || maxSubscriptions < 1 || maxSubscriptions > 256) throw new Error('maxSubscriptions 必须在 1–256 之间');
  if (!storageDir && !profileDir) throw new Error('请配置 storageDir 或设置 DSH_PROFILE_DIR；不会写入工作目录或 profile package');
  const directory = storageDir ? resolve(storageDir) : join(resolve(profileDir), 'dsh-notifications');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!state) state = { version: 1, vapid: webPush.generateVAPIDKeys(), subscriptions: [] };
  if (state.version !== 1 || typeof state.vapid?.publicKey !== 'string' || typeof state.vapid?.privateKey !== 'string'
    || !Array.isArray(state.subscriptions)) throw new Error('通知存储损坏；拒绝覆盖现有 VAPID 密钥');
  const subscriptions = new Map(state.subscriptions.map(s => { const item = validateSubscription(s); return [item.endpoint, item]; }));
  let queue = Promise.resolve();
  async function save() {
    const temp = join(directory, `state.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify({ version: 1, vapid: state.vapid, subscriptions: [...subscriptions.values()] }), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  }
  function mutate(fn) {
    const next = queue.then(async () => {
      const before = new Map(subscriptions);
      try { const result = fn(); await save(); return result; }
      catch (error) { subscriptions.clear(); for (const [k, v] of before) subscriptions.set(k, v); throw error; }
    });
    queue = next.catch(() => {});
    return next;
  }
  await save();
  return {
    publicKey: state.vapid.publicKey,
    vapid: Object.freeze({ ...state.vapid }),
    list: () => [...subscriptions.values()],
    get: endpoint => subscriptions.get(endpoint),
    subscribe: value => {
      const subscription = validateSubscription(value);
      return mutate(() => {
        if (!subscriptions.has(subscription.endpoint) && subscriptions.size >= maxSubscriptions) throw new HttpError(409, '订阅设备已达上限');
        subscriptions.set(subscription.endpoint, subscription);
      });
    },
    unsubscribe: endpoint => mutate(() => subscriptions.delete(validateEndpoint(endpoint))),
    flush: () => queue,
  };
}

export function createNotifier({ store, webPush, subject = 'mailto:notifications@example.invalid', warn = () => {}, maxPending = 64, agent, proxy }) {
  let closed = false;
  let pending = 0;
  const jobs = new Set();
  const report = error => {
    // Classify only; never emit provider bodies, endpoints, keys or arbitrary messages.
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 100 && error.statusCode <= 599 ? error.statusCode : undefined;
    const codes = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
    const reason = status ? `HTTP ${status}` : codes.has(error?.code) ? error.code
      : /timeout/i.test(String(error?.message ?? '')) ? '网络超时' : '发送失败';
    try { warn(`通知推送失败（${reason}；已隔离；不影响任务）`); } catch {}
  };
  async function send(subscription, payload) {
    try {
      await webPush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: { subject, publicKey: store.vapid.publicKey, privateKey: store.vapid.privateKey },
        TTL: 300, timeout: 10000, ...(proxy ? { proxy } : agent ? { agent } : {}), // web-push does not follow redirects.
      });
      return true;
    } catch (error) {
      if (error?.statusCode === 410 || error?.statusCode === 404) {
        try { await store.unsubscribe(subscription.endpoint); } catch { report(); }
      } else report(error);
      return false;
    }
  }
  function dispatch(payload, endpoint) {
    if (closed || pending >= maxPending) return Promise.resolve(false);
    const targets = endpoint ? [store.get(endpoint)].filter(Boolean) : store.list();
    if (!targets.length) return Promise.resolve(false);
    pending++;
    const job = (async () => {
      // Bounded device count, sequential sending keeps per-event sockets bounded.
      let sent = false;
      for (const target of targets) { if (closed) break; sent = (await send(target, payload)) || sent; }
      return sent;
    })().catch(() => { report(); return false; }).finally(() => { pending--; jobs.delete(job); });
    jobs.add(job);
    return job;
  }
  return { dispatch, close: () => { closed = true; }, drain: () => Promise.allSettled([...jobs]) };
}

export function registerListeners(ctx, notifier, diagnostic = () => {}) {
  function notify(title, body, kind, agent) {
    // No tool arguments, approval reasons, question text, or exception text leaves DSH.
    const confirmation = kind === 'approval' || kind === 'question';
    const trace = phase => { if (confirmation) { try { diagnostic(kind, phase); } catch {} } };
    trace('event received');
    try { void Promise.resolve(notifier.dispatch({ title, body, tag: `dsh-${kind}-${agent?.id ?? 'global'}`, url: '/' }))
      .then(sent => trace(sent ? 'provider accepted' : 'send failed or no device')).catch(() => trace('send failed')); } catch { trace('dispatch failed'); }
  }
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') notify('任务已暂停或完成', '请打开 DSH 查看任务结果。', 'idle', agent);
    else if (status === 'running') notify('任务已开始', 'DSH 正在处理任务。', 'running', agent);
  });
  ctx.on('agent/error', ({ agent }) => notify('任务发生错误', '请打开 DSH 查看详情。', 'error', agent));
  ctx.on('approval/request', (request, next) => {
    notify('需要你的批准', '请打开 DSH 审核待处理操作。', 'approval', request.agent);
    return next();
  }, { prepend: true });
  ctx.on('user-questions/request', (request, next) => {
    notify('需要你的回答', '请打开 DSH 回答待处理问题。', 'question', request.agent);
    return next();
  }, { prepend: true });
}
