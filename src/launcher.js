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

// 定位系统 node.exe（nvm-windows / 标准安装 / PATH 兜底）
function findNode() {
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
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'node';
}

// 发现已安装的 @deepseek-ai/dsh（npm 全局 / npx 缓存），返回版本最高者
// 返回 { dir, version, bin }；无则返回 null
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
    this.nodePath = null;
    this.found = null;
    this.authUrl = '';
    this.running = false;
    this.ready = false;
    this.manualStop = false;   // 手动停止标志：避免退出事件触发看门狗
  }

  detect() {
    this.nodePath = findNode();
    this.found = findDsh();
    return this.found;
  }

  get version() {
    return this.found ? this.found.version : '';
  }

  // 启动（安全模式时自动追加 --patch）
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
    if (found) {
      this.log('启动 dsh ' + found.version + ' → ' + this.nodePath + ' ' + found.bin + ' ' + args.join(' '));
      this.proc = spawn(this.nodePath, [found.bin].concat(args), {
        cwd: this.workDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // 本机无 dsh → npx 首次下载安装并启动
      this.log('未发现本机 dsh，使用 npx 自动下载安装并启动…');
      this.proc = spawn('npx', ['--yes', '@deepseek-ai/dsh'].concat(args), {
        cwd: this.workDir, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    this.running = true;
    this.bindOutput();
    this.proc.on('error', (err) => {
      this.running = false;
      this.emit('error', err);
    });
    this.proc.on('exit', (code, signal) => {
      this.running = false;
      this.emit('exit', code, signal);
    });
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

module.exports = { Launcher, findDsh, findNode, compareVersions, REGEX_URL_LINE };