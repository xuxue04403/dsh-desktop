// machine-adapt.js — 换机首启适配（绿色目录复制到新电脑后，自动清掉"只在本机成立"的配置）
//
// 背景（2026-09-22 打包需求）：网关配置 `data\gateway.config.json` 会随绿色目录一起复制，
// 但里面有几处**只对原机器成立**的内容，换机后必然出问题：
//   ① `accounts[].authFile` 写死了原机器用户名路径（如 C:/Users/xuexu/AppData/...）；
//   ② WorkBuddy 国内版 / 国际版是两家独立供应商，新机装的可能是另一个区域——
//      沿用旧家会命中区域守卫直接报错（凭据互不通用）；
//   ③ `proxy.url` 指向原机器的本地代理（如 127.0.0.1:7890），新机没这个代理时
//      境外供应商全部连不上（且旧的行为会把网络错记在上游账号头上）。
//
// 与 `plugin-snapshot.js` 的分工：那边负责"把插件与 dsh 配置装回来"，这边只负责
// **网关配置的换机适配**。两者都按机器指纹幂等，都只写数据目录。
//
// 安全边界：只改"机器相关"字段；**绝不动** apiKey / apiKeys / 模型映射 / 优先级；
// 改写前一律留 `.bak-machineadapt-*` 备份；任何异常都不阻断启动（返回结果而非抛出）。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const MARKER_NAME = 'machine-adapt.applied.json';

/** 本机指纹（与 plugin-snapshot.machineId 同构：主机名 + 用户名） */
function machineId() {
  let user = '';
  try { user = os.userInfo().username; } catch (_) { user = process.env.USERNAME || ''; }
  return (os.hostname() || '') + '|' + user;
}

function stamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);   // 北京时间口径（与日志一致）
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// ---------------- WorkBuddy 区域判定 ----------------

/** WorkBuddy 桌面 App 凭据文件的平台默认位置（与网关 workbuddyDefaultAuthFiles 保持一致） */
function workbuddyDefaultAuthFiles(roots) {
  const home = os.homedir();
  const rel = ['CodeBuddyExtension', 'Data', 'Public', 'auth'];
  const bases = roots || [
    process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    path.join(home, 'Library', 'Application Support'),   // macOS
    path.join(home, '.config'),                          // Linux
  ];
  const names = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info'];   // 国内版 / 国际版
  const out = [];
  for (const root of bases) for (const n of names) out.push(path.join(root, ...rel, n));
  return out;
}

/** 区域：`workbuddy.ai` → global，其余 → cn（与网关 workbuddyRegionOf 同一判据） */
function regionOfDomain(domain) {
  const d = String(domain || '').toLowerCase().trim();
  return (d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')) ? 'global' : 'cn';
}

/**
 * 探测本机已登录的 WorkBuddy 区域。
 * 判据优先用凭据文件里的 `domain`（权威），文件名只作兜底——
 * 只看文件名会把"国际版文件里其实是国内账号"这类情况判错。
 * @param {string[]} [roots] 覆盖探测根目录（测试注入用；省略则按平台默认 + 环境变量）
 * @returns {{authFile: string, region: string, domain: string}|null}
 */
function detectWorkBuddy(roots) {
  const files = [];
  // 环境变量显式指定优先（与网关 findWorkbuddyAuthFile 一致，便于非标准安装位置）
  if (!roots) {
    for (const name of ['WORKBUDDY_AUTH_FILE', 'WORKBUDDY_AI_AUTH_FILE']) {
      const v = String(process.env[name] || '').trim();
      if (v) files.push(v);
    }
  }
  for (const f of workbuddyDefaultAuthFiles(roots)) files.push(f);
  for (const f of files) {
    let text = null;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    let domain = '';
    try {
      const doc = JSON.parse(text);
      const auth = (doc && doc.auth && typeof doc.auth === 'object') ? doc.auth : doc;
      domain = String((auth && auth.domain) || '');
    } catch (_) { /* 不是 JSON → 用文件名兜底 */ }
    const hasCred = /accessToken/i.test(text);
    if (!domain && !hasCred) continue;                       // 空文件/无凭据 → 不算已登录
    const region = domain ? regionOfDomain(domain)
      : (path.basename(f).includes('-ai.') ? 'global' : 'cn');
    return { authFile: f, region, domain };
  }
  return null;
}

// ---------------- 代理可达性 ----------------

/** 探测本地代理端口是否真的有人监听（TCP 连接，不发 HTTP 请求） */
function probeProxy(url, timeoutMs) {
  return new Promise((resolve) => {
    let target = null;
    try { target = new URL(url); } catch (_) { return resolve({ ok: false, reason: 'URL 非法' }); }
    if (!target.hostname || !target.port) return resolve({ ok: false, reason: '缺少主机或端口' });
    const req = http.request({
      host: target.hostname, port: Number(target.port), method: 'CONNECT',
      path: 'www.example.com:443', timeout: timeoutMs,
    });
    const done = (r) => { try { req.destroy(); } catch (_) { /* 忽略 */ } resolve(r); };
    req.on('connect', () => done({ ok: true }));
    req.on('response', () => done({ ok: true }));            // 有响应就说明端口有人在（代理或别的服务）
    req.on('timeout', () => done({ ok: false, reason: '超时 ' + timeoutMs + 'ms' }));
    req.on('error', (e) => done({ ok: false, reason: (e && e.code) || (e && e.message) || '连接失败' }));
    req.end();
  });
}

// P1（二次复核修复）：单次探测太武断。开机自启场景下代理（clash 等）**晚于**本应用开始监听
// 是常态，一次 1.5s 探测失败就把用户代理永久关掉——代价与收益完全不成比例。改为多次重试。
const PROXY_PROBE_ATTEMPTS = 3;
const PROXY_PROBE_GAP_MS = 700;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带重试的代理可达性探测（任一成功即返回）。 */
async function probeProxyWithRetry(url, timeoutMs) {
  let last = { ok: false, reason: '未探测' };
  for (let i = 0; i < PROXY_PROBE_ATTEMPTS; i++) {
    last = await probeProxy(url, timeoutMs);
    if (last.ok) return last;
    if (i < PROXY_PROBE_ATTEMPTS - 1) await sleepMs(PROXY_PROBE_GAP_MS);
  }
  return last;
}

/**
 * 复检"上次被我们自动关闭的代理"是否已恢复可达（P1 二次复核修复）。
 *
 * 只处理**同时满足**下列全部条件的情况，任一不符即放手（绝不覆盖用户自己的选择）：
 *   ① marker 里记着是我们自动关的；② 配置里代理仍是关闭状态；③ URL 与当初一致；
 *   ④ 配置文件自那次改动后**没有被再写过**（mtime 未变 → 用户没动过设置页）。
 *
 * @returns {Promise<object|null>} 适配结果；null = 无需动作。
 */
async function reconcileAutoDisabledProxy(o, dataDir, configPath, marker, log) {
  const rec = marker && marker.proxyAutoDisabled;
  if (!rec || !rec.url) return null;
  let mtime = 0;
  try { mtime = fs.statSync(configPath).mtimeMs; } catch (_) { return null; }
  // 容差 1ms：某些文件系统的时间戳精度会带来极小抖动
  if (rec.configMtimeMs && Math.abs(mtime - rec.configMtimeMs) > 1) return null;
  const cfg = readJson(configPath);
  if (!cfg || !cfg.proxy || cfg.proxy.enabled !== false) return null;
  if (String(cfg.proxy.url || '') !== String(rec.url)) return null;
  const r = await probeProxyWithRetry(cfg.proxy.url, o.proxyTimeoutMs || 1500);
  if (!r.ok) return null;
  cfg.proxy.enabled = true;
  writeJsonAtomic(configPath, cfg);
  let nm = 0;
  try { nm = fs.statSync(configPath).mtimeMs; } catch (_) { /* 忽略 */ }
  writeJsonAtomic(path.join(dataDir, MARKER_NAME), Object.assign({}, marker, {
    appliedAt: new Date().toISOString(), appliedAtLocal: stamp(), machine: machineId(),
    proxyAutoDisabled: null, proxyReenabledAtLocal: stamp(), proxyReenabledMtimeMs: nm,
  }));
  log('· 代理 ' + rec.url + ' 已恢复可达 → 自动重新启用（上次因本机不可达被关闭）');
  return { ok: true, action: 'adapted', message: '代理已恢复并重新启用', changes: ['代理重新启用：' + rec.url] };
}

/** 判断某个 authFile 是否"指向别处/别的用户"（本机不存在即视为失效） */function authFileStale(p) {
  const s = String(p || '').trim();
  if (!s) return false;                                      // 留空 = 自动发现，本来就对
  try { return !fs.statSync(s).isFile(); } catch (_) { return true; }
}

// ---------------- 主流程 ----------------

/**
 * 换机首启适配。幂等：同一台机器只做一次（标记文件按机器指纹）。
 * @param {object} o { dataDir, log, force, proxyTimeoutMs, workbuddyRoots }
 * @returns {Promise<object>} { ok, action, message, changes }
 */
async function applyIfNeeded(o) {
  const log = (o && o.log) || (() => { });
  const dataDir = o && o.dataDir;
  if (!dataDir) return { ok: false, action: 'skip', message: '缺少数据目录', changes: [] };

  const markerPath = path.join(dataDir, MARKER_NAME);
  const configPath = path.join(dataDir, 'gateway.config.json');
  if (!fs.existsSync(configPath)) {
    return { ok: true, action: 'noop', message: '无网关配置（首次启动会从示例生成）', changes: [] };
  }

  const marker = readJson(markerPath);
  const me = machineId();
  if (!o.force && marker && marker.machine === me) {
    // P1（二次复核修复）："代理被自动关闭"不该是永久决定——见 reconcileAutoDisabledProxy。
    const reconciled = await reconcileAutoDisabledProxy(o, dataDir, configPath, marker, log);
    if (reconciled) return reconciled;
    return { ok: true, action: 'noop', message: '本机已适配过（' + me + '）', changes: [] };
  }

  const cfg = readJson(configPath);
  if (!cfg || !Array.isArray(cfg.providers)) {
    return { ok: false, action: 'skip', message: '网关配置无法解析，跳过适配（不阻断启动）', changes: [] };
  }

  const changes = [];

  // ① WorkBuddy 凭据路径：清掉指向别处/别的用户的绝对路径 → 交回自动发现
  for (const p of cfg.providers) {
    for (const a of (Array.isArray(p.accounts) ? p.accounts : [])) {
      if (a && authFileStale(a.authFile)) {
        changes.push(`${p.id}#${a.id}：authFile 指向本机不存在的路径 → 改为自动发现（原 ${a.authFile}）`);
        delete a.authFile;
      }
    }
  }

  // ② WorkBuddy 区域：按新机实际登录的区域启用对应供应商、停用另一区域
  const wb = cfg.providers.filter((p) => String(p.auth || '').toLowerCase() === 'workbuddy');
  if (wb.length > 0) {
    const found = detectWorkBuddy(o.workbuddyRoots);
    if (!found) {
      for (const p of wb) {
        if (p.enabled !== false) { p.enabled = false; changes.push(`${p.id}：本机未检测到 WorkBuddy 登录凭据 → 停用（避免启动即报凭据错误）`); }
      }
    } else {
      const wanted = found.region === 'global' ? 'workbuddy-global' : 'workbuddy';
      for (const p of wb) {
        const isWanted = (p.id === wanted) || (wb.length === 1);
        if (isWanted && p.enabled === false) { p.enabled = true; changes.push(`${p.id}：启用（本机 WorkBuddy 区域 = ${found.region}，domain=${found.domain || '未知'}）`); }
        if (!isWanted && p.enabled !== false) { p.enabled = false; changes.push(`${p.id}：停用（本机登录的是 ${found.region} 区域，凭据互不通用）`); }
      }
    }
  }

  // ③ 代理：本机连不上就关掉（否则境外供应商全部连不上，且错误会被记在上游账号头上）
  //    P1：改为带重试探测，并把"这是自动关闭的"记进 marker，供下次启动复检。
  let proxyAutoDisabled = null;
  if (cfg.proxy && cfg.proxy.enabled !== false && cfg.proxy.url) {
    const r = await probeProxyWithRetry(cfg.proxy.url, o.proxyTimeoutMs || 1500);
    if (!r.ok) {
      cfg.proxy.enabled = false;
      proxyAutoDisabled = { url: cfg.proxy.url, atLocal: stamp(), reason: String(r.reason || '') };
      changes.push(`代理 ${cfg.proxy.url} 本机不可达（${r.reason}，已重试 ${PROXY_PROBE_ATTEMPTS} 次）→ 已关闭；下次启动会自动复检，本机确有代理也可在设置页启用`);
    }
  }

  if (changes.length === 0) {
    writeJsonAtomic(markerPath, { appliedAt: new Date().toISOString(), appliedAtLocal: stamp(), machine: me, changes: [] });
    return { ok: true, action: 'noop', message: '本机无需适配（配置已是本机可用状态）', changes: [] };
  }

  // 备份后写回
  const bak = configPath + '.bak-machineadapt-' + Date.now();
  try { fs.copyFileSync(configPath, bak); } catch (_) { /* 备份失败不阻断 */ }
  writeJsonAtomic(configPath, cfg);
  // P1：记下写入后的 mtime —— 下次启动据此判断"用户之后是否又动过设置"，
  // 动过（mtime 变化）就不自动改回，避免覆盖用户的主动选择。
  if (proxyAutoDisabled) {
    try { proxyAutoDisabled.configMtimeMs = fs.statSync(configPath).mtimeMs; } catch (_) { /* 忽略 */ }
  }
  writeJsonAtomic(markerPath, Object.assign({
    appliedAt: new Date().toISOString(), appliedAtLocal: stamp(), machine: me,
    from: marker ? marker.machine : null, changes,
  }, proxyAutoDisabled ? { proxyAutoDisabled } : {}));
  changes.forEach((c) => log('· ' + c));
  return { ok: true, action: 'adapted', message: changes.length + ' 项已适配（备份 ' + path.basename(bak) + '）', changes };
}

/** 适配状态（诊断用） */
function status(dataDir) {
  const m = readJson(path.join(dataDir || '', MARKER_NAME));
  if (!m) return { exists: false };
  return {
    exists: true, machine: m.machine, appliedAtLocal: m.appliedAtLocal,
    changes: m.changes || [], currentMachine: machineId(),
  };
}

module.exports = { applyIfNeeded, status, machineId, detectWorkBuddy, regionOfDomain, probeProxy, authFileStale };
