// gateway-manager.js — 模型网关托管（多供应商统一代理）
//
// 复用 DSH 桌面助手（v1.3.5）的成熟网关实现：src/gateway/model-gateway.mjs（零依赖单文件，
// 原样分发，便于与桌面助手版本保持同步）。本模块只负责：进程托管、配置读写、日志预览、
// 一键写入 dsh 配置（把网关注册为 dsh 的 gateway 提供商）。
//
// 网关对外能力（由 mjs 提供）：统一 baseURL + 统一 Key、优先级路由 + 故障切换、SSE 透传、
// /v1/chat/completions（OpenAI 兼容）、/v1/messages（Anthropic）、/v1/models、/health、
// 分级熔断（401/403 立即熔断、5xx/网络错误连续计数）、上游错误日志脱敏。
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');

const LOG_TAIL_MAX = 64 * 1024;

// 配置文本校验（供 UI 保存前检查与单测）：返回 { ok, error }
// 按命令行特征杀进程树（R18 抽出共用）：仅匹配 node.exe/DSH-App.exe 且命令行含指定
// 特征串的进程，taskkill /T 树杀；返回杀掉的进程数。排除自身 PID。
function killProcessesByCommandline(marker, logLabel, logFn) {
  try {
    const probe = spawnSync('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | " +
      "Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'DSH-App.exe' -or $_.Name -eq 'cmd.exe') -and $_.CommandLine -and $_.CommandLine.Contains('" + marker + "') -and $_.ProcessId -ne " + process.pid + " } | " +
      'ForEach-Object { Write-Output $_.ProcessId }',
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const pids = String(probe.status === 0 ? (probe.stdout || '') : '')
      .split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    if (pids.length === 0) return 0;
    let killed = 0;
    for (const pid of pids) {
      try {
        const r2 = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        if (r2.status === 0) killed++;
      } catch (_) { /* 忽略单个失败 */ }
    }
    if (killed > 0 && logFn) logFn(logLabel + ' ' + killed + ' 个进程树。');
    return killed;
  } catch (_) { return 0; }
}

// R18（退出全清）：杀掉所有 dsh-app 拉起的 dsh 相关进程树——特征匹配：
//   - broker cmd（launch-dsh.cmd / plugin-op.cmd）
//   - 本应用数据目录路径（网关 --config、broker 目录等；R25：替代裸 '@deepseek-ai'
//     特征——旧特征会误杀用户在系统终端手工跑的 dsh / npm 升级进程，与注释矛盾）
// R25：不再用 'model-gateway.mjs' / '@deepseek-ai' 裸特征（会误杀桌面助手网关与
// 用户手工进程）；未提供 dataDir 时（兼容旧调用）保留 '@deepseek-ai' 兜底。
function killAllDshProcesses(logFn, dataDir) {
  const markers = [
    'launch-dsh.cmd',
    'plugin-op.cmd',
    dataDir || '@deepseek-ai',
  ];
  let total = 0;
  for (const m of markers) {
    total += killProcessesByCommandline(m, '[退出清理]', logFn);
  }
  return total;
}

// 配置文本校验（供 UI 保存前检查与单测）：返回 { ok, error }
function validateConfigText(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: 'JSON 解析失败：' + (err && err.message ? err.message : err) };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: '配置根必须是对象（port / apiKey / providers）' };
  }
  if (!Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    return { ok: false, error: '缺少 providers 数组（至少一个供应商）' };
  }
  // R22：端口必须显式且合法——缺失/非法时静默回退会占错端口（dsh-app 网关约定
  // 3091，桌面助手为 3090，二者不能混占），保存前直接拦截并提示
  {
    const p = Number(cfg.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { ok: false, error: '缺少或非法 port（必须是 1-65535 整数；dsh-app 网关约定 3091）' };
    }
  }
  for (const p of cfg.providers) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'providers 中存在非对象条目' };
    if (!p.id || typeof p.id !== 'string') return { ok: false, error: '供应商缺少 id（字符串）' };
    if (!p.baseURL || typeof p.baseURL !== 'string') return { ok: false, error: '供应商 ' + (p.id || '?') + ' 缺少 baseURL' };
  }
  return { ok: true, error: null };
}

class GatewayManager extends EventEmitter {
  /**
   * @param {object} opts { userDataDir, nodePath, nodeEnv, settings, logger }
   */
  constructor(opts) {
    super();
    this.userDataDir = opts.userDataDir;
    this.nodePath = opts.nodePath || 'node';
    this.nodeEnv = opts.nodeEnv || {};   // v1.5.17：内嵌运行时需 ELECTRON_RUN_AS_NODE=1（spawn 时合并 env）
    this.settings = opts.settings;
    this.log = opts.logger.appendLog.bind(opts.logger);
    this.gatewayDir = path.join(__dirname, 'gateway');
    this.mjsPath = path.join(this.gatewayDir, 'model-gateway.mjs');
    this.configPath = path.join(this.userDataDir, 'gateway.config.json');
    this.logPath = path.join(this.userDataDir, 'logs', 'gateway.log');
    this.proc = null;
    this.running = false;
    this.logTail = '';
    this.port = 3091;   // 端口权威 = gateway.config.json 的 port（网关运行模式只认配置文件的端口）；
                        // 约定（R22）：dsh-app 网关 = 3091，桌面助手 = 3090，二者不可混占
    this._starting = null;   // 启动互斥锁：并发 start/restart 只执行一次（防双 spawn EADDRINUSE）

    // 打包后（app.asar 内）外部 node 无法读取 asar 内部文件，
    // 因此把网关运行时解包到数据目录（可写、真实文件），spawn 用解包后的路径。
    this.ensureRuntimeExtracted();
  }

  // 若 model-gateway.mjs 位于 asar 内，复制到 userDataDir\gateway\ 下供外部 node 执行
  ensureRuntimeExtracted() {
    try {
      const asarMark = 'app.asar' + path.sep;
      const inAsar = this.mjsPath.indexOf(asarMark) >= 0 || this.mjsPath.indexOf('app.asar\\') >= 0 || this.mjsPath.indexOf('app.asar/') >= 0;
      if (!inAsar) return;                       // 开发/源码树直跑：路径本来就是真实文件
      if (!fs.existsSync(this.mjsPath)) {
        this.log('模型网关：缺少运行时 ' + this.mjsPath);
        return;
      }
      const destDir = path.join(this.userDataDir, 'gateway');
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, 'model-gateway.mjs');
      // 每次复制（asar 内为最新分发版本；数据目录只作执行副本）
      fs.copyFileSync(this.mjsPath, dest);
      this.mjsPath = dest;
      this.log('模型网关：运行时已解包到 ' + dest);
      // 示例配置一并解包（供首次初始化生成配置用）
      const example = path.join(this.gatewayDir, 'gateway.config.example.json');
      if (fs.existsSync(example)) {
        const destExample = path.join(destDir, 'gateway.config.example.json');
        fs.copyFileSync(example, destExample);
      }
    } catch (err) {
      this.log('模型网关：运行时解包失败 ' + (err && err.message ? err.message : err));
    }
  }

  // 读取配置中的端口（无配置/解析失败 → 默认 3091：dsh-app 网关约定端口，R22）
  configPort() {
    try {
      const cfg = JSON.parse(this.configText());
      const p = Number(cfg && cfg.port);
      return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 3091;
    } catch (_) { return 3091; }
  }

  // 首次使用：配置不存在时从示例生成
  init() {
    try {
      if (!fs.existsSync(this.configPath)) {
        // 优先用数据目录下的解包示例（打包后 asar 内示例也读不了——用 fs 其实可读，
        // 但统一走解包副本更稳）
        const candidates = [
          path.join(this.userDataDir, 'gateway', 'gateway.config.example.json'),
          path.join(this.gatewayDir, 'gateway.config.example.json'),
        ];
        const example = candidates.find((p) => fs.existsSync(p));
        if (example) {
          fs.copyFileSync(example, this.configPath);
          this.log('模型网关：已从示例生成 ' + this.configPath + '（请修改为真实供应商后启动）');
        }
      }
    } catch (err) {
      this.log('模型网关初始化失败: ' + (err && err.message ? err.message : err));
    }
  }

  getState() {
    return { running: this.running, port: this.port, configPath: this.configPath };
  }

  configText() {
    try { return fs.readFileSync(this.configPath, 'utf8'); } catch (_) { return ''; }
  }

  exampleText() {
    try {
      return fs.readFileSync(path.join(this.gatewayDir, 'gateway.config.example.json'), 'utf8');
    } catch (_) { return ''; }
  }

  // 保存配置（JSON 校验通过后写盘；运行中则重启生效——await 重启完成再返回，
// 避免 UI 紧随其后的 start() 与未完成的 stop/start 竞态）
  async saveConfig(text) {
    const v = validateConfigText(text);
    if (!v.ok) return v;
    try {
      fs.writeFileSync(this.configPath, text, 'utf8');
      this.log('模型网关：配置已保存。');
      if (this.running) {
        await this.restart();
      }
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: '配置写入失败：' + (err && err.message ? err.message : err) };
    }
  }

  // 解析网关应使用的代理：配置显式 proxy.enabled → 用配置 url（空则自动探测）；
  // **显式关闭（enabled === false）→ 返回 null（直连，绝不探测/兜底）**；
  // 未配置 → 自动探测。返回 "http://host:port" 或 null（async：探测要 TCP 连通测试）。
  async resolveProxy() {
    try {
      const cfg = JSON.parse(this.configText() || '{}');
      if (cfg.proxy && cfg.proxy.enabled === false) {
        this.log('模型网关：代理已显式关闭（proxy.enabled=false），直连。');
        return null;
      }
      if (cfg.proxy && cfg.proxy.enabled) {
        const u = String(cfg.proxy.url || '').trim();
        if (u) {
          const norm = u.includes('://') ? u : 'http://' + u;
          this.log('模型网关：使用配置代理 ' + norm);
          return norm;
        }
        this.log('模型网关：代理已启用但未填地址，回退自动探测…');
      }
    } catch (_) { /* 配置解析失败忽略 */ }
    return this.detectProxy();
  }

  // 检测本机代理（clash/v2ray 等）：返回 "http://host:port" 或 null。
  // 优先级：显式环境变量 > 系统代理(ProxyEnable=1) > 常用 clash 端口（**TCP 探测通过才用**）。
  // R25（审计阻断修复）：旧版对 7890 无条件兜底——未装 clash 的机器上 NODE_USE_ENV_PROXY
  // 注入后 undici 的 EnvHttpProxyAgent **没有"代理不可达回退直连"机制**，所有上游请求
  // ECONNREFUSED → 网络错熔断循环 → 网关必坏。现在兜底前必须探测端口可连。
  async detectProxy() {
    const env = process.env;
    if (env.HTTPS_PROXY) return env.HTTPS_PROXY;
    if (env.https_proxy) return env.https_proxy;
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync('powershell', [
        '-NoProfile', '-Command',
        "$p = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; " +
        "if ($p.ProxyEnable -eq 1 -and $p.ProxyServer) { Write-Output $p.ProxyServer }",
      ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      const s = String(r.status === 0 ? (r.stdout || '') : '').trim();
      if (s) {
        const first = s.split(';')[0].split('=').pop().trim();
        if (first) return first.includes('://') ? first : 'http://' + first;
      }
    } catch (_) { /* 忽略 */ }
    // clash 默认混合端口兜底：仅当 TCP 可连时采用（400ms 超时，不阻塞启动）
    const net = require('net');
    const probePort = (port) => new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
      s.setTimeout(400, () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(false));
    });
    for (const port of [7890, 7897]) {
      // eslint-disable-next-line no-await-in-loop
      if (await probePort(port)) return 'http://127.0.0.1:' + port;
    }
    return null;   // 没有可用代理 → 直连（不再无条件注入 7890）
  }

  // 全局清理"孤儿网关"进程：旧实例/旧版本残留的 node model-gateway.mjs 会一直占用
  // 配置端口，导致新实例 EADDRINUSE 启动失败（用户侧表现为"网关启动了但探测不通过"）。
  // R25（审计修复）：旧特征 'model-gateway.mjs' 会误杀**桌面助手（3090）的网关**——
  // 两 app 并存时互杀。现在只杀命令行里带**本应用数据目录** --config 路径的网关进程。
  killStaleGatewayProcesses() {
    const marker = this.configPath;
    if (!marker) return 0;
    return killProcessesByCommandline(marker, '模型网关：已清理本应用残留网关进程');
  }

  // 等待端口释放（taskkill 后 Windows 释放端口有短暂延迟，否则新进程 EADDRINUSE）。
// 用 TCP 连接探测（比 HTTP 更准：任何占用者都能检出）。
async waitPortFree(port, timeoutMs) {
    const net = require('net');
    const tryOnce = () => new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(false); });  // 连上=占用
      s.setTimeout(600, () => { s.destroy(); resolve(true); });                                     // 超时=空闲
      s.on('error', () => resolve(true));                                                           // 拒绝=空闲
    });
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
      if (await tryOnce()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async start() {
    if (this.proc) return;
    // 启动互斥：并发 start/restart（保存按钮的 start 与 restart 尾部、托盘双击等）
    // 只允许一个在执行——否则双 spawn 一个 EADDRINUSE 退出、this.proc 引用互相覆盖。
    if (this._starting) return this._starting;
    this._starting = this._doStart();
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _doStart() {
    if (this.proc) return;
    this.stopping = false;   // R17：主动启动清除停止标记（自愈恢复启用）
    this.port = this.configPort();   // 以配置文件为准（--port 参数仅对 --write-dsh 生效）
    const mjs = this.mjsPath;
    if (!fs.existsSync(mjs)) {
      this.log('模型网关：缺少运行时 ' + mjs);
      return;
    }
    // 启动前：清理旧实例残留的网关进程并等待端口释放（防 EADDRINUSE 启动即退出）
    this.killStaleGatewayProcesses();
    const freed = await this.waitPortFree(this.port, 4000);
    if (!freed) {
      this.log('模型网关：端口 ' + this.port + ' 仍被其他程序占用（非网关进程），请更换配置端口或释放该端口。');
      return;
    }
    this.log('模型网关：启动（端口 ' + this.port + '）…');
    // 注意：stdio 管道用于日志捕获；此 spawn 仅在用户环境（无沙箱限制）下运行
    // 传 --config/--log 并设 DSH_GATEWAY_CONFIG env，确保网关读 dsh-app 自己的数据目录
    // （不再误读 %APPDATA%\DSHDesktop 的旧/模拟配置）
    const gwEnv = Object.assign({}, process.env, {
      DSH_GATEWAY_CONFIG: this.configPath,
      DSH_GATEWAY_LOG: this.logPath,
      // 网关内部日志（catalog/调用/熔断）同时输出 stdout，设置页日志框才能实时看到
      // （默认只写文件，stdout 仅有 listening，用户会误以为"无调用记录"）
      DSH_GATEWAY_VERBOSE: '1',
    }, this.nodeEnv || {});   // v1.5.17：内嵌运行时的 ELECTRON_RUN_AS_NODE 等
    // 代理注入（R6）：上游如 agentrouter/air-outer 需经 clash 类代理才能访问；
    // node ≥24 的 fetch 支持 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY。
    // 优先级：配置显式启用（proxy.enabled + url）> 显式关闭（直连）> 自动探测（TCP 验证后）。
    const proxy = await this.resolveProxy();
    if (proxy) {
      gwEnv.NODE_USE_ENV_PROXY = '1';
      gwEnv.HTTPS_PROXY = proxy;
      gwEnv.HTTP_PROXY = proxy;
      this.log('模型网关：网关进程走代理 ' + proxy);
    }
    this.proc = spawn(this.nodePath, [
      mjs,
      '--config', this.configPath,
      '--log', this.logPath,
      '--port', String(this.port),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gwEnv,
    });
    this.running = true;
    this.emit('state');

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      this.pushLog(text);
      // 注意：网关在 DSH_GATEWAY_VERBOSE=1 时已自行把 log() 写入 LOG_PATH，
      // 宿主再把 stdout 追加同一文件会导致每行双写（曾误判为"重复请求/重连"）。
      // 因此这里只推送界面，不再追加文件。
    };
    if (this.proc.stdout) this.proc.stdout.on('data', onData);
    if (this.proc.stderr) this.proc.stderr.on('data', onData);

    this.proc.on('error', (err) => {
      this.log('模型网关进程错误: ' + (err && err.message ? err.message : err));
      this.running = false;
      this.emit('state');
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      this.running = false;
      this.log('模型网关已退出（退出码 ' + code + '）');
      this.emit('state');
      // R17（假死自愈）：网关进程意外退出（self-watchdog 自杀/崩溃）且非用户主动停止
      // （stop() 会置 this.stopping）时自动重启——熔断/连接池等全部状态随之清空复活。
      // R25（审计修复）：连续自愈失败上限——配置损坏/端口被占时旧版每 3 秒无限重启
      // （日志膨胀 + CPU 空转）。连续 5 次自愈未达健康即停止，交还用户处理；
      // 一次健康启动会清零计数。
      if (!this.stopping) {
        this._healFails = (this._healFails || 0);
        if (this._healFails >= 5) {
          this.log('模型网关：连续 ' + this._healFails + ' 次自愈未成功，停止自动重启（请检查配置/端口后手动启动）。');
          return;
        }
        this._healFails += 1;
        this.log('模型网关异常退出，3 秒后自动重启（self-heal ' + this._healFails + '/5）…');
        setTimeout(() => {
          if (!this.stopping && !this.proc) this.start().then(() => {
            // start 内健康探测通过会置 this._healHealthyCheck —— 见下方
          }).catch((e) => {
            this.log('模型网关自愈重启失败: ' + (e && e.message ? e.message : e));
          });
        }, 3000);
      }
    });

    // 健康探测确认（v1.5.17d：网关进程 listen 需 1-3 秒，单次探测会在就绪前误报
    // "端口探测未通过"；改为最多 8 秒的重试探测，任一次通过即就绪）
    let healthy = false;
    for (let i = 0; i < 8 && !healthy; i++) {
      healthy = await this.probeHealth(2000);
      if (!healthy) await new Promise((r) => setTimeout(r, 800));
    }
    if (healthy) {
      this._healFails = 0;   // R25：健康启动清零自愈失败计数
      this.log('模型网关已就绪: http://127.0.0.1:' + this.port + '/v1');
    } else {
      this.log('模型网关端口探测未通过（可能配置错误，请查看日志）。');
    }
    this.emit('state');
  }

  async stop() {
    this.stopping = true;   // R17：标记主动停止——exit 处理不触发自愈重启
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    try {
      const r = spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      if (r.status !== 0) p.kill();
    } catch (_) {
      try { p.kill(); } catch (_) { /* 忽略 */ }
    }
    this.running = false;
    this.log('模型网关已停止。');
    this.emit('state');
  }

  async restart() {
    // 先停本实例进程
    await this.stop();
    // 再全局清理残留网关进程（其他实例/旧版本遗留的 model-gateway.mjs 也会占用端口、
    // 其内存熔断状态延续——必须杀干净再启动，否则旧熔断继续 skip provider）
    this.killStaleGatewayProcesses();
    // 等待端口彻底释放（taskkill 树杀有延迟）
    await this.waitPortFree(this.port, 4000);
    await this.start();
  }

  // /health 探测（与网关自带路由一致）
  probeHealth(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/health', timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  // 一键写入 dsh 配置（把网关注册为 dsh 的 gateway 提供商 + 统一 Key）
  async writeDsh() {
    // 端口以配置文件为准（this.port 是上次 start 的值——网关未运行/刚改端口时会是旧值）
    const port = this.configPort();
    const r = spawnSync(
      this.nodePath,
      [
        this.mjsPath,
        '--write-dsh',
        '--config', this.configPath,
        '--port', String(port),
      ],
      {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
        env: Object.assign({}, process.env, { DSH_GATEWAY_CONFIG: this.configPath }, this.nodeEnv || {}),
      }
    );
    const output = (r.stdout || '') + (r.stderr || '');
    this.pushLog('[write-dsh] ' + output.trim());
    if (r.status === 0) {
      this.log('模型网关：已写入 dsh 配置（重启 dsh web 后在模型选择器中选择 gateway 提供商）。');
      return { ok: true, output };
    }
    this.log('模型网关：写入 dsh 配置失败（退出码 ' + r.status + '）。');
    return { ok: false, output };
  }

  pushLog(text) {
    this.logTail = (this.logTail + text).slice(-LOG_TAIL_MAX);
  }

  logTailText(maxChars) {
    const n = maxChars || 8000;
    return this.logTail.slice(-n);
  }

  clearLog() {
    this.logTail = '';
  }
}

module.exports = { GatewayManager, validateConfigText, killAllDshProcesses, killProcessesByCommandline };