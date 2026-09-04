#!/usr/bin/env node
/**
 * DSH Model Gateway
 * OpenAI-compatible unified model proxy with multi-provider routing.
 *
 * Features:
 *  - GET  /v1/models            merged, de-duplicated model list from all providers
 *  - POST /v1/chat/completions  route by model availability -> priority -> failover
 *  - POST /v1/responses         passthrough (same routing)
 *  - GET  /health               liveness probe for the desktop assistant
 *  - unified Bearer auth (config.apiKey) on all /v1 routes
 *  - SSE streaming passthrough (node fetch ReadableStream -> res)
 *  - per-provider model-catalog cache with TTL, cleared on failure
 *
 * Zero npm dependencies; requires Node >= 18 (fetch, streams).
 *
 * Config file (JSON):
 *   {
 *     "port": 3090,
 *     "apiKey": "dsh-gateway-xxxxxxxx",
 *     "providers": [
 *       {
 *         "id": "provider-a",
 *         "baseURL": "https://example.com/v1",
 *         "apiKey": "sk-...",
 *         "models": ["deepseek-v4-flash", "glm-5.2"],
 *         "priority": 1,          // lower number = tried first
 *         "enabled": true
 *       }
 *     ]
 *   }
 *
 * Config path: %APPDATA%\DSHDesktop\gateway.config.json (or DSH_GATEWAY_CONFIG).
 * A template is created on first run if the file is missing.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.dsh'), 'DSHDesktop');
const CONFIG_PATH = process.env.DSH_GATEWAY_CONFIG || path.join(APP_DIR, 'gateway.config.json');
const MODEL_CACHE_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 60_000;
// R2 防封：catalog 探测失败后的冷却期（30s 内不重试探测，防请求风暴触发风控）
const CATALOG_FAIL_COOLDOWN_MS = 30_000;
const LOG_PATH = process.env.DSH_GATEWAY_LOG || path.join(APP_DIR, 'logs', 'gateway.log');

/* ---------------- logging ---------------- */
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 日志轮转上限 5MB（修复 G3：防止长期运行磁盘膨胀）

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    // 轮转：超过上限时重置文件
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > LOG_MAX_BYTES) fs.writeFileSync(LOG_PATH, '');
    } catch { /* 日志文件可能还不存在 */ }
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch { /* ignore */ }
  if (process.env.DSH_GATEWAY_VERBOSE === '1') process.stdout.write(line + '\n');
}

/* ---------------- config ---------------- */
function defaultConfig() {
  return {
    port: 3090,
    apiKey: 'dsh-gateway-change-me',
    providers: [
      {
        id: 'example-provider',
        baseURL: 'https://example.com/v1',
        apiKey: 'sk-xxxxxxxx',
        models: ['deepseek-v4-flash'],
        priority: 1,
        enabled: true,
      },
    ],
  };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2), 'utf8');
    log(`config template created at ${CONFIG_PATH} — edit it, then restart the gateway`);
    console.log(`[gateway] config template created: ${CONFIG_PATH}`);
    return null; // caller exits: nothing to serve until configured
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!Array.isArray(cfg.providers)) throw new Error('providers must be an array');
    return cfg;
  } catch (e) {
    log(`config parse error: ${e.message}`);
    console.error(`[gateway] invalid config: ${e.message}`);
    return null;
  }
}

/* ---------------- upstream catalog cache ---------------- */
const catalogCache = new Map(); // providerId -> { models:Set, ts }

// S1 轮询计数器：model -> 下次起始偏移（round-robin 路由模式用）
const rrCounters = new Map();

const catalogInflight = new Map(); // providerId -> Promise（并发去重）

/* ---------------- V1/V2 防封：连续失败分级熔断 ----------------
 * 同一 provider 连续 N 次转发失败 → 熔断（期间路由跳过，不发任何上游请求）。
 * 分级（V2）：
 *  - 鉴权/业务拒绝（401/403）：长熔断 30 分钟——"Deposit required"类业务性
 *    拒绝非临时状态，重试无意义且徒增风控画像，等用户处理（充值/换key）后自然恢复
 *  - 网络错误/5xx：短熔断 5 分钟——可能是瞬时故障，较快半开试探
 * 冷却结束后半开（下一个请求允许试探一次），成功即清零计数。
 * 目的：上游临时风控/限流时，避免持续打点加剧封禁，保护账号。
 */
const BREAKER_THRESHOLD = 3;                    // 连续失败次数阈值
const BREAKER_SHORT_MS = 5 * 60_000;            // 短熔断 5 分钟（网络错/5xx）
const BREAKER_LONG_MS = 30 * 60_000;            // 长熔断 30 分钟（401/403 业务拒绝）
const breaker = new Map();                      // providerId -> { fails, openUntil }

function breakerIsOpen(providerId) {
  const b = breaker.get(providerId);
  if (!b) return false;
  // 先判熔断窗口（立即熔断时 fails 可能未达阈值——V2b 修复）
  if (b.openUntil > 0) {
    if (Date.now() < b.openUntil) return true;
    // 半开：冷却到点，允许试探（计数保留 1 以便失败快速回升熔断）
    b.fails = BREAKER_THRESHOLD - 1;
    b.openUntil = 0;
    breaker.set(providerId, b);
    return false;
  }
  return b.fails >= BREAKER_THRESHOLD;
}
function breakerRecordFail(providerId, httpStatus) {
  const b = breaker.get(providerId) || { fails: 0, openUntil: 0 };
  b.fails += 1;
  // V2b：401/403 业务性拒绝（鉴权失败/需充值/禁用）不会自愈——首次出现即长熔断 30 分钟，
  // 不必等连续 3 次（避免固定失败模式被风控画像）；网络错/5xx 仍按 3 次阈值短熔断
  const immediate = (httpStatus === 401 || httpStatus === 403);
  if (b.fails >= BREAKER_THRESHOLD || immediate) {
    const long = immediate;
    b.openUntil = Date.now() + (long ? BREAKER_LONG_MS : BREAKER_SHORT_MS);
    const mins = Math.round((long ? BREAKER_LONG_MS : BREAKER_SHORT_MS) / 60_000);
    log(`breaker OPEN: ${providerId} 失败（${httpStatus || 'network'}），熔断 ${mins} 分钟（保护上游账号）`);
  }
  breaker.set(providerId, b);
}
function breakerRecordSuccess(providerId) {
  if (breaker.has(providerId)) breaker.delete(providerId);
}

// V1 防封：日志脱敏——catalog/上游错误体可能回显 key，统一打码 sk-xxxx 片段
function maskSecrets(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, (m) => `sk-***${m.slice(-4)}`)
    .replace(/(x-api-key["':\s=]+)([^\s"',}]+)/gi, '$1***');
}

async function fetchCatalog(provider, force, clientUA) {
  const cached = catalogCache.get(provider.id);
  if (!force && cached && Date.now() - cached.ts < (cached.failed ? CATALOG_FAIL_COOLDOWN_MS : MODEL_CACHE_TTL_MS)) return cached.models;
  // 并发去重：同一 provider 已有在途目录请求时直接复用（修复 G5）
  if (!force && catalogInflight.has(provider.id)) return catalogInflight.get(provider.id);
  const promise = doFetchCatalog(provider, clientUA);
  catalogInflight.set(provider.id, promise);
  try {
    return await promise;
  } finally {
    catalogInflight.delete(provider.id);
  }
}

async function doFetchCatalog(provider, clientUA) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    // Q1：catalog 探测同样走上游请求头构造（clientUA 配置时完全仿真 Claude Code，
    // 否则 new-api 客户端白名单会拦 catalog 导致模型列表为空）
    const headers = upstreamRequestHeaders({}, provider.apiKey, clientUA);
    const res = await fetch(`${upstreamBase(provider.baseURL)}/models`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      // 记录响应体开头（前 300 字符，脱敏），方便诊断 401/404 等鉴权与端点问题
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { }
      log(`catalog ${provider.id} HTTP ${res.status}: ${maskSecrets(detail)}`);
      // R10b：HTTP 错误同样写失败冷却缓存（防每次请求都重探测形成风暴）
      catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
      return null;
    }
    const body = await res.json();
    const ids = new Set((body.data || []).map((m) => m && m.id).filter(Boolean));
    if (ids.size === 0) throw new Error('empty catalog');
    catalogCache.set(provider.id, { models: ids, ts: Date.now(), failed: false });
    log(`catalog ${provider.id}: ${ids.size} models`);
    return ids;
  } catch (e) {
    // 失败冷却（R2 防封加固）：不立即删除缓存，而是缓存 30 秒的"失败态"，
    // 避免每个客户端请求都触发 catalog 重探测造成上游请求风暴/风控
    catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
    log(`catalog ${provider.id} FAILED: ${e.message}`);
    return null;
  }
}

/* ---------------- auth ---------------- */
function authorized(req, cfg) {
  const h = req.headers['authorization'] || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim() === cfg.apiKey;
  const x = req.headers['x-api-key'];
  return typeof x === 'string' && x === cfg.apiKey;
}

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  // socket 可能已被客户端断开：writeHead/end 抛错不能带崩进程（H2）
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
      'access-control-allow-origin': '*',
    });
    res.end(buf);
  } catch (e) {
    log(`client already gone when sending ${status}: ${e.message}`);
  }
}

/* ---------------- routing ---------------- */
const MAX_BODY_BYTES = 16 * 1024 * 1024; // 16MB 请求体上限防御

async function bodyOf(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let guard = false;
    req.on('data', (c) => {
      if (guard) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        guard = true;
        req.pause();                    // 停止接收，保留连接以便响应 400
        req.removeAllListeners('data');
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function providersForModel(cfg, model) {
  return cfg.providers
    .filter((p) => p.enabled !== false)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
}

/* ---------------- 上游客户端仿真（Q1 加固） ----------------
 * 目标：完全仿真 Claude Code / OpenAI SDK 客户端的访问特征，
 * 规避 new-api/one-api 的“unauthorized client detected”客户端白名单检测，
 * 且不向任何上游泄露 dsh/网关自身的请求特征（防指纹封禁）。
 *  - 当 config.clientUA 为空 → 旧行为：透传 dsh 原始标识（K1 防屏蔽）
 *  - 当 config.clientUA 有值 → 完全仿真：丢弃客户端透传头，仅发固定仿真头集
 */

// Claude Code 风格请求头（Q1 实测收敛版）：
// agentrouter(new-api) 客户端白名单按 User-Agent 精确匹配放行；实测通过组合为
// UA=claude-cli/2.0.0 (external, cli) + Bearer，无其他特殊头。accept-encoding
// 由 upstreamRequestHeaders 统一设 identity（K7）。
function claudeClientHeaders() {
  return {
    'user-agent': 'claude-cli/2.0.0 (external, cli)',
    accept: 'application/json, text/event-stream',
  };
}

/** 构造发往上游的最终请求头。
 * clientUA 配置时 → 完全仿真模式（不留任何客户端透传痕迹）
 * clientUA 为空     → 透传 dsh 客户端标识（K1 防屏蔽）
 * anthropic=true    → Anthropic 协议模式（T5）：x-api-key 替代 Bearer + anthropic-version
 */
function upstreamRequestHeaders(reqHeaders, apiKey, clientUA, anthropic) {
  const out = {};
  const skip = new Set([
    'authorization', 'host', 'content-length', 'connection',
    'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade',
    'te', 'trailer', 'content-type', 'accept', 'accept-encoding',
    'x-api-key', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
    'cookie', 'origin', 'referer',
  ]);

  if (clientUA) {
    // 完全仿真模式：与 Claude Code 客户端一致，不透传任何 dsh 头
    Object.assign(out, claudeClientHeaders());
    out['user-agent'] = clientUA;   // 允许用户覆盖具体 UA 值
  } else {
    // 透传模式：保留 dsh 客户端标识
    for (const [k, v] of Object.entries(reqHeaders || {})) {
      const lk = k.toLowerCase();
      if (skip.has(lk)) continue;
      if (lk.startsWith('sec-') || lk.startsWith('proxy-') || lk.startsWith('cf-')) continue;
      out[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
  }

  if (anthropic) {
    // T5：Anthropic 协议（Claude Code 等）—— x-api-key + anthropic-version
    out['x-api-key'] = apiKey;
    out['anthropic-version'] = '2023-06-01';
    delete out['authorization'];
  } else {
    out['authorization'] = `Bearer ${apiKey}`;
  }
  out['accept'] = 'application/json, text/event-stream';
  out['content-type'] = 'application/json';
  out['accept-encoding'] = 'identity';  // K7：强制上游不压缩，SSE 不乱码
  return out;
}

/**
 * 防屏蔽透传（K1，兼容保留）：保留 dsh 客户端的原始请求标识（尤其是 User-Agent，
 * dsh 的 attribution 机制强制带 `deepseek-harness/<版本> (+url)`），
 * 仅替换鉴权头与必要的协议头，其余原样转发——让上游看到的就是"dsh 直连"。
 * 扩展（P3/Q1）：配置了 clientUA 时完全仿真 Claude Code，不透传任何 dsh 特征。
 */
function passthroughHeaders(reqHeaders, apiKey, clientUA) {
  return upstreamRequestHeaders(reqHeaders, apiKey, clientUA);
}

/** Forward to one provider; returns true when the response was written. */
async function forward(provider, upstreamPath, upstreamHeaders, body, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    // baseURL 允许“带 /v1”或“不带 /v1”两种写法（OpenAI SDK 惯例 / 用户习惯）：
    // upstreamBase() 统一规范化，upstreamPath 始终是相对 /v1 的路径（如 /chat/completions、/messages）
    // 注：Anthropic 协议（T5）下 upstreamHeaders 由 upstreamRequestHeaders(..., anthropic=true) 构造，
    // 含 x-api-key + anthropic-version、无 authorization Bearer；展开覆盖时不会被注入 Bearer。
    upstream = await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    // R3 防封：失败冷却而非立即删缓存（防每个请求都重试上游形成风暴）
    catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
    breakerRecordFail(provider.id, 0);   // V2：网络错误 → 短熔断 5 分钟
    log(`upstream ${provider.id} request error: ${e.message}`);
    return false;
  }
  clearTimeout(timer);
  if (!upstream.ok) {
    // surface upstream error body if small
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 500); } catch { }
    log(`upstream ${provider.id} HTTP ${upstream.status}: ${maskSecrets(detail)}`);   // V1：日志脱敏
    if (upstream.status === 401 || upstream.status === 403 || upstream.status >= 500) {
      // likely stale/misconfigured key or dead endpoint —— 冷却缓存，防风暴（R3）
      catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
      breakerRecordFail(provider.id, upstream.status);   // V2：按状态码分级熔断（401/403 → 30 分钟）
    }
    return false;
  }
  breakerRecordSuccess(provider.id);   // V1：成功清零熔断计数
  // success: stream through
  try {
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
  } catch (writeHeadErr) {
    log(`client disconnected before headers: ${writeHeadErr.message}`);
    try { await upstream.body?.cancel(); } catch { }
    res.destroy();
    return false;
  }
  const bodyStream = upstream.body;
  if (bodyStream) {
    const reader = bodyStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // 客户端可能随时断开（点停止/超时/关页）：write 抛 EPIPE 必须捕获，
        // 否则未处理异常会经 async 回调炸掉整个网关进程（C1）
        try {
          res.write(Buffer.from(value));
        } catch (writeErr) {
          log(`client disconnected during stream: ${writeErr.message}`);
          try { await reader.cancel(); } catch { }
          res.destroy();
          return false;
        }
      }
    } catch (readErr) {
      // 上游流异常：断开客户端，避免悬挂
      log(`upstream stream error: ${readErr.message}`);
      try { res.destroy(); } catch { }
      return false;
    } finally {
      try { reader.releaseLock(); } catch { }
    }
  }
  try {
    res.end();
  } catch { }
  return true;
}

async function handleCompletion(cfg, req, res, body, upstreamPath) {
  const model = body && body.model;
  if (!model) return json(res, 400, { error: { message: 'model is required' } });
  const reqStart = Date.now();   // 调用计时（T1 调用日志）
  const client = req.socket?.remoteAddress || 'local';
  const stream = !!(body && body.stream);
  const logCall = (via, status) =>
    log(`[call] ${model} ${via} status=${status} stream=${stream ? 1 : 0} dur=${Date.now() - reqStart}ms from=${client}`);

  const candidates = providersForModel(cfg, model);
  if (candidates.length === 0) {
    return json(res, 404, { error: { message: `no providers configured for model "${model}"` } });
  }

  // 1) availability pre-filter: prefer providers whose catalog advertises the model
  //    (cached; fallback to trying in priority order when catalog unknown)
  //    并行探测各供应商目录，避免串行等待放大首请求延迟（E3）
  const withCatalog = [];
  const unknown = [];
  const catalogResults = await Promise.all(candidates.map((p) => fetchCatalog(p, false, cfg.clientUA)));
  candidates.forEach((p, i) => {
    const set = catalogResults[i];
    if (set === null) { unknown.push(p); return; }
    if (set.has(model)) withCatalog.push(p);
  });

  // V1 防封：跳过熔断中的 provider（连续失败保护期，不发起上游请求）
  const breakerOpen = (p) => { if (breakerIsOpen(p.id)) { log(`skip ${p.id} (breaker open)`); return true; } return false; };
  const ordered = [...withCatalog, ...unknown].filter((p) => !breakerOpen(p));
  if (ordered.length === 0) {
    return json(res, 404, { error: { message: `model "${model}" is not offered by any configured provider` } });
  }

  // 路由模式（S1）：
  //  - 缺省 / "failover"：主备——固定从列表头开始尝试，失败切下一家（传统行为）
  //  - "round-robin"：轮询——同一模型每次请求从不同起点开始，流量分摊到各家；
  //    每家仍按 priority 顺序（candidates 已按 priority 排序），失败同样切下一家
  let tryOrder = ordered;
  if (cfg.routing === 'round-robin' && ordered.length > 1) {
    let n = rrCounters.get(model) || 0;
    rrCounters.set(model, n + 1);
    const start = n % ordered.length;
    if (start > 0) tryOrder = [...ordered.slice(start), ...ordered.slice(0, start)];
  }
  for (const p of tryOrder) {
    log(`try ${p.id} for ${model}`);
    // 透传 dsh 原始请求标识（K1 防屏蔽）：clientHeaders = req.headers
    const ok = await forward(p, upstreamPath.replace(/^\/v1/, ''), passthroughHeaders(req.headers, p.apiKey, cfg.clientUA), body, res);
    if (ok) {
      log(`served ${model} via ${p.id}`);
      logCall(`via=${p.id}`, 'ok');
      return;
    }
  }
  logCall('all-providers', 'fail');
  json(res, 503, { error: { message: `all providers for model "${model}" are unavailable` } });
}

/**
 * T5：Anthropic Messages 协议（Claude Code 等客户端）。
 * - 端点 POST /v1/messages，鉴权 x-api-key（authorized() 已支持）
 * - 转发到上游 {upstreamBase}/messages（agentrouter 等的 Anthropic 端点与 OpenAI 同享 /v1 前缀）
 * - 响应（JSON/SSE）原样透传——上游本身输出 Anthropic 格式
 * - 模型名清洗：Claude Code 选择器会显示 "glm-5.3[1m]" 这类带 [标记] 的名字，
 *   匹配与转发时剥离 [xxx] 后缀（T5 宽容匹配）
 */
async function handleMessages(cfg, req, res, body) {
  const rawModel = body && body.model;
  if (!rawModel) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'model is required' } });
  const model = String(rawModel).replace(/\[[^\]]*\]\s*$/, '').trim() || String(rawModel);
  if (model !== String(rawModel)) log(`model name cleaned: "${rawModel}" -> "${model}"`);

  const reqStart = Date.now();
  const client = req.socket?.remoteAddress || 'local';
  const stream = !!(body && body.stream);
  const logCall = (via, status) =>
    log(`[call] ${model} ${via} status=${status} stream=${stream ? 1 : 0} dur=${Date.now() - reqStart}ms from=${client} proto=anthropic`);

  // body.model 替换为清洗后的名字（上游按真实模型 ID 路由）
  const outBody = { ...body, model };

  const candidates = providersForModel(cfg, model);
  if (candidates.length === 0) {
    logCall('no-provider', 'fail');
    return json(res, 404, { type: 'error', error: { type: 'invalid_request_error', message: `model "${model}" is not configured on this gateway` } });
  }

  const withCatalog = [];
  const unknown = [];
  const catalogResults = await Promise.all(candidates.map((p) => fetchCatalog(p, false, cfg.clientUA)));
  candidates.forEach((p, i) => {
    const set = catalogResults[i];
    if (set === null) { unknown.push(p); return; }
    if (set.has(model)) withCatalog.push(p);
  });

  // V1 防封：跳过熔断中的 provider（连续失败保护期，不发起上游请求）
  const breakerOpen = (p) => { if (breakerIsOpen(p.id)) { log(`skip ${p.id} (breaker open)`); return true; } return false; };
  const ordered = [...withCatalog, ...unknown].filter((p) => !breakerOpen(p));
  if (ordered.length === 0) {
    logCall('no-provider', 'fail');
    return json(res, 404, { type: 'error', error: { type: 'invalid_request_error', message: `model "${model}" is not offered by any configured provider` } });
  }

  let tryOrder = ordered;
  if (cfg.routing === 'round-robin' && ordered.length > 1) {
    let n = rrCounters.get(model) || 0;
    rrCounters.set(model, n + 1);
    const start = n % ordered.length;
    if (start > 0) tryOrder = [...ordered.slice(start), ...ordered.slice(0, start)];
  }

  for (const p of tryOrder) {
    log(`try ${p.id} for ${model} (anthropic)`);
    const ok = await forward(p, '/messages', upstreamRequestHeaders(req.headers, p.apiKey, cfg.clientUA, true), outBody, res);
    if (ok) {
      log(`served ${model} via ${p.id} (anthropic)`);
      logCall(`via=${p.id}`, 'ok');
      return;
    }
  }
  logCall('all-providers', 'fail');
  json(res, 503, { type: 'error', error: { type: 'api_error', message: `all providers for model "${model}" are unavailable` } });
}

async function handleModels(cfg, req, res) {
  const byId = new Map();
  const rows = [];
  const results = await Promise.all(
    providersForModel(cfg).map((p) => fetchCatalog(p, false, cfg.clientUA)),
  );
  for (const p of providersForModel(cfg)) {
    const entry = catalogCache.get(p.id);
    // 失败冷却期（models=null）或无缓存：跳过（R10：不能对 null models 迭代）
    if (!entry || !entry.models) continue;
    for (const id of entry.models) {
      if (!byId.has(id)) {
        byId.set(id, rows.length);
        // T5：同时携带 Anthropic 模型发现字段（display_name/type）——Claude Code 等
        // Anthropic 客户端可读；OpenAI 客户端忽略多余字段，互不影响
        rows.push({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: p.id, type: 'model', display_name: id, created_at: new Date().toISOString() });
      }
    }
  }
  json(res, 200, { object: 'list', data: rows });
}

/* ---------------- server ---------------- */
function trimSlash(u) { return u.replace(/\/+$/, ''); }

/**
 * 规范化供应商 baseURL（P1 修复）：
 * - 允许带 /v1（OpenAI SDK 惯例）或不带（用户常直接填域名）
 * - 不带时自动补 /v1；带其他后缀（如 /v1/chat/completions 误填）则收敛到 /v1
 * 返回以 /v1 结尾的 base（不含尾斜杠）
 */
function upstreamBase(baseURL) {
  let b = trimSlash(String(baseURL || ''));
  if (!b) return b;
  // 若以 /v1 结尾（或已是 /v1/xxx 形式）→ 收敛；否则补 /v1
  const m = b.match(/\/v1(?:\/.*)?$/i);
  if (m) return b.slice(0, b.length - m[0].length + 3); // 保留 /v1 前缀
  return b + '/v1';
}

function startServer(cfg) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/health') { json(res, 200, { ok: true }); return; }

    if (p.startsWith('/v1/')) {
      const anthropicRoute = (p === '/v1/messages');
      if (!authorized(req, cfg)) {
        return anthropicRoute
          ? json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
          : json(res, 401, { error: { message: 'invalid or missing API key' } });
      }
      if (req.method === 'GET' && p === '/v1/models') return handleModels(cfg, req, res);
      if (req.method === 'POST' && p === '/v1/messages') {
        // T5：Anthropic Messages 协议（Claude Code 等）
        try {
          const body = await bodyOf(req);
          return handleMessages(cfg, req, res, body);
        } catch (e) {
          return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `invalid JSON body: ${e.message}` } });
        }
      }
      if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/responses')) {
        try {
          const body = await bodyOf(req);
          return handleCompletion(cfg, req, res, body, p);
        } catch (e) {
          return json(res, 400, { error: { message: `invalid JSON body: ${e.message}` } });
        }
      }
      return json(res, 404, { error: { message: `unsupported route ${p}` } });
    }

    json(res, 404, { error: { message: 'not found' } });
  });

  server.listen(cfg.port, '127.0.0.1', () => {
    log(`gateway listening on http://127.0.0.1:${cfg.port}`);
    console.log(`[gateway] listening on http://127.0.0.1:${cfg.port}`);
  });
  server.on('error', (e) => {
    log(`server error: ${e.message}`);
    console.error(`[gateway] server error: ${e.message}`);
    // 端口占用等致命错误：直接退出，让宿主(助手)能明确感知进程终止（C2）
    process.exit(1);
  });
  return server;
}

/* ---------------- write-dsh: register gateway into dsh host config ---------------- */
/**
 * Usage: node model-gateway.mjs --write-dsh [--config <cfg>] [--settings <settings.yaml>] [--credentials <credentials.yaml>] [--port <n>] [--key <unified key>]
 *
 * Inserts/updates an `llm-pi-ai.providers.gateway` entry in the dsh settings.yaml
 * (models merged from the gateway config) and ensures `DSH_GATEWAY_API_KEY` exists
 * in the credentials refs so dsh's llm layer can resolve apiKeyEnv.
 */
function writeDshConfig(args) {
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const cfgPath = get('--config') || CONFIG_PATH;
  const settingsPath = get('--settings') || process.env.DSH_SETTINGS || path.join(os.homedir(), '.dsh', 'settings.yaml');
  const credsPath = get('--credentials') || process.env.DSH_CREDENTIALS || path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const port = Number(get('--port') || 3090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[write-dsh] invalid --port: ${get('--port')}`);
    process.exit(1);
  }
  const key = get('--key') || '';

  if (!fs.existsSync(cfgPath)) {
    console.error(`[write-dsh] gateway config not found: ${cfgPath}`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const apiKey = key || cfg.apiKey || '';
  if (!apiKey || apiKey === 'dsh-gateway-change-me') {
    console.error('[write-dsh] unified apiKey is not set (edit gateway.config.json first)');
    process.exit(1);
  }
  const baseURL = `http://127.0.0.1:${port}/v1`;

  // merge models across enabled providers, dedup, keep order
  const modelMap = new Map();
  for (const p of cfg.providers || []) {
    if (p.enabled === false) continue;
    for (const m of p.models || []) if (typeof m === 'string' && !modelMap.has(m)) modelMap.set(m, m);
  }
  const models = [...modelMap.values()];
  if (models.length === 0) {
    console.error('[write-dsh] no models in gateway config providers');
    process.exit(1);
  }

  // YAML 安全转义：模型 ID / key 可能含特殊字符（#、冒号、引号等），
  // 统一用单引号包裹并把内部单引号加倍（YAML 单引号语法），防注入/破坏配置。
  const yamlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const apiKeyYaml = yamlQuote(apiKey);

  const modelLines = models
    .map((m) => `        - id: ${yamlQuote(m)}\n          name: ${yamlQuote(m)}\n          contextWindow: 1024000`)
    .join('\n');
  const block =
`    gateway:
      displayName: DSH Model Gateway
      apiKeyEnv: DSH_GATEWAY_API_KEY
      api: openai-completions
      baseURL: ${baseURL}
      models:
${modelLines}`;

  // settings.yaml: insert/replace the gateway provider under llm-pi-ai.providers
  // NOTE: no /m flag anywhere — with /m, `$` matches every line end and the
  // lazy match stops at the first line. We anchor by newline instead.
  let settings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
  const blockWithNl = '\n' + block;
  const re = /\n    gateway:.*?(?=\n    \S|$)/s;
  if (re.test(settings)) {
    settings = settings.replace(re, blockWithNl);
    console.log('[write-dsh] settings.yaml: updated gateway provider block');
  } else {
    const anchor = /\n  providers:.*?(?=\n    \S|$)/s;
    if (anchor.test(settings)) {
      settings = settings.replace(anchor, (match) => match.replace(/[ \t]*$/, '') + blockWithNl + '\n');
      console.log('[write-dsh] settings.yaml: inserted gateway provider');
    } else {
      const suffix = settings.trimEnd().length > 0 ? '\n' : '';
      settings = settings + suffix + 'llm-pi-ai:\n  providers:' + blockWithNl + '\n';
      console.log('[write-dsh] settings.yaml: created llm-pi-ai.providers + gateway');
    }
  }
  fs.writeFileSync(settingsPath, settings, 'utf8');

  // credentials.yaml: upsert DSH_GATEWAY_API_KEY under refs（key 使用 YAML 转义）
  let creds = fs.existsSync(credsPath) ? fs.readFileSync(credsPath, 'utf8') : '';
  const keyRe = new RegExp('^  DSH_GATEWAY_API_KEY:.*$', 'm');
  if (keyRe.test(creds)) {
    creds = creds.replace(keyRe, `  DSH_GATEWAY_API_KEY: ${apiKeyYaml}`);
  } else {
    if (/^refs:\s*$/m.test(creds)) {
      creds = creds.replace(/^refs:\s*$/m, `refs:\n  DSH_GATEWAY_API_KEY: ${apiKeyYaml}`);
    } else if (creds.trim().length > 0) {
      creds = creds.trimEnd() + `\nrefs:\n  DSH_GATEWAY_API_KEY: ${apiKeyYaml}\n`;
    } else {
      creds = `version: 1\nrefs:\n  DSH_GATEWAY_API_KEY: ${apiKeyYaml}\n`;
    }
  }
  fs.writeFileSync(credsPath, creds, 'utf8');
  console.log(`[write-dsh] credentials.yaml: DSH_GATEWAY_API_KEY set`);
  console.log(`[write-dsh] OK — gateway registered at ${baseURL} with ${models.length} models`);
}

/* ---------------- main ---------------- */
// 进程级兜底：任何未捕获的异步/同步异常都记录日志而非崩溃（H3）
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err.stack || err.message}`);
});
// 有条件退出前再落一次日志
process.on('exit', (code) => {
  try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] exit code=${code}\n`); } catch { }
});

if (process.argv.includes('--write-dsh')) {
  writeDshConfig(process.argv.slice(2));
} else {
  const cfg = loadConfig();
  if (cfg) startServer(cfg);
}
