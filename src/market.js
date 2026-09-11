// market.js — 插件市场（参考 anywhere-labs/dsh-desktop 的 dsh-community-market 架构）
//
// 设计（学官方安全边界）：
//  - 目录源（catalog source）：默认内置 DSH 1024Store（https://api.dsh1024.store/api/v2/plugins，
//    分页 JSON），支持用户添加同契约源（v1: /v1/plugins 标准端点的最小实现留接口）。
//  - 源数据只用于"发现"：源提供的版本**永不作为安装目标**（防投毒）；源命令字符串一律丢弃。
//  - 安装资格（自动安装三条件，照搬官方）：
//      1) 条目恰好含一个合法 npm 包名；
//      2) npm registry 的 latest 元数据：同名 + 精确稳定版本；
//      3) manifest 声明有效 dsh.bundle.patch 相对路径。
//  - 安装/卸载统一走标准 dsh CLI（dsh plugin add/remove）——与手工命令完全一致，
//    市场/CLI/手工三途径互通，已安装视图从 dsh 真实 profile 状态读取（不影响自装插件）。
//  - 网络走 https（Electron net 或 node https）；npm 元数据默认 npmmirror（DSH_NPM_REGISTRY 可覆盖）。
'use strict';

const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------- 源 ----------------
// 默认源：dshfind（官方 market 的合作源；标准 provider page 契约 /market/v1/plugins，
// npm 身份经 install.methods 的 repository_backlink 验证——比 1024Store 更严格）。
// 备选源：DSH 1024Store v2（官方另一合作源；实测 api.dsh1024.store 当前 ECONNRESET，
// 保留配置待其恢复）。
const BUILTIN_SOURCES = [
  {
    id: 'dshfind',
    name: 'dshfind',
    kind: 'dshfind-v1',
    endpoint: 'https://api.dshfind.com/market/v1/plugins',
    attribution: { name: 'dshfind', url: 'https://dshfind.com' },
  },
  {
    id: 'dsh-1024store',
    name: 'DSH 1024Store',
    kind: '1024store-v2',
    endpoint: 'https://api.dsh1024.store/api/v2/plugins',
    attribution: { name: 'DSH 1024Store', url: 'https://dsh1024.store' },
  },
];

// 网络层：统一用 fetch（node/Electron 均原生支持；NODE_USE_ENV_PROXY=1 时自动走
// HTTPS_PROXY——与网关同款代理链路；1024Store 等境外源需经 clash 类代理可达）。
// market 在 Electron 主进程运行：进程启动较早可能没有 NODE_USE_ENV_PROXY——这里按
// 需要开启（fetch 的 env 代理在进程内即时生效）；代理地址跟随网关配置或默认 7890。
function ensureProxyEnv() {
  if (process.env.DSH_MARKET_NO_PROXY) return;   // 显式禁用开关
  // 已有代理环境变量 → 直接启用 env 代理链路
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1';
    return;
  }
  // 审计修复（P2）：只跟随网关配置里**显式启用**的代理；未配置就直连。
  // 旧版在没有配置时无条件兜底 http://127.0.0.1:7890——未运行 clash 的机器上所有 fetch
  // 都变成 ECONNREFUSED（表现为"市场一直加载失败"），而且该变量是**主进程全局**，
  // 会连带影响壳内其他 fetch。与网关侧 R25「不再无条件注入 7890」保持一致。
  try {
    const cfgPath = process.env.DSH_GATEWAY_CONFIG
      || path.join(path.dirname(process.execPath), 'data', 'gateway.config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.proxy && cfg.proxy.enabled && cfg.proxy.url) {
        const url = String(cfg.proxy.url);
        process.env.HTTPS_PROXY = url.includes('://') ? url : 'http://' + url;
        process.env.HTTP_PROXY = process.env.HTTPS_PROXY;
        process.env.NODE_USE_ENV_PROXY = '1';
      }
    }
  } catch (_) { /* 忽略：直连 */ }
}

async function httpsGetJson(url, timeoutMs = 15000) {
  ensureProxyEnv();
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-app-market/1.0' },
      signal: c.signal,
      redirect: 'error',   // 官方同款：拒绝非预期跳转
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    if (text.length > 8 * 1024 * 1024) return { ok: false, status: 'too-large' };
    try { return { ok: true, data: JSON.parse(text) }; }
    catch (_) { return { ok: false, status: 'parse' }; }
  } catch (e) {
    clearTimeout(t);
    const name = (e && e.name) === 'AbortError' ? 'timeout' : 'network';
    return { ok: false, status: name };
  }
}

// npm 包名校验（官方契约同规则：scoped/普通 npm 名）
function isValidNpmName(name) {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(String(name || '')) && name.length <= 214;
}

// ---------------- 统一发现入口（按源类型分发）----------------
async function discover(sourceId, q, category, cursor, limit) {
  const source = BUILTIN_SOURCES.find((s) => s.id === (sourceId || 'dshfind')) || BUILTIN_SOURCES[0];
  if (source.kind === 'dshfind-v1') return fetchDshfind(source, q, category, cursor, limit);
  if (source.kind === '1024store-v2') return fetch1024Store(source, q, category, cursor, limit);
  return { ok: false, error: 'unknown-source' };
}

// ---------------- 1024Store v2 适配 ----------------
// 官方 adapter 语义：分页查询、丢弃命令字符串、只取 npm 包身份；版本仅展示不作安装目标。
async function fetch1024Store(source, q, category, cursor, limit) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(Math.min(Math.max(limit || 50, 1), 100)));
  const r = await httpsGetJson(source.endpoint + '?' + params.toString());
  if (!r.ok) return { ok: false, error: 'source-' + r.status };
  const data = r.data || {};
  const items = Array.isArray(data.items) ? data.items : (Array.isArray(data.data) ? data.data : []);
  const normalized = items.map((it) => normalizeEntry(it)).filter(Boolean);
  return {
    ok: true,
    items: normalized,
    nextCursor: (data.page && data.page.nextCursor) || data.nextCursor || null,
    total: (data.page && data.page.total) || data.total || null,
  };
}

// 条目标准化：提取展示字段 + npm 包身份（一个条目可能没有/有一个 npm 包）
function normalizeEntry(it) {
  if (!it || typeof it !== 'object') return null;
  const id = String(it.id || it.pluginId || it.uuid || '').slice(0, 160);
  const name = String(it.name || it.title || it.pluginName || '').slice(0, 200);
  if (!id && !name) return null;
  const summary = String(it.summary || it.description || it.desc || '').slice(0, 600);
  // npm 包身份：优先显式 npm 字段；兼容官方"从 inert 命令恢复 npm 名"——但只接受精确
  // `dsh plugin ... add <npm-package>` 形态里的包名片段，绝不执行任何命令。
  let pkg = '';
  if (it.npmPackage && isValidNpmName(it.npmPackage)) pkg = it.npmPackage;
  else if (it.npm && isValidNpmName(it.npm)) pkg = it.npm;
  else if (it.packageName && isValidNpmName(it.packageName)) pkg = it.packageName;
  else if (it.install && typeof it.install === 'string') {
    const m = it.install.match(/dsh\s+plugin[^\s]*\s+(?:--profile\s+\S+\s+)?add\s+((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)/i);
    if (m && isValidNpmName(m[1])) pkg = m[1];
  }
  const cats = Array.isArray(it.categories) ? it.categories.map(String).slice(0, 5)
    : (it.category ? [String(it.category)] : []);
  return {
    id: id || name,
    name,
    displayName: String(it.displayName || name).slice(0, 200),
    summary,
    version: it.version ? String(it.version).slice(0, 40) : '',   // 仅展示
    author: it.author ? String(it.author).slice(0, 120) : '',
    homepage: /^https:\/\//.test(String(it.homepage || it.repo || it.repository || '')) ? String(it.homepage || it.repo || it.repository) : '',
    categories: cats,
    pkg,           // '' = 仅可浏览（如 GitHub-only 条目）
  };
}

// ---------------- dshfind v1 适配（默认源）----------------
// /market/v1/plugins 返回的已是标准 provider page（官方 catalog-provider-page schema）：
//   items[]: { id, name, displayName, summary, repository{url}, package{registry:'npm',name},
//              publisher{name,url}, categories[], latestVersion, updatedAt }, page{nextCursor,total}
// 直接按 schema 解析：package.name 就是已验证 npm 身份（服务端做了 repository_backlink
// 审核）；latestVersion 仅作展示——安装仍以 npm registry latest 校验为准（官方边界）。
function normalizeDshfindItem(it) {
  if (!it || typeof it !== 'object') return null;
  const name = String(it.name || it.displayName || '').slice(0, 120);
  const id = String(it.id || '').slice(0, 160);
  if (!name || !id) return null;
  const pkgObj = (it.package && typeof it.package === 'object') ? it.package : null;
  const pkg = (pkgObj && pkgObj.registry === 'npm' && isValidNpmName(pkgObj.name)) ? pkgObj.name : '';
  return {
    id,
    name,
    displayName: String(it.displayName || name).slice(0, 200),
    summary: String(it.summary || '').slice(0, 600),
    version: it.latestVersion ? String(it.latestVersion).slice(0, 40) : '',   // 仅展示
    author: (it.publisher && it.publisher.name) ? String(it.publisher.name).slice(0, 120) : '',
    homepage: (it.repository && /^https:\/\//.test(String(it.repository.url || ''))) ? String(it.repository.url) : '',
    categories: Array.isArray(it.categories) ? it.categories.map(String).slice(0, 5) : [],
    pkg,
  };
}

async function fetchDshfind(source, q, category, cursor, limit) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(Math.min(Math.max(limit || 50, 1), 50)));
  const r = await httpsGetJson(source.endpoint + '?' + params.toString());
  if (!r.ok) return { ok: false, error: 'source-' + r.status };
  const data = r.data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const normalized = items.map(normalizeDshfindItem).filter(Boolean);
  return {
    ok: true,
    items: normalized,
    nextCursor: (data.page && data.page.nextCursor) || null,
    total: (data.page && data.page.total) || null,
  };
}

// ---------------- npm 元数据校验（安装预览）----------------
// 官方规则：latest 同名 + 精确稳定版本 + 有效 dsh.bundle.patch 相对路径
async function npmPreview(pkgName) {
  if (!isValidNpmName(pkgName)) return { ok: false, reason: 'invalid-name' };
  const registry = (process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com').replace(/\/+$/, '');
  // scoped 包标准 URL 形式：@scope%2Fpkg（npm registry 规范）；普通包原样。
  const pkgPath = pkgName.startsWith('@')
    ? pkgName.replace(/^@([^/]+)\//, '@$1%2F')
    : encodeURIComponent(pkgName);
  const r = await httpsGetJson(registry + '/' + pkgPath + '/latest', 12000);
  if (!r.ok) return { ok: false, reason: 'npm-' + r.status };
  const m = r.data || {};
  if (m.name !== pkgName) return { ok: false, reason: 'name-mismatch' };
  const version = String(m.version || '');
  if (!/^\d+\.\d+\.\d+(?:[-.][\w.]+)?$/.test(version)) return { ok: false, reason: 'no-stable-version' };
  const dsh = (m.dsh && typeof m.dsh === 'object') ? m.dsh : null;
  const patch = dsh && typeof dsh.bundle === 'object' && typeof dsh.bundle.patch === 'string'
    ? dsh.bundle.patch : (m['dsh.bundle.patch'] || null);
  if (!patch || typeof patch !== 'string' || /^(?:[a-zA-Z]:|\/|\\)/.test(patch) || patch.includes('..')) {
    return { ok: false, reason: 'no-bundle-patch', name: m.name, version };
  }
  return { ok: true, name: m.name, version, patch, description: String(m.description || '').slice(0, 300) };
}

// ---------------- 已安装（读 dsh 真实状态）----------------
// dsh web 的 profile：~/.dsh/profiles/web/（manifest package.json 的 dependencies
// + dsh.profile.bundles/或 cordis.patch.yml）。市场/CLI/手工安装在此完全同源。
function installedPlugins() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const out = { ok: true, profile: 'web', dir: '', plugins: [] };
  const candidates = ['web', 'desktop', 'default'];
  for (const p of candidates) {
    const dir = path.join(home, 'profiles', p);
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      out.profile = p; out.dir = dir;
      try {
        const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        const deps = (j.dependencies && typeof j.dependencies === 'object') ? j.dependencies : {};
        const bundles = (j.dsh && j.dsh.profile && Array.isArray(j.dsh.profile.bundles)) ? j.dsh.profile.bundles : [];
        const bundleSet = new Set(bundles.map(String));
        for (const [name, ver] of Object.entries(deps)) {
          out.plugins.push({
            name,
            version: String(ver || '').replace(/^[^\d]*/, ''),
            isBundle: bundleSet.has(name),
          });
        }
      } catch (e) { out.error = 'manifest-parse'; }
      break;
    }
  }
  return out;
}

// ---------------- 安装/卸载（标准 dsh CLI，隐藏窗口）----------------
// 与手工 `dsh plugin add/remove` 完全一致；经内嵌运行时执行；Windows 用 cmd broker 防黑窗。
// v1.5.18b：dsh plugin 内部 spawnSync("pnpm", …, {cwd: profileDir, shell:true})——
// 必须让 dsh 在 PATH 里找到 pnpm 且能解析 node。这里注入：
//   PATH 前置 [应用根目录(node.exe), 私有 pnpm shim 目录]
//   NODE=<应用根目录>\node.exe（pnpm 生命周期脚本用）
//   pnpm.cmd shim：调内嵌运行时跑内置 resources\node_modules\pnpm\bin\pnpm.cjs
class MarketOps {
  constructor(opts) {
    this.nodeInfo = opts.nodeInfo || { exe: 'node', env: {}, embedded: false };
    this.dshBin = opts.dshBin || null;       // findDsh().bin
    this.log = opts.log || (() => { });
  }

  _brokerDir() {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(home, 'market');
  }

  // 准备 pnpm shim + 注入 PATH/NODE 的环境（返回 env；失败时原样返回）
  _envWithPnpm(baseEnv) {
    const env = Object.assign({}, baseEnv || process.env,
      this.nodeInfo && this.nodeInfo.env ? this.nodeInfo.env : {});
    try {
      const appDir = path.dirname(process.execPath);
      const pnpmCjs = path.join(appDir, 'resources', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
      if (!fs.existsSync(pnpmCjs)) {
        this.log('内置 pnpm 缺失（' + pnpmCjs + '）——插件安装/卸载将失败');
        return env;
      }
      const privBin = this._brokerDir();
      fs.mkdirSync(privBin, { recursive: true });
      const shim = path.join(privBin, 'pnpm.cmd');
      fs.writeFileSync(shim, [
        '@echo off',
        'setlocal DisableDelayedExpansion',
        'set "ELECTRON_RUN_AS_NODE=1"',
        `"${process.execPath}" "${pnpmCjs}" %*`,
        'exit /b %errorlevel%',
        '',
      ].join('\r\n'), 'utf8');
      env.PATH = appDir + path.delimiter + privBin + path.delimiter + (env.PATH || '');
      env.NODE = path.join(appDir, 'node.exe');
    } catch (e) {
      this.log('pnpm 环境准备失败：' + (e && e.message ? e.message : e));
    }
    return env;
  }

  _run(argv, onLine) {
    const nodePath = typeof this.nodeInfo === 'string' ? this.nodeInfo : this.nodeInfo.exe;
    const env = this._envWithPnpm(process.env);
    return new Promise((resolve) => {
      let child;
      // 审计中-1：子进程超时兜底——挂死则 kill 并按失败返回（与 launcher/updater 的
      // 5 分钟超时对齐取 10 分钟：插件安装含 pnpm 全新解析时可能较慢）
      const TIMEOUT_MS = 10 * 60 * 1000;
      const timer = setTimeout(() => {
        try { child && child.kill(); } catch (_) { /* 忽略 */ }
        resolve({ ok: false, error: 'timeout', output: '' });
      }, TIMEOUT_MS);
      const finish = (value) => { clearTimeout(timer); resolve(value); };
      if (process.platform === 'win32' && this.nodeInfo && this.nodeInfo.embedded && this.dshBin) {
        // cmd broker：隐藏控制台宿主（v1.5.17e 同款）——dsh plugin 的子进程不弹窗
        try {
          const dir = this._brokerDir();
          fs.mkdirSync(dir, { recursive: true });
          const broker = path.join(dir, 'plugin-op.cmd');
          fs.writeFileSync(broker, [
            '@echo off',
            'setlocal DisableDelayedExpansion',
            'set "ELECTRON_RUN_AS_NODE=1"',
            `"${process.execPath}" --expose-internals "${this.dshBin}" ${argv.map((a) => '"' + a + '"').join(' ')}`,
            'exit /b %errorlevel%',
            '',
          ].join('\r\n'), 'utf8');
          child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', broker], {
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
          });
        } catch (_) {
          child = spawn(nodePath, ['--expose-internals', this.dshBin].concat(argv), {
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
          });
        }
      } else if (this.dshBin) {
        child = spawn(nodePath, ['--expose-internals', this.dshBin].concat(argv), {
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
        });
      } else {
        finish({ ok: false, error: 'dsh-not-found' });
        return;
      }
      let out = '';
      if (child.stdout) child.stdout.on('data', (c) => { const t = c.toString('utf8'); out += t; if (onLine) onLine(t.trimEnd()); });
      if (child.stderr) child.stderr.on('data', (c) => { const t = c.toString('utf8'); out += t; if (onLine) onLine(t.trimEnd()); });
      child.on('error', (e) => finish({ ok: false, error: e.message, output: out }));
      child.on('exit', (code) => finish({ ok: code === 0, code, output: out }));
    });
  }

  // 审计修复（P1，安全）：包名在写进 broker .cmd 之前必须校验。旧版直接把渲染层传来的
  // 字符串引号包裹后拼进 cmd 脚本——含 `"`/`&` 的名字可越出引号执行任意命令
  // （市场条目路径虽已校验，但 IPC 是公共入口：主窗口/被注入脚本可直接调用）。
  // 内部默认插件走的是 `file:vendor/...` 规格，仅当调用方显式 allowFile 时放行，
  // 且同样限制在无引号/空格/元字符的字符集内。
  install(pkgName, onLine, opts) {
    const name = String(pkgName == null ? '' : pkgName).trim();
    const fileOk = !!(opts && opts.allowFile) && /^file:[A-Za-z0-9._/-]+$/.test(name);
    if (!isValidNpmName(name) && !fileOk) {
      this.log('已拒绝安装：非法包规格 ' + JSON.stringify(String(pkgName)));
      return Promise.resolve({ ok: false, error: 'invalid-name', output: '' });
    }
    return this._run(['plugin', '--profile', 'web', 'add', name], onLine);
  }

  remove(pkgName, onLine) {
    const name = String(pkgName == null ? '' : pkgName).trim();
    if (!isValidNpmName(name)) {
      this.log('已拒绝卸载：非法 npm 包名 ' + JSON.stringify(String(pkgName)));
      return Promise.resolve({ ok: false, error: 'invalid-name', output: '' });
    }
    return this._run(['plugin', '--profile', 'web', 'remove', name], onLine);
  }
}

module.exports = { BUILTIN_SOURCES, discover, fetchDshfind, fetch1024Store, npmPreview, installedPlugins, MarketOps, isValidNpmName };