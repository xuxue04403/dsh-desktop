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
  for (const p of cfg.providers) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'providers 中存在非对象条目' };
    if (!p.id || typeof p.id !== 'string') return { ok: false, error: '供应商缺少 id（字符串）' };
    if (!p.baseURL || typeof p.baseURL !== 'string') return { ok: false, error: '供应商 ' + (p.id || '?') + ' 缺少 baseURL' };
  }
  return { ok: true, error: null };
}

class GatewayManager extends EventEmitter {
  /**
   * @param {object} opts { userDataDir, nodePath, settings, logger }
   */
  constructor(opts) {
    super();
    this.userDataDir = opts.userDataDir;
    this.nodePath = opts.nodePath || 'node';
    this.settings = opts.settings;
    this.log = opts.logger.appendLog.bind(opts.logger);
    this.gatewayDir = path.join(__dirname, 'gateway');
    this.mjsPath = path.join(this.gatewayDir, 'model-gateway.mjs');
    this.configPath = path.join(this.userDataDir, 'gateway.config.json');
    this.logPath = path.join(this.userDataDir, 'logs', 'gateway.log');
    this.proc = null;
    this.running = false;
    this.logTail = '';
    this.port = 3090;   // 端口权威 = gateway.config.json 的 port（网关运行模式只认配置文件的端口）
  }

  // 读取配置中的端口（无配置/解析失败 → 默认 3090）
  configPort() {
    try {
      const cfg = JSON.parse(this.configText());
      const p = Number(cfg && cfg.port);
      return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 3090;
    } catch (_) { return 3090; }
  }

  // 首次使用：配置不存在时从示例生成
  init() {
    try {
      if (!fs.existsSync(this.configPath)) {
        const example = path.join(this.gatewayDir, 'gateway.config.example.json');
        if (fs.existsSync(example)) {
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

  // 保存配置（JSON 校验通过后写盘；运行中则自动重启生效）
  saveConfig(text) {
    const v = validateConfigText(text);
    if (!v.ok) return v;
    try {
      fs.writeFileSync(this.configPath, text, 'utf8');
      this.log('模型网关：配置已保存。');
      if (this.running) {
        this.restart();
      }
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: '配置写入失败：' + (err && err.message ? err.message : err) };
    }
  }

  async start() {
    if (this.proc) return;
    this.port = this.configPort();   // 以配置文件为准（--port 参数仅对 --write-dsh 生效）
    const mjs = this.mjsPath;
    if (!fs.existsSync(mjs)) {
      this.log('模型网关：缺少运行时 ' + mjs);
      return;
    }
    this.log('模型网关：启动（端口 ' + this.port + '）…');
    // 注意：stdio 管道用于日志捕获；此 spawn 仅在用户环境（无沙箱限制）下运行
    this.proc = spawn(this.nodePath, [mjs, '--config', this.configPath, '--port', String(this.port)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.running = true;
    this.emit('state');

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      this.pushLog(text);
      try { fs.appendFileSync(this.logPath, text, 'utf8'); } catch (_) { /* 忽略 */ }
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
    });

    // 健康探测确认
    const healthy = await this.probeHealth(4000);
    if (healthy) {
      this.log('模型网关已就绪: http://127.0.0.1:' + this.port + '/v1');
    } else {
      this.log('模型网关端口探测未通过（可能配置错误，请查看日志）。');
    }
    this.emit('state');
  }

  async stop() {
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
    await this.stop();
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
    const r = spawnSync(
      this.nodePath,
      [this.mjsPath, '--write-dsh', '--config', this.configPath, '--port', String(this.port)],
      { encoding: 'utf8', timeout: 60000, windowsHide: true }
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

module.exports = { GatewayManager, validateConfigText };