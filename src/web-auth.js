// web-auth.js — 用启动令牌换取会话 cookie（v1.9.0 新增）
//
// 目标：让主窗口的 URL **不再携带 `?token=…`**。
// 现状是 `loadURL(launcher.authUrl)`，令牌因此进入渲染层的 `location`、导航历史，
// 以及任何能读到 location 的页面脚本（dsh 页面里还有第三方插件的客户端脚本）。
//
// 为什么不照搬官方 desktop 的 `dsh-app://` 自定义协议：
//   官方把 Web 前端**打包进自己的 asar**，页面 origin 可以换成隔离协议。DSH-App 用的是
//   **系统 dsh 运行时提供的页面**，实测其客户端这样推导 WebSocket 端点
//   （`@deepseek-ai/dsh-api-gateway` 客户端 bundle）：
//
//       function remoteStreamUrl() {
//         const base = location?.origin !== void 0 && location.origin !== "null"
//           ? location.origin : INTERNAL_BASE;              // INTERNAL_BASE = "http://dsh.internal"
//         const url = new URL("/api/remote.mux", base);
//         url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
//         return url.href;
//       }
//
//   一旦页面 origin 变成 `dsh-app://app`，该地址会解析成 `ws://app/api/remote.mux`，必然连接
//   失败；同一 bundle 另有 9 处用 `location.origin` 推导 API base。并且**不存在**任何注入
//   覆盖通道（已搜 streamBaseUrl / __DSH_STREAM* / connectionBase / wsBase 五种可能的覆盖键，
//   在全部客户端产物中零命中）。所以那条路在本架构下会直接打断实时流。
//
// 采用的做法：**origin 保持不变**，只把令牌换成 cookie 交给 Electron 的 session 持有。
// dsh 的令牌换发本来就是为这个用途设计的——实测 `GET /?token=…` 返回
// `303` + `set-cookie: dsh-auth-…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`
// （host-only，无 Domain、无 Secure），之后带 cookie 即可（不带 cookie 访问首页为 401）。
// 于是：页面 URL 干净、WebSocket 与相对路径 API 全部照旧、零行为改动。
//
// 实现上的两个坑（都实测踩过）：
//   1. **必须用全局 fetch，不能用 session.fetch**。Electron 的 `session.fetch` 对
//      `redirect: 'manual'` 不返回 3xx，而是直接以 `Redirect was cancelled` 拒绝
//      （Electron net 的行为差异，2026-09-25 实际发生）。这里只需要拿到 Set-Cookie，
//      存储由 `session.cookies.set` 显式完成，因此不需要 session 绑定版 fetch。
//   2. cookie 值里绑定了**权威**（`authority: "<host>:<port>"`），端口一变即失效——
//      所以每次 dsh 就绪都要重换一次（调用方在 startService 里复位状态）。
'use strict';

/**
 * 解析一条 `Set-Cookie` 头。
 *
 * `Domain` 被刻意忽略：dsh 签发的是 host-only cookie（响应里没有 Domain 属性），
 * 交给 Electron 依据 `url` 推导最准确；硬塞一个 domain 反而可能被拒绝。
 * `SameSite` 需要做取值域转换——Electron 只认
 * `no_restriction` / `lax` / `strict` / `unspecified`，不认 Set-Cookie 的 `None`。
 *
 * @param {string} line - 原始 Set-Cookie 头。
 * @returns {{name: string, value: string, path?: string, httpOnly?: boolean, secure?: boolean, sameSite?: string, expirationDate?: number}|null}
 *   解析结果；没有可用的 name=value 对时为 null。
 */
function parseSetCookie(line) {
  const parts = String(line || '').split(';');
  const pair = parts.shift() || '';
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  for (const attr of parts) {
    const t = attr.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    const key = (i < 0 ? t : t.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : t.slice(i + 1).trim();
    if (key === 'path') cookie.path = val;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') {
      const v = val.toLowerCase();
      cookie.sameSite = v === 'none' ? 'no_restriction' : (v === 'lax' || v === 'strict') ? v : 'unspecified';
    } else if (key === 'max-age') {
      const n = Number(val);
      if (Number.isFinite(n)) cookie.expirationDate = Math.floor(Date.now() / 1000) + n;
    } else if (key === 'expires' && cookie.expirationDate === undefined) {
      const at = Date.parse(val);
      if (Number.isFinite(at)) cookie.expirationDate = Math.floor(at / 1000);
    }
  }
  return cookie;
}

/**
 * 用启动令牌换取会话 cookie，写进给定 session 的 cookie jar。
 *
 * 全部失败路径都返回 `{ ok:false }` 而不是抛出：调用方据此回退到"带令牌的 URL"，
 * 保证任何异常都不会让界面打不开。
 *
 * @param {object} session - Electron 的 Session（通常 session.defaultSession）。
 * @param {string} authUrl - dsh 就绪行给出的带令牌 URL。
 * @param {(msg: string) => void} [log] - 日志回调。
 * @returns {Promise<{ok: boolean, origin: string, detail: string}>} 换发结果。
 */
async function primeSessionCookie(session, authUrl, log) {
  const say = typeof log === 'function' ? log : () => { /* 无日志渠道 */ };
  let origin = '';
  try {
    origin = new URL(authUrl).origin;
  } catch (err) {
    return { ok: false, origin: '', detail: 'authUrl 非法：' + (err && err.message ? err.message : err) };
  }
  if (!/[?&]token=/.test(String(authUrl))) {
    // 已经是无令牌形态（例如端口轮询兜底补出来的 `http://127.0.0.1:<port>/`）：无需换发
    return { ok: false, origin, detail: 'authUrl 不含令牌' };
  }
  if (!session || !session.cookies || typeof session.cookies.set !== 'function') {
    return { ok: false, origin, detail: '当前 session 不支持 cookie 操作' };
  }

  try {
    // 全局 fetch（Node undici）。**不要**改成 session.fetch —— 后者对 redirect:'manual'
    // 会以 "Redirect was cancelled" 拒绝，拿不到 303 与 Set-Cookie（实测）。
    const res = await fetch(authUrl, { redirect: 'manual' });
    try { await res.body?.cancel(); } catch (_) { /* 只关心状态与响应头 */ }
    if (res.status !== 303) {
      return { ok: false, origin, detail: '令牌换发返回 HTTP ' + res.status + '（预期 303）' };
    }
    const lines = (typeof res.headers.getSetCookie === 'function')
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    if (!lines.length) return { ok: false, origin, detail: '响应未携带 Set-Cookie' };

    const jar = session.cookies;
    let written = 0;
    for (const line of lines) {
      const c = parseSetCookie(line);
      if (!c || !/^dsh-auth-/.test(c.name)) continue;   // 只接管 dsh 的会话 cookie
      const spec = {
        url: origin + '/',
        name: c.name,
        value: c.value,
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite || 'unspecified',
      };
      if (c.expirationDate !== undefined) spec.expirationDate = c.expirationDate;
      await jar.set(spec);
      written++;
    }
    if (!written) return { ok: false, origin, detail: 'Set-Cookie 中没有 dsh-auth-* 条目' };

    // 回读校验：以 jar 为准，不假设 set() 一定生效
    const list = await jar.get({ url: origin + '/' });
    const hit = list.find((c) => /^dsh-auth-/.test(String(c.name)));
    if (!hit) {
      return { ok: false, origin, detail: '写入后 session 中仍未见到 dsh-auth-* cookie（共 ' + list.length + ' 条）' };
    }
    return { ok: true, origin, detail: '已用启动令牌换取会话 cookie「' + hit.name + '」' };
  } catch (err) {
    const detail = '令牌换发异常：' + (err && err.message ? err.message : String(err));
    say(detail);
    return { ok: false, origin, detail };
  }
}

/**
 * 计算应加载的界面 URL。
 * @param {boolean} primed - cookie 是否已就绪。
 * @param {string} authUrl - dsh 就绪行的带令牌 URL。
 * @returns {string} 干净 URL（已换 cookie）或原带令牌 URL（回退）。
 */
function targetUrl(primed, authUrl) {
  if (!primed) return authUrl;
  try {
    return new URL(authUrl).origin + '/';
  } catch (_) {
    return authUrl;   // URL 解析不了就老实回退，绝不构造一个猜出来的地址
  }
}

module.exports = { primeSessionCookie, targetUrl, parseSetCookie };
