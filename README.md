# dsh-plugin-notifications

Independent DSH Host/Client plugin for encrypted Web Push task notifications. No DSH core modifications. MIT licensed; not an official DeepSeek product.

## Features / 功能

- All workspaces and sessions on the same Host: agent running/idle, errors, approval requests and user questions.
- Settings → Notifications: permission, device toggle and test notification.
- Sidebar bell: one-click toggle for **this device**, not other devices. No composer clutter.
- Notifications may include session titles, failed tool names, turn outcomes and up to 140 characters of assistant result text. Tool arguments, approval reasons, question contents and raw exceptions are not deliberately sent. See the privacy warning below.
- A notification focuses an existing same-origin DSH window or opens the homepage. It does **not** approve, answer or execute anything; inline notification replies are not implemented.

## Install / 安装

Use DSH Plugin Manager to install the npm bundle:

```text
dsh-plugin-notifications
```

For an agent managing DSH, use the supported `plugin_manager` tool with `action: install_bundle`, `target: dsh-plugin-notifications`. Do not edit DSH core or profile package files manually. Refresh the existing page after installation. Do not install alongside another copy using the same `/dsh-notifications/` routes (including the development package `@local/dsh-plugin-notifications`). Arrange replacement outside active work if lifecycle dependencies require maintenance.

Storage resolution: explicit `storageDir` takes priority; otherwise use `<ctx.profileContext.dir>/dsh-notifications`, obtained from DSH's profileContext service. `DSH_PROFILE_DIR` is only a legacy fallback, not a required process environment variable. Without any reliable profile location, configure an absolute private `storageDir` before enabling; initialization intentionally fails rather than writing credentials in an arbitrary working directory. Existing explicit storage locations remain unchanged.

Configure row `task-notifications` through DSH's composition/configuration facilities, for example:

```yaml
- id: task-notifications
  name: dsh-plugin-notifications
  config:
    storageDir: /absolute/private/path/dsh-notifications
    publicOrigin: https://dsh.example.com
    vapidSubject: https://example.com/contact
    maxSubscriptions: 32
    # Optional: only notification traffic uses this proxy.
    # proxyUrl: http://127.0.0.1:7890
```

For several HTTPS entry domains use `publicOrigins: [https://dsh.example.com, https://dsh-vpn.example.com]` instead of `publicOrigin`. Requests must still match their original Host and same-origin Origin. Configure DSH's trusted hosts and authenticated reverse proxy separately; the plugin does not trust arbitrary forwarded headers or disable authentication.

`proxyUrl` accepts HTTP/HTTPS CONNECT or SOCKS5/SOCKS5h without embedded credentials. `socks5h` resolves push hostnames at the proxy. Default is direct networking. The Host must reach Google FCM, Apple Web Push or Mozilla Push as appropriate. TLS validation remains enabled.

Set `vapidSubject` to a valid HTTPS contact URL or real contact email. Default is this public GitHub repository URL. Placeholder/invalid subjects can cause Apple `403 BadJwtToken`.

## Enable / 使用

Open Settings → Notifications, enable this device and accept the browser permission. The sidebar bell controls the same state. Each origin/device subscribes separately; all subscribed devices receive this Host's events (not a per-user multi-tenant subscription system). Test delivery before relying on it. Unsubscribe using the device toggle; browser permission revocation may require browser/system settings.

### Local use without a domain / 无域名本机使用

Use `http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>` on the DSH machine. Supporting browsers treat loopback HTTP as trustworthy, so no domain/certificate is required. The plugin automatically permits exact same-origin loopback POSTs even when HTTPS public origins are configured; DSH owner authentication, original Host checks and cross-site rejection remain enforced. Browser notification permission is still required. Different ports/hosts are separate origins and need separate subscriptions.

This exemption does not cover LAN/Tailscale IPs or custom hostnames; remote devices need trusted HTTPS. A phone's localhost refers to that phone, not your DSH computer. iOS Home Screen requirements still apply. Server-to-provider push traffic remains HTTPS.

本机可用上述 HTTP 回环地址开启通知，无需配置域名或证书；不放宽鉴权、跨站或端口匹配检查。远程手机访问电脑仍须 HTTPS，不能用手机的 localhost 代替电脑地址。

### Platform requirements

| Platform | Requirements | Real-device status |
| --- | --- | --- |
| Windows Chrome | HTTPS or local secure context, browser + OS permission | Test/status/approval notifications observed |
| iOS/iPadOS | 16.4+, Safari → Add to Home Screen, launch Home Screen web app, then enable | iPhone notification observed; Apple returned 201 |
| macOS Safari | Safari 16+ on macOS Ventura+, permissions | Standard Web Push implementation; not device-tested |
| macOS Chrome | Secure context, permissions | Not device-tested |
| Android Chrome | HTTPS, permissions | Not device-tested |

Ordinary iOS Safari tabs are not the supported push installation mode. The deployment must provide a standalone web app manifest for Home Screen installation; this plugin does not replace DSH's manifest or root service worker. LAN/VPN deployments require devices to reach that origin for enabling, opening and answering. Do not expose a token-free owner proxy publicly.

DSH and its outbound proxy must stay running. Device connectivity, Focus modes, battery restrictions, browser force quit and push-provider policy can delay or suppress display. Provider acceptance is not proof of OS display. Same event/session notifications may merge by tag; TTL is five minutes. Idle means execution stopped, not necessarily successful completion. This is not a notification for every token, tool step, todo change, external job or schedule.

## Notification detail and privacy / 通知内容和隐私

Notifications broadcast to **all devices subscribed to this Host** and may appear on lock screens. They may include a session title, failed tool name, turn/step number, actual turn-end reason, and up to 140 characters of the last assistant text in a completed turn. A completed turn is not necessarily completion of a longer goal; an individual tool failure is not necessarily final task failure. Detailed delivery on real devices has not yet been verified.

The filter drops lines matching common credential markers, URLs and some file paths and limits length, but **cannot guarantee removal of all secrets or private information**. Result summaries are also stored in DSH's profile projection cache. Avoid subscribing untrusted/shared devices or using this version for sensitive content that must not appear in notifications. Tool arguments, commands, approval reasons, question text and raw exception details are not intentionally included; they can nevertheless appear in assistant-generated text in forms the filter does not recognize.

通知会向本 Host 所有订阅设备广播，可能出现在锁屏；内容可包括会话标题、失败的工具名称、轮次及最多 140 字的助手结果摘要。过滤规则不能保证识别所有敏感信息，摘要也会保存在 profile 投影缓存。涉及敏感任务时不要在不可信设备订阅。本轮完成不等于长期目标已经完成，单次工具失败也不等于最终失败。

## Security / 安全

Owner-browser admission; same-origin POST with Fetch Metadata checks; JSON size/time limits; Google/Apple/Mozilla endpoint allowlist; bounded subscriptions (1–256, default 32), queue and sockets; 404/410 removal; persistent atomic VAPID/subscription storage. Protect and back up the storage directory: private VAPID keys and subscription endpoints are sensitive. Do not run concurrent Hosts against one store. Changing keys requires resubscription.

Dedicated push-only service worker scope `/dsh-notifications/`; no fetch handler, app-shell interception or cache. Stopping the plugin stops sends and removes routes/listeners/UI. Clean up only this worker if needed. Read-only owner diagnostics expose only confirmation event counters/timestamps, not request contents, identifiers or secrets.

Enabling notification authority remains a user click; no agent tool silently grants browser permissions. Waterfall observers return `next()` unchanged and never await network delivery. Push failures cannot prevent approvals/questions or task execution.

## Development and verification

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

Built against DSH 0.2.1-rc.3 extension contracts; other versions require revalidation. Tests cover admission, origins, endpoint safety, persistence, error isolation, proxy forwarding, waterfall semantics, worker rendering/clicks and lifecycle route cleanup. Mock tests do not prove cross-platform device delivery. UI uses additive `settings.section` and `sidebar.footer.action` slots; new layout requires refreshed-client visual verification. Icon is original plugin SVG. No credentials, machine-specific paths, deployment tools or private state are included.

## 中文说明

这是独立双端通知插件，不修改 DSH 核心。通知覆盖同一 Host 全部工作区和会话；侧栏开关只控制当前设备，不影响其他已订阅设备。设置页提供权限和测试入口。点击通知回到 DSH 完成批准或回答，不在系统通知内直接批准。首次启用必须用户点击并授权。

iOS 16.4+ 必须先通过 Safari 添加到主屏幕，从图标打开再启用。Windows Chrome 和 iPhone 已有真实通知送达证据；macOS、Android 尚未真机验收。推送服务接受与系统实际展示分开看待。保护状态目录，不要公开 owner 免登录代理。遇到 502 先查 Host 到对应推送供应商的网络/代理及 VAPID 联系地址，不要反复退订。仅为提醒工具，不能保证每条通知即时、独立展示。
