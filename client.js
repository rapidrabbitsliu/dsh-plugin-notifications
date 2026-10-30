window.__ModuleLoader__.load({
  id: 'dsh-plugin-notifications',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const base = '/dsh-notifications';
    const ns = 'local-task-notifications';
    const dictionaries = {
      zh: {
        title: '通知', scope: '本设备 · 所有工作区和会话', on: '已开启', off: '已关闭', permission: '浏览器权限', granted: '已允许', default: '未授权', blocked: '已拒绝', success: '测试推送已提交，请查看系统通知。',
        enable: '启用任务通知', disable: '关闭本设备通知', test: '测试通知', enabled: '本设备已订阅任务通知',
        disabled: '本设备尚未订阅', busy: '处理中…', unsupported: '需要 HTTPS、Service Worker 和 Web Push；iOS 16.4+ 请先添加到主屏幕后打开。',
        denied: '通知权限未获允许，请在浏览器/系统设置中允许后重试。', failed: '通知操作失败：', help: '默认仅在任务真正停止、需要批准或回答时通知；其他环节可按本设备开启。通知可能出现在锁屏上。',
        nodes: '通知节点', localPrefs: '尚未订阅：选择将保存在此浏览器，启用通知时生效。', saved: '本设备通知节点已保存。', invalidPrefs: '服务端返回的通知偏好无效，请重试。',
        stopped: '任务停止', stoppedHelp: '真正进入空闲状态时通知，不论完成、失败或中断。', approval: '需要批准', approvalHelp: '有操作等待你的批准。', question: '需要回答', questionHelp: '有问题等待你的回答。', running: '任务开始', runningHelp: '任务开始或恢复运行。', error: '运行错误', errorHelp: '代理运行时发生错误。', 'tool-error': '工具失败', 'tool-errorHelp': '单个工具执行失败，不代表任务最终失败。', turn: '本轮结束', turnHelp: '每轮结束时通知；任务可能继续运行。', workerMissing: '未找到通知 Service Worker。', workerTimeout: '通知 Service Worker 激活超时。', workerFailed: '通知 Service Worker 安装失败。',
      },
      en: {
        title: 'Notifications', scope: 'This device · all workspaces and sessions', on: 'On', off: 'Off', permission: 'Browser permission', granted: 'Allowed', default: 'Not requested', blocked: 'Denied', success: 'Test push submitted. Check your system notifications.',
        enable: 'Enable task notifications', disable: 'Disable on this device', test: 'Test notification', enabled: 'This device is subscribed',
        disabled: 'This device is not subscribed', busy: 'Working…', unsupported: 'HTTPS, Service Workers and Web Push are required. On iOS 16.4+, add to Home Screen and open the installed app first.',
        denied: 'Notification permission was not granted. Allow it in browser/system settings and try again.', failed: 'Notification operation failed: ', help: 'Quiet defaults notify only when a task truly stops or needs approval or an answer. Enable other stages for this device below. Notifications may appear on your lock screen.',
        nodes: 'Notification stages', localPrefs: 'Not subscribed: selections stay in this browser and apply when notifications are enabled.', saved: 'Notification stages saved for this device.', invalidPrefs: 'The server returned invalid notification preferences. Please retry.',
        stopped: 'Task stopped', stoppedHelp: 'Truly idle, whether completed, failed or interrupted.', approval: 'Approval needed', approvalHelp: 'An operation is waiting for your approval.', question: 'Answer needed', questionHelp: 'A question is waiting for your answer.', running: 'Task started', runningHelp: 'A task starts or resumes running.', error: 'Runtime error', errorHelp: 'The agent encounters a runtime error.', 'tool-error': 'Tool failed', 'tool-errorHelp': 'An individual tool failed; the task may still succeed.', turn: 'Round ended', turnHelp: 'Each round ends; the task may continue running.', workerMissing: 'No notification Service Worker was found.', workerTimeout: 'Notification Service Worker activation timed out.', workerFailed: 'Notification Service Worker installation failed.',
      },
    };
    function decodeKey(key) {
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
      return Uint8Array.from(raw, c => c.charCodeAt(0));
    }
    async function api(path, body) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
      return response.json();
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [language, dict] of Object.entries(dictionaries)) {
          ctx.effect(() => ctx.locale.register(ns, language, dict));
        }
        const t = ctx.locale.bind(ns);
        const defaults = { stopped: true, approval: true, question: true, running: false, error: false, 'tool-error': false, turn: false };
        const preferenceKeys = Object.keys(defaults);
        const storageKey = ns + ':preferences';
        function localPreferences() {
          try {
            const stored = JSON.parse(localStorage.getItem(storageKey));
            return Object.fromEntries(preferenceKeys.map(key => [key, typeof stored?.[key] === 'boolean' ? stored[key] : defaults[key]]));
          } catch { return { ...defaults }; }
        }
        function remember(preferences) {
          try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(preferenceKeys.map(key => [key, preferences[key]])))); } catch { /* Storage can be unavailable in private browsing. */ }
        }
        function serverPreferences(response) {
          const prefs = response?.preferences;
          if (!prefs || !preferenceKeys.every(key => typeof prefs[key] === 'boolean')) throw new Error(t('invalidPrefs'));
          return Object.fromEntries(preferenceKeys.map(key => [key, prefs[key]]));
        }
        let revision = 0;
        let snapshot = { subscription: null, preferences: localPreferences(), busy: true, error: '', message: '' };
        const subscribers = new Set();
        const publish = patch => { snapshot = { ...snapshot, ...patch }; for (const fn of subscribers) fn(); };
        const subscribe = fn => { subscribers.add(fn); return () => subscribers.delete(fn); };
        const supported = window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
        ctx.effect(() => {
          let disposed = false;
          let refreshId = 0;
          async function refresh() {
            if (snapshot.busy) return;
            const id = ++refreshId, startRevision = revision;
            const current = () => !disposed && id === refreshId && startRevision === revision && !snapshot.busy;
            try {
              const reg = supported ? await navigator.serviceWorker.getRegistration(base + '/') : null;
              const sub = await reg?.pushManager.getSubscription();
              if (!current()) return;
              publish({ subscription: sub || null });
              const preferences = sub ? serverPreferences(await api('/preferences', { endpoint: sub.endpoint })) : localPreferences();
              if (!current()) return;
              publish({ subscription: sub || null, preferences, error: '' });
            } catch (err) { if (current()) publish({ error: String(err.message || err) }); }
          }
          publish({ busy: false });
          void refresh();
          window.addEventListener('focus', refresh);
          return () => { disposed = true; window.removeEventListener('focus', refresh); subscribers.clear(); };
        });
        function Notifications({ compact = false, wide = true }) {
          const [, updateLocale] = React.useState(0);
          const { subscription, preferences, busy, error, message } = React.useSyncExternalStore(subscribe, () => snapshot);
          const setSubscription = subscription => publish({ subscription });
          const setBusy = busy => { revision++; publish({ busy }); };
          const setError = error => publish({ error, message: '' });
          React.useEffect(() => ctx.locale.subscribe(() => updateLocale(n => n + 1)), []);
          async function enable() {
            // Must run directly in the click gesture, before any network await (Safari/iOS).
            if (snapshot.busy || !supported) return;
            const permission = Notification.requestPermission();
            setBusy(true); setError('');
            try {
              if (await permission !== 'granted') throw new Error(t('denied'));
              const { publicKey } = await api('/config');
              const registration = await navigator.serviceWorker.register(base + '/sw.js', { scope: base + '/' });
              if (!registration.active) await new Promise((resolve, reject) => {
                const worker = registration.installing || registration.waiting;
                if (!worker) return reject(new Error(t('workerMissing')));
                const timeout = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error(t('workerTimeout'))); }, 15000);
                function changed() {
                  if (worker.state === 'activated' || worker.state === 'redundant') {
                    clearTimeout(timeout); worker.removeEventListener('statechange', changed);
                    worker.state === 'activated' ? resolve() : reject(new Error(t('workerFailed')));
                  }
                }
                worker.addEventListener('statechange', changed); changed();
              });
              let sub = await registration.pushManager.getSubscription();
              sub ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) });
              // An existing local subscription may not yet be registered with this Host.
              await api('/subscribe', { subscription: sub.toJSON(), preferences: snapshot.preferences });
              setSubscription(sub);
            } catch (err) { setError(String(err.message || err)); }
            finally { setBusy(false); }
          }
          async function action(kind) {
            if (snapshot.busy || !subscription) return;
            setBusy(true); setError('');
            try {
              if (kind === 'test') { await api('/test', { endpoint: subscription.endpoint }); publish({ message: t('success') }); }
              else {
                // Remove remotely first; on failure retain the local handle for a retry.
                await api('/unsubscribe', { endpoint: subscription.endpoint });
                await subscription.unsubscribe();
                setSubscription(null);
              }
            } catch (err) { setError(String(err.message || err)); }
            finally { setBusy(false); }
          }
          async function changePreference(key) {
            if (snapshot.busy) return;
            const next = { ...snapshot.preferences, [key]: !snapshot.preferences[key] };
            if (!snapshot.subscription) {
              revision++;
              remember(next);
              publish({ preferences: next, error: '', message: '' });
              return;
            }
            const endpoint = snapshot.subscription.endpoint;
            setBusy(true); setError('');
            try {
              const saved = serverPreferences(await api('/preferences', { endpoint, preferences: next }));
              remember(saved);
              publish({ preferences: saved, message: t('saved') });
            } catch (err) { setError(String(err.message || err)); }
            finally { setBusy(false); }
          }
          const buttonStyle = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '9px 12px', minHeight: 40, cursor: busy ? 'wait' : 'pointer' };
          const toggle = () => subscription ? action('disable') : enable();
          const label = `${t('title')} · ${t(subscription ? 'on' : 'off')}`;
          const bell = h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('path', { d: 'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4M12 2v2' }), !subscription && h('path', { d: 'M3 3l18 18' }));
          const control = h('button', { type: 'button', role: 'switch', 'aria-checked': !!subscription, 'aria-label': label, disabled: busy || !supported, title: error ? t('failed') + error : !supported ? t('unsupported') : `${label} — ${t('scope')}`, onClick: toggle, style: { ...buttonStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, ...(compact ? { border: 'none', background: 'transparent', padding: 10 } : {}) } }, bell,
            (!compact || wide) && h('span', null, label), busy && h('span', { 'aria-hidden': true }, '…'));
          if (compact) return h('div', null, control, error && h('span', { role: 'alert', style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', display: 'block', maxWidth: wide ? 180 : 44, overflowWrap: 'anywhere' } }, t('failed') + error));
          return h('section', { style: { padding: '8px 0', color: 'var(--dsw-alias-label-primary)', maxWidth: 640 } },
            h('h2', { style: { fontSize: 20, margin: '0 0 20px' } }, t('title')),
            h('div', { style: { padding: 16, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12 } },
              h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 } }, h('div', null, h('strong', null, t('scope')), h('p', { style: { margin: '6px 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('help'))), control),
              h('p', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, supported ? `${t('permission')} · ${t(Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'blocked' : 'default')}` : t('unsupported')),
              subscription && h('button', { type: 'button', disabled: busy, style: buttonStyle, onClick: () => action('test') }, t('test'))),
            h('fieldset', { disabled: busy, style: { margin: '20px 0 0', padding: 16, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12 } },
              h('legend', null, t('nodes')),
              !subscription && h('p', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('localPrefs')),
              ...preferenceKeys.map(key => h('label', { key, style: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', cursor: busy ? 'wait' : 'pointer' } },
                h('input', { type: 'checkbox', checked: preferences[key], disabled: busy, onChange: () => changePreference(key), style: { marginTop: 4, accentColor: 'var(--dsw-alias-brand-primary)' } }),
                h('span', null, h('span', { style: { display: 'block' } }, t(key)), h('span', { style: { display: 'block', marginTop: 3, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t(key + 'Help')))))),
            error && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' } }, t('failed') + error),
            message && h('p', { role: 'status' }, message));
        }
        ctx.slots.inject('settings.section', () => {
          let dispose;
          const register = () => { dispose?.(); dispose = ctx.slots.register({ name: 'settings.section', id: ns, order: 25, label: t('title') }, Notifications); };
          register();
          const unsubscribe = ctx.locale.subscribe(register);
          return () => { unsubscribe(); dispose?.(); };
        });
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: ns, order: 100, label: () => t('title') }, props => h(Notifications, { compact: true, wide: props.wide })));
      },
    };
  },
});
