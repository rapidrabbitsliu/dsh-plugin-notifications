import { readFile } from 'node:fs/promises';
import webPush from 'web-push';
import { SocksProxyAgent } from 'socks-proxy-agent';
import https from 'node:https';
import { z } from 'zod';
import { HttpError, authorize, normalizeOrigin, readJson, openStore, createNotifier, registerListeners, validateEndpoint, safeExcerpt } from './core.js';

export const name = 'dsh-notifications';
export const inject = ['webServer', 'connection'];

export async function apply(ctx, config = {}) {
  const publicOrigin = config.publicOrigins ? config.publicOrigins.map(normalizeOrigin) : config.publicOrigin ? normalizeOrigin(config.publicOrigin) : undefined;
  const subject = config.vapidSubject ?? 'https://github.com/rapidrabbitsliu/dsh-plugin-notifications';
  if (typeof subject !== 'string' || !/^(mailto:|https:\/\/)/.test(subject)) throw new Error('vapidSubject 必须为 mailto: 或 HTTPS URL');
  const store = await openStore({ storageDir: config.storageDir, profileDir: ctx.get('profileContext')?.dir, webPush, maxSubscriptions: config.maxSubscriptions ?? 32 });
  let agent, httpProxy;
  if (config.proxyUrl) {
    let proxy;
    try { proxy = new URL(config.proxyUrl); } catch { throw new Error('proxyUrl 必须是有效代理 URL'); }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.pathname && proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('proxyUrl 仅支持不含凭据的 http/https/socks5/socks5h URL');
    if (proxy.protocol === 'http:' || proxy.protocol === 'https:') httpProxy = proxy.href;
    else {
    const socks = new SocksProxyAgent(proxy, { timeout: 10000 });
    // web-push requires instanceof https.Agent; modern proxy agents extend http.Agent.
    agent = new https.Agent();
    agent.addRequest = socks.addRequest.bind(socks);
    ctx.effect(() => () => { agent.destroy(); socks.destroy(); });
    }
  }
  const notifier = createNotifier({ store, webPush, subject, agent, proxy: httpProxy, warn: message => ctx.logger?.warn?.(message) });
  ctx.effect(() => () => { notifier.close(); });
  ctx.inject(['sessionProjections'], inner => {
    inner.sessionProjections.register({
      key: 'notification-detail', stateVersion: 1,
      stateSchema: z.object({ turn: z.number().nullable(), summary: z.string().max(140) }),
      init: () => ({ turn: null, summary: '' }),
      apply(state, event) {
        if (event.type === 'turn/start') return { turn: event.data.turn, summary: '' };
        if (event.type !== 'assistant/message' || event.data.turn !== state.turn || event.data.interrupted) return state;
        const blocks = event.data.message?.content;
        const summary = Array.isArray(blocks) ? safeExcerpt(blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')) : '';
        return summary === state.summary ? state : { ...state, summary };
      },
    });
  });
  const diagnostics = { question: { received: 0, accepted: 0, failed: 0 }, approval: { received: 0, accepted: 0, failed: 0 } };
  registerListeners(ctx, notifier, (kind, phase) => {
    const counter = diagnostics[kind];
    const at = new Date().toISOString();
    if (phase === 'event received') { counter.received++; counter.lastReceivedAt = at; }
    else if (phase === 'provider accepted') { counter.accepted++; counter.lastAcceptedAt = at; }
    else { counter.failed++; counter.lastFailedAt = at; }
  });
  const assets = new Map([
    ['/dsh-notifications/sw.js', { file: new URL('./sw.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
    ['/dsh-notifications/icon.svg', { file: new URL('./icon.svg', import.meta.url), type: 'image/svg+xml' }],
  ]);
  function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }
  // Bound owner-triggered manual sends, as well as event queue memory.
  const tests = new Map();
  const routes = [
    ['/dsh-notifications/config', 'GET'], ['/dsh-notifications/diagnostics', 'GET'], ['/dsh-notifications/subscribe', 'POST'],
    ['/dsh-notifications/unsubscribe', 'POST'], ['/dsh-notifications/test', 'POST'],
    ...[...assets.keys()].map(path => [path, 'GET']),
  ];
  for (const [path, method] of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
      try {
        authorize(req, ctx.connection, publicOrigin);
        if (req.method !== method) { res.setHeader('Allow', method); throw new HttpError(405, '不支持此方法'); }
        const asset = assets.get(path);
        if (asset) {
          const bytes = await readFile(asset.file);
          res.writeHead(200, {
            'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
            ...(path.endsWith('/sw.js') ? { 'Service-Worker-Allowed': '/dsh-notifications/' } : {}),
          });
          res.end(bytes);
          return;
        }
        if (path.endsWith('/diagnostics')) { reply(res, 200, diagnostics); return; }
        if (method === 'GET') { reply(res, 200, { publicKey: store.publicKey }); return; }
        const body = await readJson(req);
        if (path.endsWith('/subscribe')) await store.subscribe(body.subscription);
        else if (path.endsWith('/unsubscribe')) await store.unsubscribe(body.endpoint);
        else {
          const endpoint = validateEndpoint(body.endpoint);
          if (!store.get(endpoint)) throw new HttpError(404, '未找到订阅');
          const now = Date.now();
          if (now - (tests.get(endpoint) ?? 0) < 10000) throw new HttpError(429, '请稍后重试');
          tests.set(endpoint, now);
          for (const [key, time] of tests) if (now - time > 60000) tests.delete(key);
          const sent = await notifier.dispatch({ title: 'DSH 测试通知', body: '通知已启用。', tag: 'dsh-test', url: '/' }, endpoint);
          if (!sent) throw new HttpError(502, '推送未送达，请稍后重试或重新订阅');
        }
        reply(res, 200, { ok: true });
      } catch (error) {
        if (!res.headersSent && !res.destroyed) reply(res, error instanceof HttpError ? error.status : 500,
          { error: error instanceof HttpError ? error.message : '通知服务暂时不可用' });
        else if (!res.writableEnded) res.end();
      }
    } }));
  }
}
