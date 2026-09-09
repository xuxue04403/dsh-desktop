// launcher.js — dsh web 进程管理（发现/启动/停止/健康/URL 就绪行解析）
//
// 升级兼容契约（与 dsh 版本无关的稳定面）：
//   1) dsh web --no-open --port <n>            —— 启动参数（0.1.2-rc.1 与 0.1.3-alpha.1 一致）
//   2) stdout 就绪行 "dsh web: http://127.0.0.1:<port>/?token=..."（printUrl 默认 true）
//   3) --patch <yml> 覆盖层（安全模式禁用故障插件）
//   4) 直接 spawn node bin.js（不经 cmd.exe / shim，规避 cmd 引号/参数破坏问题）
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

// dsh web 的 stdout 就绪行
const REGEX_URL_LINE = /dsh web:\s*(https?:\/\/[^\s\)]+)/;
// 等待就绪超时（毫秒）
const READY_TIMEOUT = 90 * 1000;

// 简易版本比较：'0.1.3-alpha.1' vs '0.1.2-rc.1'
function compareVersions(a, b) {
  const parse = (v) =>
    (v || '').split(/[.-]/).map((s) => (/^\d+$/.test(s) ? parseInt(s, 10) : s));
  const pa = parse(a), pb = parse(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x > y ? 1 : -1;
    } else if (String(x) !== String(y)) {
      return String(x) > String(y) ? 1 : -1;
    }
  }
  return 0;
}

// 定位 node 运行时（v1.5.17 内嵌优先）：
//  1) 打包后的本程序 exe + ELECTRON_RUN_AS_NODE=1 —— Electron 二进制即纯 Node 运行时
//     （零系统依赖：用户机器无需安装 node；运行时版本随应用打包，一致可控）
//  2) 开发模式（未打包，electron 从 node_modules 起）→ 回退系统 node
//  3) 系统 node（nvm-windows / 标准安装 / PATH 兜底）
// 返回 { exe, env }：spawn 时合并 env（内嵌模式需 ELECTRON_RUN_AS_NODE=1）
function findNode() {
  // 打包判定：electron 主进程默认 exe；app.isPackaged 在 main 传入（避免此模块依赖 electron）
  const packaged = !process.defaultApp && process.resourcesPath && process.resourcesPath.endsWith('resources');
  if (packaged) {
    return {
      exe: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      embedded: true,
    };
  }
  // 开发模式：系统 node
  const candidates = [];
  const appData = process.env.APPDATA || '';
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  candidates.push(path.join(pf, 'nodejs', 'node.exe'));
  for (const root of [path.join(appData, 'nvm'), path.join(local, 'nvm')]) {
    try {
      const vers = fs.readdirSync(root)
        .filter((v) => /^v\d/.test(v))
        .sort((x, y) => compareVersions(y.slice(1), x.slice(1)));
      for (const v of vers) candidates.push(path.join(root, v, 'node.exe'));
    } catch (_) { /* 忽略 */ }
  }
  for (const c of candidates) if (fs.existsSync(c)) return { exe: c, env: {}, embedded: false };
  return { exe: 'node', env: {}, embedded: false };
}

// 兼容旧调用（tests 等直接当字符串用）：字符串化处理
function findNodeStr() {
  const n = findNode();
  return typeof n === 'string' ? n : n.exe;
}

// 内嵌 npm-cli.js 定位（v1.5.17）：打包在 resources\node_modules\npm（asar 外的真实文件
// ——ELECTRON_RUN_AS_NODE 子进程读不了 asar 内文件，故 build-portable 放 asar 外）。
// 用途：dsh 首次安装/自动升级（DSH-App.exe 作为 node 跑 npm-cli.js，零系统依赖）。
function findEmbeddedNpmCli() {
  const candidates = [];
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  } catch (_) { /* 忽略 */ }
  // 开发模式：项目内 node_modules
  candidates.push(path.join(__dirname, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* 忽略 */ }
  }
  return null;
}

// v1.5.17a：为安装环境准备"node 可用"的 PATH（关键修复）。
// dsh 的原生依赖（koffi/node-pty）postinstall 脚本直接调 `node`——零依赖机器上
// PATH 没有 node 会失败（'node' 不是内部或外部命令）→ 整个安装失败。
// 方案：把应用 exe 硬链接/复制为「应用根目录」\node.exe（与 DSH-App.exe 同目录——
// Electron 依赖的同目录 DLL 完整；不能放 prefix/data 下——那里无 DLL，启动报
// 0xC0000135 STATUS_DLL_NOT_FOUND），并把应用根目录注入子进程 PATH 头部——
// postinstall 的 `node` 即解析到内嵌运行时。返回 { env }。
function prepareEmbeddedInstallEnv(prefix, baseEnv) {
  const env = Object.assign({}, baseEnv || process.env, { ELECTRON_RUN_AS_NODE: '1' });
  try {
    const appDir = path.dirname(process.execPath);
    const nodeExe = path.join(appDir, 'node.exe');
    if (!fs.existsSync(nodeExe)) {
      try {
        fs.linkSync(process.execPath, nodeExe);         // 硬链接优先（同盘零拷贝）
      } catch (_) {
        fs.copyFileSync(process.execPath, nodeExe);     // 回退复制（同目录，DLL 完整）
      }
    }
    env.PATH = appDir + path.delimiter + (env.PATH || '');
    return { env, nodeExe };
  } catch (_) {
    return { env, nodeExe: null };
  }
}

// 发现已安装的 @deepseek-ai/dsh（npm 全局 / npx 缓存 / 便携前缀），返回版本最高者
// 返回 { dir, version, bin }；无则返回 null
// v1.5.17：新增便携前缀 <exe旁data>\node-global（内嵌运行时方案的安装位置，绿色随程序走）
function findDsh() {
  const candidates = [];
  const local = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const roots = [
    path.join(appData, 'npm', 'node_modules'),             // npm 默认全局前缀（非 nvm）
    path.join(local, 'npm-cache', '_npx'),                 // npx 缓存（每个 hash 一个）
    path.join(pf, 'nodejs', 'node_modules'),               // 标准安装全局
  ];
  // 便携前缀（exe 旁 data\node-global\node_modules）——内嵌运行时安装位置，优先级最高
  try {
    const portable = path.join(path.dirname(process.execPath), 'data', 'node-global', 'node_modules');
    if (fs.existsSync(portable)) roots.unshift(portable);
  } catch (_) { /* 忽略 */ }
  try {
    if (process.env.DSH_DATA_DIR) {
      roots.unshift(path.join(process.env.DSH_DATA_DIR, 'node-global', 'node_modules'));
    }
  } catch (_) { /* 忽略 */ }
  // nvm-windows：npm 全局根 = nvm 根（node_modules 平铺在各 nvm 版本目录里）
  try {
    const nvmRoots = [path.join(appData, 'nvm'), path.join(local, 'nvm')];
    for (const root of nvmRoots) {
      const vers = fs.readdirSync(root).filter((v) => /^v\d/.test(v));
      for (const v of vers) roots.push(path.join(root, v, 'node_modules'));
    }
  } catch (_) { /* 忽略 */ }

  for (const root of roots) {
    try {
      if (root.endsWith('_npx')) {
        for (const hash of fs.readdirSync(root)) {
          candidates.push(path.join(root, hash, 'node_modules'));
        }
      } else {
        candidates.push(root);
      }
    } catch (_) { /* 忽略 */ }
  }

  let best = null;
  for (const base of candidates) {
    const dir = path.join(base, '@deepseek-ai', 'dsh');
    const pkg = path.join(dir, 'package.json');
    try {
      if (!fs.existsSync(pkg)) continue;
      const info = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (best === null || compareVersions(info.version, best.version) > 0) {
        best = { dir, version: info.version, bin: path.join(dir, 'lib', 'bin.js') };
      }
    } catch (_) { /* 忽略 */ }
  }
  if (best && fs.existsSync(best.bin)) return best;
  return null;
}

class Launcher extends EventEmitter {
  /**
   * @param {object} opts { settings, logger, workDir }
   */
  constructor(opts) {
    super();
    this.settings = opts.settings;
    this.log = opts.logger.appendLog.bind(opts.logger);
    this.workDir = opts.workDir;
    this.proc = null;
    this.nodePath = null;      // 字符串（兼容旧引用：启动 dsh 的 node 可执行文件）
    this.nodeInfo = null;      // { exe, env, embedded }
    this.found = null;
    this.authUrl = '';
    this.running = false;
    this.ready = false;
    this.manualStop = false;   // 手动停止标志：避免退出事件触发看门狗
  }

  detect() {
    this.nodeInfo = findNode();
    this.nodePath = typeof this.nodeInfo === 'string' ? this.nodeInfo : this.nodeInfo.exe;
    this.found = findDsh();
    return this.found;
  }

  get version() {
    return this.found ? this.found.version : '';
  }

  // dsh 便携安装前缀（内嵌运行时方案）：<data>\node-global —— npm --prefix 安装位置，
  // 绿色随程序目录走，升级即同前缀重装。dsh 配置/会话在 ~/.dsh 不受影响。
  portablePrefix() {
    try {
      const dataDir = this.settings && this.settings.dataDir ? this.settings.dataDir
        : (process.env.DSH_DATA_DIR || path.join(path.dirname(process.execPath), 'data'));
      return path.join(dataDir, 'node-global');
    } catch (_) {
      return path.join(path.dirname(process.execPath), 'data', 'node-global');
    }
  }

  // 启动（安全模式时自动追加 --patch）。
  // v1.5.17a：首次安装改为**异步**（原 spawnSync 会阻塞 Electron 主进程最多 5 分钟，
  // UI 表现为"正在启动中"一直转圈）；失败路径保证 this.proc 不为 null 的兜底（错误事件
  // 处理依赖 proc），并在安装失败时发出 'install-failed' 事件让 UI 及时反馈。
  start() {
    if (this.proc) return;
    this.ready = false;
    this.authUrl = '';
    this.manualStop = false;
    const port = this.settings.data.port;
    const patch = this.settings.data.safeMode ? this.settings.safePatchPath : null;

    let args = ['web', '--no-open', '--port', String(port)];
    if (patch && fs.existsSync(patch)) args.push('--patch', patch);

    const found = this.found;
    // spawn env：内嵌运行时需要 ELECTRON_RUN_AS_NODE=1
    const spawnEnv = Object.assign({}, process.env,
      this.nodeInfo && this.nodeInfo.env ? this.nodeInfo.env : {});

    if (found) {
      this._spawnDsh(args, spawnEnv);
    } else {
      // 本机无 dsh → 首次自动安装（异步，不阻塞 UI）：
      // 优先内嵌 npm（装到 data\node-global 便携前缀，零系统依赖）；
      // 回退 npx（系统有 node 的环境）。
      this._installAndStart(args, spawnEnv);
    }
  }

  _spawnDsh(args, spawnEnv) {
    const target = this.found || null;
    if (!target) return false;
    // v1.5.17b：dsh 的 HMR 插件要求 node 以 --expose-internals 启动（Node 22+ 的
    // cordis-plugin-hmr 依赖内部 API；缺此参数服务起后数秒即崩：
    // "--expose-internals is required for HMR service"）。内嵌运行时（Electron 的
    // node 模式）与系统 node 均支持该参数，固定带上。
    const nodeArgs = ['--expose-internals', target.bin].concat(args);
    this.log('启动 dsh ' + target.version + ' → ' + this.nodePath + ' ' + nodeArgs.join(' '));
    this.proc = spawn(this.nodePath, nodeArgs, {
      cwd: this.workDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv,
    });
    this.running = true;
    this._wireProc();
    return true;
  }

  _wireProc() {
    const p = this.proc;
    if (!p) return;
    p.on('error', (err) => {
      this.running = false;
      this.emit('error', err);
    });
    p.on('exit', (code, signal) => {
      this.running = false;
      this.emit('exit', code, signal);
    });
    this.bindOutput();
  }

  async _installAndStart(args, spawnEnv) {
    const npmCli = findEmbeddedNpmCli();
    if (npmCli && this.nodeInfo && this.nodeInfo.embedded) {
      const prefix = this.portablePrefix();
      this.log('未发现本机 dsh，使用内嵌 npm 安装到便携目录 ' + prefix + ' …（首次约 1-3 分钟，界面可继续操作）');
      try {
        // 关键（v1.5.17a）：dsh 原生依赖（koffi/node-pty）postinstall 调 `node`——
        // 把 app exe 拷为 <prefix>\node.exe 并注入 PATH，零依赖机器上安装才能成功
        const prep = prepareEmbeddedInstallEnv(prefix, spawnEnv);
        // v1.5.17c：默认走 npmmirror 镜像——npm 默认源在国内网络会部分包下载残缺
        // （实测 zod 目录存在但 index.js 缺失 → dsh 启动报 ERR_MODULE_NOT_FOUND）；
        // DSH_NPM_REGISTRY 可覆盖。加 --force 确保残缺安装被完整重装。
        const registry = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';
        const { spawn: spawnAsync } = require('child_process');
        const install = await new Promise((resolve) => {
          const child = spawnAsync(this.nodePath, [npmCli, 'install', '-g', '--prefix', prefix,
            '@deepseek-ai/dsh@latest', '--no-fund', '--no-audit', '--force', '--registry', registry], {
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: prep.env,
          });
          let out = '';
          const t = setTimeout(() => { try { child.kill(); } catch (_) { /* 忽略 */ } resolve({ status: 1, output: out + '\n[超时] 5 分钟' }); }, 5 * 60 * 1000);
          if (child.stdout) child.stdout.on('data', (c) => { out += c; });
          if (child.stderr) child.stderr.on('data', (c) => { out += c; });
          child.on('error', (e) => { clearTimeout(t); resolve({ status: 1, output: String(e) }); });
          child.on('exit', (code) => { clearTimeout(t); resolve({ status: code, output: out }); });
        });
        if (install.status === 0) {
          this.log('dsh 安装完成（便携前缀），正在启动…');
          this.detect();   // 重新扫描（便携前缀在 findDsh 扫描列表内）
          if (this.found && this._spawnDsh(args, spawnEnv)) return;
          this.log('安装完成但未检测到 dsh，回退 npx…');
        } else {
          this.log('内嵌 npm 安装失败（退出码 ' + install.status + '）：' + String(install.output || '').slice(-300));
        }
      } catch (e) {
        this.log('内嵌 npm 安装异常：' + (e && e.message ? e.message : e));
      }
    }
    // 回退：npx（系统 node 环境）——零依赖机器上 npx 不存在时也会触发 error 事件（UI 显示失败）
    if (!this.proc) {
      this.log('未发现本机 dsh，使用 npx 自动下载安装并启动…');
      this.proc = spawn('npx', ['--yes', '@deepseek-ai/dsh'].concat(args), {
        cwd: this.workDir, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.running = true;
      this._wireProc();
    }
  }

  bindOutput() {
    const p = this.proc;
    if (!p || !p.stdout) return;
    let buf = '';
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      this.logRaw(text);
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        const m = REGEX_URL_LINE.exec(line);
        if (m) {
          this.authUrl = m[1];
          this.ready = true;
          this.emit('url', this.authUrl);
        }
      }
    };
    p.stdout.on('data', onData);
    if (p.stderr) p.stderr.on('data', (chunk) => this.logRaw(chunk.toString('utf8')));
  }

  logRaw(text) {
    try {
      const { appendWeb } = require('./logger');
      appendWeb(text.trimEnd());
    } catch (_) { /* 忽略 */ }
  }

  // HTTP 健康探测：2xx/4xx 都算服务活着（401 是浏览器信任门槛，仍证明服务在线）
  probeHealth(port, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  // 等待就绪：优先 stdout URL 行；超时后回退端口探测
  async waitReady(timeoutMs = READY_TIMEOUT) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.ready && this.authUrl) return this.authUrl;
      if (await this.probeHealth(this.settings.data.port, 1500)) {
        // 端口在线但未读到 URL 行（极旧版本）→ 用明文 URL
        if (!this.authUrl) this.authUrl = 'http://127.0.0.1:' + this.settings.data.port + '/';
        this.ready = true;
        return this.authUrl;
      }
      await sleep(1000);
    }
    return null;
  }

  async stop() {
    const p = this.proc;
    this.proc = null;
    this.manualStop = true;
    if (!p || p.exitCode !== null) return;
    try {
      // Windows 进程树终止
      const r = spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      if (r.status !== 0) p.kill();
    } catch (_) {
      try { p.kill(); } catch (_) { /* 忽略 */ }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Launcher, findDsh, findNode, findNodeStr, findEmbeddedNpmCli, prepareEmbeddedInstallEnv, compareVersions, REGEX_URL_LINE };