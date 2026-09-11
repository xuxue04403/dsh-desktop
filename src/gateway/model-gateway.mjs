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
 *     "port": 3091,
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
import crypto from 'node:crypto';

const APP_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.dsh'), 'DSHDesktop');
let CONFIG_PATH = process.env.DSH_GATEWAY_CONFIG || path.join(APP_DIR, 'gateway.config.json');
const MODEL_CACHE_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 60_000;
// R2 防封：catalog 探测失败后的冷却期（30s 内不重试探测，防请求风暴触发风控）
const CATALOG_FAIL_COOLDOWN_MS = 30_000;
let LOG_PATH = process.env.DSH_GATEWAY_LOG || path.join(APP_DIR, 'logs', 'gateway.log');

/* ---------------- logging ---------------- */
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 日志轮转上限 5MB（修复 G3：防止长期运行磁盘膨胀）

// 本地时间戳（与宿主 app.log 的本地时间一致，避免 UTC 差 8 小时难对照）：
// 格式 YYYY-MM-DD HH:mm:ss.SSS
function localStamp(d) {
  const x = d || new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1, 2) + '-' + p(x.getDate(), 2) + ' '
    + p(x.getHours(), 2) + ':' + p(x.getMinutes(), 2) + ':' + p(x.getSeconds(), 2) + '.' + p(x.getMilliseconds(), 3);
}

function log(msg) {
  const line = `[${localStamp()}] ${msg}`;
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
// 顶层 argv 工具：--config / --log 等（服务启动与 write-dsh 共用）
function argvGet(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function defaultConfig() {
  return {
    port: 3091,
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
    // R25（审计修复）：port 兜底——手改配置缺/坏 port 时 listen(undefined) 会随机端口
    const p = Number(cfg.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      log(`config port invalid (${cfg.port}), falling back to 3091`);
      cfg.port = 3091;
    }
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
/** 熔断时长可用环境变量覆盖（缺省不变，仅用于测试/极端调试场景）。 */
function envMs(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const BREAKER_SHORT_MS = envMs('DSH_GATEWAY_BREAKER_SHORT_MS', 90_000);      // R20：短熔断 90 秒（网络错/5xx——
                                                // clash 抖动很常见，5 分钟误伤过大：全家熔断期间请求
                                                // 全部 404/503，用户以为网关坏了）
const BREAKER_LONG_MS = envMs('DSH_GATEWAY_BREAKER_LONG_MS', 30 * 60_000);  // 长熔断 30 分钟（401/403 业务拒绝）

/* 熔断状态机（审计修复 P2，本次）：closed / open / half-open
 * 旧版 breakerIsOpen() 带**副作用**（冷却到点即把 fails 重置、openUntil 清零），而同一个请求会
 * 调用它 2 次以上（预过滤 + 候选过滤）→ 冷却到点时 N 个并发请求**同时**判定"已恢复"，一起打向
 * 刚恢复（很可能仍然坏）的上游，正是熔断要避免的探测风暴/风控画像。
 * 新实现：
 *  - breakerIsOpen()  **纯读**（无副作用，可被同一请求任意次调用）：当前是否应跳过该 provider
 *  - breakerAcquire() 唯一的状态转换入口：forward() 准备发请求时调用；冷却到点才把状态推进到
 *    half-open 并**占用唯一一个**探测名额（单飞），抢占失败 = 本次不发任何上游请求
 *  - 探测失败 → 回 open（半开时不看阈值，立即回 open）；探测成功/上游正常应答 → closed
 * 保底性质（与旧实现一致，必须保住）：冷却到点必然放行一次探测 → 熔断**不会永久卡死**。
 */
const breaker = new Map();                      // providerId -> { state, fails, openUntil }

/** 纯读：该 provider 当前是否不可用（冷却窗口内，或半开探测名额已被别的请求占用）。 */
function breakerIsOpen(providerId) {
  const b = breaker.get(providerId);
  if (!b) return false;
  if (b.state === 'open') return Date.now() < b.openUntil;   // 冷却中 → 跳过
  if (b.state === 'half-open') return true;                  // 已有探测在途 → 其它并发请求跳过
  return false;                                              // closed
}

/** 准备向上游发起请求前调用：占用半开探测名额（唯一的 open → half-open 转换点）。 */
function breakerAcquire(providerId) {
  const b = breaker.get(providerId);
  if (!b || !b.state || b.state === 'closed') return true;
  if (b.state === 'half-open') return false;                 // 单飞：探测名额已被占
  if (Date.now() < b.openUntil) return false;                // 冷却未到点（并发窗口内）
  b.state = 'half-open';
  b.fails = BREAKER_THRESHOLD - 1;                           // 探测失败 → 立刻回到 open
  breaker.set(providerId, b);
  log(`breaker HALF-OPEN: ${providerId} 冷却到点，放行一次探测（single-flight）`);
  return true;
}

function breakerRecordFail(providerId, httpStatus) {
  const b = breaker.get(providerId) || { state: 'closed', fails: 0, openUntil: 0 };
  b.fails += 1;
  // V2b：401/403 业务性拒绝（鉴权失败/需充值/禁用）不会自愈——首次出现即长熔断 30 分钟，
  // 不必等连续 3 次（避免固定失败模式被风控画像）；网络错/5xx 仍按 3 次阈值短熔断
  const immediate = (httpStatus === 401 || httpStatus === 403);
  // half-open 探测失败必须回到 open（否则名额永远被占 → 熔断卡死），故不看阈值
  if (b.fails >= BREAKER_THRESHOLD || immediate || b.state === 'half-open') {
    const long = immediate;
    const ms = long ? BREAKER_LONG_MS : BREAKER_SHORT_MS;
    b.state = 'open';
    b.openUntil = Date.now() + ms;
    log(`breaker OPEN: ${providerId} 失败（${httpStatus || 'network'}），熔断 ${
      ms >= 60_000 ? Math.round(ms / 60_000) + ' 分钟' : ms + 'ms'}（保护上游账号）`);
  }
  breaker.set(providerId, b);
}
function breakerRecordSuccess(providerId) {
  if (breaker.has(providerId)) breaker.delete(providerId);
}

/** 熔断冷却剩余秒数（客户端重试提示用）。 */
function breakerCooldownSecs(providers) {
  const until = Math.max(0, ...providers.map((p) => {
    const b = breaker.get(p.id);
    return b ? b.openUntil - Date.now() : 0;
  }));
  return Math.max(1, Math.ceil((until || BREAKER_SHORT_MS) / 1000));
}

// V1 防封：日志脱敏——catalog/上游错误体可能回显 key，统一打码各类凭证片段
// R25（审计）：补 Bearer/JWT(eyJ)/统一网关 key（dsh-gateway-）与 api-key 头形态
function maskSecrets(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, (m) => `sk-***${m.slice(-4)}`)
    .replace(/dsh-gateway-[A-Za-z0-9_\-]{8,}/g, (m) => `dsh-gateway-***${m.slice(-4)}`)
    .replace(/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g, 'eyJ***.***.***')  // JWT
    .replace(/((?:x-api-key|api-key|authorization)["':\s=]+)(Bearer\s+)?([^\s"',}]+)/gi, (m, p1, p2) => p1 + (p2 || '') + '***');
}

async function fetchCatalog(provider, force, clientUA, clientProfile) {
  // 审计修复（P1-5）：熔断期间**不再向上游发任何请求**（含 /models 探测）。旧版在熔断
  // 过滤之前就 Promise.all 探测，401/403 触发 30 分钟长熔断后仍每 30 秒带同一个坏 key
  // 打一次 /models（约 60 次）——正是防封模块要避免的持续打点。返回 null 表示"目录未知"，
  // 后续的熔断过滤仍会把该 provider 排除在候选之外。
  if (breakerIsOpen(provider.id)) return null;
  const cached = catalogCache.get(provider.id);
  if (!force && cached && Date.now() - cached.ts < (cached.failed ? CATALOG_FAIL_COOLDOWN_MS : MODEL_CACHE_TTL_MS)) return cached.models;
  // 并发去重：同一 provider 已有在途目录请求时直接复用（修复 G5）
  if (!force && catalogInflight.has(provider.id)) return catalogInflight.get(provider.id);
  const promise = doFetchCatalog(provider, clientUA, clientProfile);
  catalogInflight.set(provider.id, promise);
  try {
    return await promise;
  } finally {
    catalogInflight.delete(provider.id);
  }
}

async function doFetchCatalog(provider, clientUA, clientProfile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // Q1：catalog 探测同样走上游请求头构造（clientUA/clientProfile 配置时完全仿真，
    // 否则 new-api 客户端白名单会拦 catalog 导致模型列表为空）
    const headers = upstreamRequestHeaders({}, provider.apiKey, clientUA, false, clientProfile);
    const res = await fetch(`${upstreamBase(provider.baseURL)}/models`, {
      headers,
      signal: controller.signal,
    });
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
  } finally {
    // 审计修复（P3）：失败路径原本跳过 clearTimeout → 每次探测失败都留下一个悬挂
    // 10 秒定时器（fetch 已抛错，abort 仍会触发）。
    clearTimeout(timer);
  }
}

/* ---------------- auth ---------------- */
// 审计修复（P1，安全）：旧实现直接 `x === cfg.apiKey`。当配置里 apiKey 为空串（UI 保存
// 或手改都可能）时，`x-api-key:`（空值头，Node 解析为 ''）恰好相等 → **鉴权被完全绕过**：
// 本机任何进程都能免 key 白用已充值的上游额度。现在：配置侧 key 必须是非空字符串且
// 长度 ≥ 16，否则一律判伪（fail-closed，宁可 401 也不放行）；比较用摘要 + 恒定时间。
function authorized(req, cfg) {
  const expect = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  if (expect.length < 16) return false;
  const h = String(req.headers['authorization'] || '');
  let given = '';
  if (h.toLowerCase().startsWith('bearer ')) given = h.slice(7).trim();
  else if (typeof req.headers['x-api-key'] === 'string') given = req.headers['x-api-key'].trim();
  else return false;
  if (given.length === 0) return false;
  try {
    const a = crypto.createHash('sha256').update(given, 'utf8').digest();
    const b = crypto.createHash('sha256').update(expect, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
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
        req.removeAllListeners('data');
        // 审计修复（P1-2）：旧版 req.pause() 保留连接并回 400 —— 但请求体没被消费，
        // 该 keep-alive 连接上**后续请求永远不会被解析**（server.requestTimeout=0 无兜底），
        // 客户端连接池复用它时表现为"请求永久挂起"。改为带 code 的错误，由调用方回 413
        // 并关闭连接（Connection: close + 响应冲完后 destroy）。
        const err = new Error('request body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
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

/** 统一的请求体错误响应：超限 → 413 + 关闭连接；其它 → 400（协议对应的错误体形状） */
function replyBodyError(res, req, e, anthropic) {
  if (e && e.code === 'BODY_TOO_LARGE') {
    try {
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
      res.end(JSON.stringify(anthropic
        ? { type: 'error', error: { type: 'invalid_request_error', message: 'request body too large (max 16MB)' } }
        : { error: { message: 'request body too large (max 16MB)' } }));
    } catch { /* 忽略 */ }
    // 响应冲完再销毁连接：既不毒化 keep-alive，也不让响应被 RST 截断
    try { res.once('finish', () => { try { req.destroy(); } catch { /* 忽略 */ } }); } catch { /* 忽略 */ }
    return;
  }
  json(res, 400, anthropic
    ? { type: 'error', error: { type: 'invalid_request_error', message: `invalid JSON body: ${e && e.message}` } }
    : { error: { message: `invalid JSON body: ${e && e.message}` } });
}

function providersForModel(cfg, model) {
  return cfg.providers
    .filter((p) => p.enabled !== false)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
}

/* ---------------- 候选收敛：catalog × 配置 models（审计修复 P1） ----------------
 * 旧版只按 catalog 分桶：catalog 不可用（null）时**任意**模型名都会被发给**所有**供应商
 *（烧额度，最后 503），而配置里每个 provider 的 `models` 声明完全不参与路由。
 * 规则（可信度从高到低，2026-09-10 复核修订）：
 *   catalog 命中该模型                       → 候选（排最前）
 *   **配置 models 显式声明了该模型**          → 候选（用户写在配置里的声明优先：
 *     上游 /models 常常滞后或不完整，不能因为快照没列出就否掉用户显式配好的模型——
 *     实测场景：agentrouter 的 catalog 不含 glm-5.3，但配置声明了，旧规则会 404
 *     "not offered by any configured provider"）
 *   catalog 未知(null) + models 空/未声明    → 候选（无法判断，保持宽容）
 *   catalog 已知但不含 且 配置未声明          → 不是候选（模型名写错/上游没这个模型）
 *   catalog 未知 + models 非空且不含该模型    → 不是候选（"模型没配上"的典型场景）
 * 返回 { eligible, reasons }：reasons 记录每个 provider 的判定原因（写日志 + 404 错误详情），
 * 便于用户排查"模型没配上"。
 */
function selectCandidates(candidates, catalogResults, model) {
  const hit = [];
  const lenient = [];
  const reasons = [];
  candidates.forEach((p, i) => {
    const set = catalogResults ? catalogResults[i] : null;
    const declared = Array.isArray(p.models) ? p.models.filter((m) => typeof m === 'string') : [];
    const isDeclared = declared.includes(model);
    const catalogKnown = set !== null && set !== undefined;
    if (catalogKnown && set.has(model)) { hit.push(p); reasons.push({ id: p.id, reason: 'catalog-hit' }); return; }
    if (isDeclared) {
      lenient.push(p);
      reasons.push({ id: p.id, reason: catalogKnown ? 'models-declared(catalog-miss)' : 'catalog-unknown,models-match' });
      return;
    }
    if (!catalogKnown && declared.length === 0) { lenient.push(p); reasons.push({ id: p.id, reason: 'catalog-unknown,models-undeclared' }); return; }
    reasons.push({ id: p.id, reason: catalogKnown ? 'catalog-miss' : 'catalog-unknown,models-miss' });
  });
  return { eligible: [...hit, ...lenient], reasons };
}

/** 每个 provider 的判定原因（日志/错误详情用；只含网关自身的判定码，不含上游内容）。 */
function routeReasonsText(reasons) {
  return reasons.map((r) => `${r.id}=${r.reason}`).join(' ');
}
function routeReasonsDetail(reasons) {
  return reasons.map((r) => `${r.id}: ${r.reason}`);
}

// 404 文案：提示用户检查网关配置里该模型所属供应商的 models 列表（不回显上游内容）
const MODEL_NOT_OFFERED_HINT = '请检查网关配置里该模型所属供应商的 models 列表';

/**
 * 读上游**错误响应体**（带超时，审计修复 P2-3）。
 * 旧版在这里 `await upstream.text()`：错误响应的计时器刚被 clearTimeout，body 又没有任何
 * 中止点——上游返回 429/5xx 响应头后卡住不结束 body（代理卡死/LB 半开）时 forward 永不返回，
 * 客户端**永久挂起**（此时 90s 空闲看门狗尚未创建，也没有兜底）。
 */
async function readTextWithTimeout(resp, ms = 5000, limit = 500) {
  let timer = null;
  try {
    const bodyPromise = resp.text().then((t) => String(t).slice(0, limit));
    const timeoutPromise = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    const out = await Promise.race([bodyPromise, timeoutPromise]);
    if (out === null) {                      // 超时：取消 body，避免 socket 悬挂
      try { await resp.body?.cancel(); } catch { /* 忽略 */ }
      return '';
    }
    return out;
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
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

// V2 防屏蔽：Codex 客户端完全仿真（OpenAI 系特征，供 new-api/one-api 白名单识别为 Codex）
function codexClientHeaders() {
  return {
    'user-agent': 'codex/0.49.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    accept: 'application/json, text/event-stream',
  };
}

/** 构造发往上游的最终请求头。
 * clientProfile='codex' → Codex 完全仿真（不留任何客户端透传痕迹）
 * clientProfile='claude' 或仅 clientUA → Claude Code 完全仿真（UA 可被 clientUA 覆盖）
 * 两者皆空             → 透传 dsh 客户端标识（K1 防屏蔽）
 * anthropic=true    → Anthropic 协议模式（T5）：x-api-key 替代 Bearer + anthropic-version
 */
function upstreamRequestHeaders(reqHeaders, apiKey, clientUA, anthropic, clientProfile) {
  const out = {};
  const skip = new Set([
    'authorization', 'host', 'content-length', 'connection',
    'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade',
    'te', 'trailer', 'content-type', 'accept', 'accept-encoding',
    'x-api-key', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
    'cookie', 'origin', 'referer',
  ]);

  if (clientProfile === 'codex') {
    // Codex 完全仿真（V2）：不透传任何 dsh 头
    Object.assign(out, codexClientHeaders());
    if (clientUA) out['user-agent'] = clientUA;   // 允许用户覆盖具体 UA 值
  } else if (clientProfile === 'claude' || (!clientProfile && clientUA)) {
    // Claude Code 完全仿真（兼容旧配置：仅 clientUA 时按 Claude 仿真）
    Object.assign(out, claudeClientHeaders());
    if (clientUA) out['user-agent'] = clientUA;   // 允许用户覆盖具体 UA 值
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
  // R16（网关假死修复）：禁用上游连接复用——undici 连接池的空闲连接会被上游/代理
  // （clash keep-alive 超时、LB 断连）静默关闭，下次 fetch 复用死连接即挂起
  // （表现为"无调用一段时间后假死，重启网关才恢复"）。Connection: close 让每次
  // 请求用全新连接（本地代理下 TLS 握手开销可忽略），彻底消除死连接。
  out['connection'] = 'close';
  return out;
}

/**
 * 防屏蔽透传（K1，兼容保留）：保留 dsh 客户端的原始请求标识（尤其是 User-Agent，
 * dsh 的 attribution 机制强制带 `deepseek-harness/<版本> (+url)`），
 * 仅替换鉴权头与必要的协议头，其余原样转发——让上游看到的就是"dsh 直连"。
 * 扩展（P3/Q1）：配置了 clientUA 时完全仿真 Claude Code，不透传任何 dsh 特征。
 */
function passthroughHeaders(reqHeaders, apiKey, clientUA, clientProfile) {
  return upstreamRequestHeaders(reqHeaders, apiKey, clientUA, false, clientProfile);
}

/** 请求体统一翻译（R5）：转发前修正各上游不兼容字段。
 * 1) role 兼容：dsh 新版可能发送 `developer` 角色（OpenAI 协议演进），但许多上游
 *    （sensenova 等）只接受 system/assistant/user/tool → developer 合并为 system。
 * 2) 推理档位翻译：见 translateReasoningBody（reasoningEffortMap）。
 * 3) 密钥脱敏（R9）：会话历史常含真实 token（github_pat_/sk- 等样式），上游 new-api
 *    平台会以"防密钥泄露"内容过滤拦截整个请求（sensitive words / content-blocked），
 *    且真实 key 也不应发给第三方模型。转发前把这类串打码（保留前缀+长度标记+尾 4 位），
 *    语义基本无损，绕开平台误拦，同时保护密钥不外泄。
 * @returns 翻译后的 body（无变化时返回原对象）
 */

// R9：识别并打码真实 token 样式串 + 超长技术串（仅处理消息文本内容，不动 tool_calls 参数）
// 背景（dump 实证）：上游 new-api 的"疑似密钥"过滤会拦截 ≥32 位连续字母数字/横线串——
// 包括 sha256 校验和、长英文 slug、带日期的文件名等无害技术串；打码为占位符（保留长度
// 与类型提示）后语义基本无损，且不再触发平台防泄露拦截。
function maskSecretTokens(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // GitHub PAT（43+ 位，形如 github_pat_11AA...）
    .replace(/(github_pat_[A-Za-z0-9_]{20,})/g, (m) => 'github_pat_***' + m.slice(-4))
    // GitHub classic token（ghp_gho_ghu_ghs_ghr_ + 36）
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{30,})/g, (m) => m.slice(0, 4) + '***' + m.slice(-4))
    // OpenAI 风格密钥 sk-（≥16 位值）
    .replace(/\b(sk-[A-Za-z0-9]{16,})/g, (m) => 'sk-***' + m.slice(-4))
    // Anthropic 风格密钥 sk-ant-...
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{20,})/g, (m) => 'sk-ant-***' + m.slice(-4))
    // R9b：≥32 位连续 [字母数字_-] 的"疑似密钥样式长串"→ 占位符（保留长度；64 位纯 hex
    // 标记为 sha256，含横线的长 slug 标记为 slug）。URL 协议头不受影响（含 :// 不匹配）。
    .replace(/[A-Za-z0-9_-]{32,}/g, (m) => {
      if (/^[0-9a-f]{32,}$/i.test(m)) return '[sha256:' + m.length + ']';
      if (m.includes('-')) return '[slug:' + m.length + ']';
      return '[token:' + m.length + ']';
    });
}

function translateBody(body, provider) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let out = translateReasoningBody(body, provider);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  let changed = false;
  if (Array.isArray(out.messages)) {
    const msgs = out.messages.map((m) => {
      if (!m) return m;
      let n = m;
      if (n.role === 'developer') { n = { ...n, role: 'system' }; changed = true; }
      // 文本内容打码（content 为字符串时；跳过 tool_calls 参数与 tool 结果中的结构化值）
      if (typeof n.content === 'string') {
        const masked = maskSecretTokens(n.content);
        if (masked !== n.content) { n = { ...n, content: masked }; changed = true; }
      }
      return n;
    });
    if (changed) out = { ...out, messages: msgs };
  }
  return out;
}

/** 推理档位统一翻译（R4 新）：把 dsh 发来的统一推理档位，翻译成各上游自己的词汇。
 * 背景：上游 deepseek-v4-flash 的推理字段词汇各不相同——
 *   sensenova 接受 reasoning_effort: low|medium|high|xhigh|none（拒绝 max）；
 *   new-api(agentrouter/air-outer) 接受 low/high/max；
 * dsh 官方按 off/low/high/max 发统一档位。网关在 provider 配置可选字段
 * `reasoningEffortMap`（如 {"low":"low","medium":"medium","high":"high","max":"xhigh","off":"none"}）
 * 缺省时恒等透传（与桌面助手行为一致，不破坏旧配置）。
 * @returns 翻译后的 body（无变化时返回原对象）
 */
function translateReasoningBody(body, provider) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const map = provider && provider.reasoningEffortMap && typeof provider.reasoningEffortMap === 'object'
    ? provider.reasoningEffortMap : null;
  if (!map) return body;                      // 无映射配置：原样透传

  const out = { ...body };
  const effort = body.reasoning_effort;
  const thinking = body.thinking;
  // 当前请求的推理意图：off / 具体档位 / 未指定
  let want = null;                            // null=未指定
  if (thinking && typeof thinking === 'object' && thinking.type === 'disabled') want = 'off';
  else if (typeof effort === 'string') want = effort;

  if (want === null) return out;              // 未指定推理 → 不加戏
  const mapped = map[want];
  if (mapped === undefined) return out;       // 档位不在映射表 → 原样（宁可不改，不丢档）

  // 依据映射表值形态决定发送方式：
  //   - 字符串 → reasoning_effort=<值>（同时清理 thinking 或保留语义由值决定）
  //   - 对象 { thinking: 'disabled'|'enabled' } → 仅 thinking.type
  delete out.reasoning_effort;
  delete out.thinking;
  if (typeof mapped === 'object' && mapped !== null) {
    if (mapped.thinking === 'disabled') out.thinking = { type: 'disabled' };
    else if (mapped.thinking === 'enabled') out.thinking = { type: 'enabled' };
    if (typeof mapped.effort === 'string') out.reasoning_effort = mapped.effort;
  } else if (typeof mapped === 'string') {
    if (mapped === 'disabled' || mapped === 'off' || mapped === 'none') {
      // off 语义：sensenova 用 reasoning_effort: none；deepseek 系用 thinking disabled——
      // 字符串 none/off/disabled 直接作为 reasoning_effort 值发送（sensenova 认 none，
      // 若上游只认 thinking.type 的，可改用对象映射）
      out.reasoning_effort = mapped;
    } else {
      out.reasoning_effort = mapped;
      out.thinking = { type: 'enabled' };     // 开启推理（deepseek 系惯例）
    }
  }
  return out;
}

// R9c：长串降敏——把文本中 ≥32 位连续 [字母数字_-] 的"疑似密钥样式长串"替换为
// 类型占位符（[sha256:64] / [slug:45] / [token:34]），语义基本无损（模型不需要读
// hash 全文），绕开 new-api 平台的"疑似密钥泄露"内容过滤（sensitive words / content-blocked）。
function desensitizeLongTokens(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[A-Za-z0-9_-]{32,}/g, (m) => {
    if (/^[0-9a-f]{32,}$/i.test(m)) return '[sha256:' + m.length + ']';
    if (m.includes('-')) return '[slug:' + m.length + ']';
    return '[token:' + m.length + ']';
  });
}

// 对消息体做深度降敏（messages 的字符串 content；tool 消息内容也降敏——历史工具
// 结果正是长串重灾区；tool_calls 参数不动，避免破坏工具调用的 JSON）
// R14：兼容 Anthropic blocks 数组（[{type:'text',text:'…'}]）——对 text 块降敏
function desensitizeBodyMessages(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) return body;
  let changed = false;
  const msgs = body.messages.map((m) => {
    if (!m) return m;
    if (typeof m.content === 'string') {
      const d = desensitizeLongTokens(m.content);
      if (d !== m.content) { changed = true; return { ...m, content: d }; }
      return m;
    }
    if (Array.isArray(m.content)) {
      let bc = false;
      const blocks = m.content.map((b) => {
        if (b && b.type === 'text' && typeof b.text === 'string') {
          const d = desensitizeLongTokens(b.text);
          if (d !== b.text) { bc = true; return { ...b, text: d }; }
        }
        return b;
      });
      if (bc) { changed = true; return { ...m, content: blocks }; }
    }
    return m;
  });
  return changed ? { ...body, messages: msgs } : body;
}

/* ---------------- 上游错误分类（审计修复 P1，本次） ----------------
 * 上游内容拦截（new-api/one-api 的"疑似密钥泄露"过滤）：换一家供应商 + R9c 降敏重试**确实可能成功**，
 * 这是有意保留的 failover 行为。
 */
const CONTENT_BLOCK_RE = /sensitive\s*words|content[-_]blocked|content_blocked/i;

/**
 * 404 的细分特征（审计补充）：只有**明确指向模型**的 404（模型不存在/不支持/无权限）
 * 才算确定性错误、终止 failover；其余 404（路由不存在：某些供应商没有 /responses 之类
 * 的端点，返回通用 Not Found 或空体）仍换下一家——否则"Codex 仿真"用户会被优先级最高
 * 的那家直接打死。判不出来时按"路由不存在"处理（保守，保持旧行为）。
 */
const MODEL_MISSING_RE = /model[^.\n]{0,60}(not\s+found|does\s+not\s+exist|doesn'?t\s+exist|not\s+exist|unsupported|unknown|invalid|no\s+access|permission|不存在|不支持)/i;

/** 确定性 4xx → 回给客户端的状态码（只映射到这几个"语义明确且不泄露上游信息"的状态码）。 */
const DETERMINISTIC_4XX_STATUS = { 400: 400, 404: 404, 413: 413, 422: 422 };

/**
 * 确定性 4xx 的客户端文案：**不回显上游错误体原文**（防泄露上游信息/供应商指纹），
 * 只说明"请求本身有问题 + 已停止 failover（重发给别家不会有帮助）"。
 */
function stopFailoverMessage(providerId, model, upstreamStatus) {
  const hint = upstreamStatus === 404
    ? 'the provider does not offer this model'
    : 'the request itself is invalid (parameters / size / unprocessable)';
  return `upstream provider "${providerId}" rejected model "${model}" with HTTP ${upstreamStatus} — ${hint}; `
    + 'failover stopped on purpose (re-sending the same request to other providers would not help). '
    + 'See the gateway log for the upstream detail.';
}

/* ---------------- 内容拦截诊断 dump（审计修复 P3，本次） ----------------
 * 旧版：内容拦截时**无条件**写 logs/dump/blocked-<Date.now()>.json（永不清理 → 无界增长），
 * 且摘要里 longTokens.head 记录原始长串的**前 20 字符**（可能是真密钥前缀）。
 * 现在：① 缺省不落盘，只有 DSH_GATEWAY_DUMP_BLOCKED=1 或 DSH_GATEWAY_DUMP_DIR=<dir> 才写；
 *       ② 目录内只保留最近 DUMP_KEEP_FILES 个 blocked-*.json，超出删最旧；
 *       ③ longTokens 只记 {len, kind}，不记任何原文前缀。
 */
const DUMP_KEEP_FILES = 20;

/** 内容拦截 dump 目录；未显式开启时返回 null（缺省不落盘）。 */
function blockedDumpDir() {
  const explicit = String(process.env.DSH_GATEWAY_DUMP_DIR || '').trim();
  if (explicit) return explicit;
  if (process.env.DSH_GATEWAY_DUMP_BLOCKED === '1') return path.join(path.dirname(LOG_PATH), 'dump');
  return null;
}

/** 长串类型（诊断用；绝不记录原文）。 */
function longTokenKind(s) {
  if (/^[0-9a-f]+$/i.test(s)) return 'hex';
  if (/^[0-9]+$/.test(s)) return 'digits';
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s.includes('-') ? 'slug' : 'alnum';
  return 'opaque';
}

/** 保留策略：目录内按 mtime（同秒用文件名兜底）保留最近 keep 个匹配文件，其余删除。 */
function pruneDumpDir(dir, nameRe, keep) {
  try {
    const rows = fs.readdirSync(dir)
      .filter((f) => nameRe.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch { /* 忽略：并发删除等 */ }
        return { p, f, mtime };
      })
      .sort((a, b) => (b.mtime - a.mtime) || (a.f < b.f ? 1 : -1));
    for (const r of rows.slice(keep)) {
      try { fs.unlinkSync(r.p); } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在/无权限：不影响服务 */ }
}

function writeBlockedDump(provider, status, body) {
  const dir = blockedDumpDir();
  if (!dir) return;                                  // 缺省不落盘（旧版无条件写，导致 logs/dump 无界增长）
  try {
    fs.mkdirSync(dir, { recursive: true });
    const digest = {
      at: localStamp(), provider: provider.id, status,
      model: body && body.model, stream: !!(body && body.stream),
      reasoning_effort: body && body.reasoning_effort,
      thinking: body && body.thinking,
      hasTools: Array.isArray(body && body.tools) ? body.tools.length : 0,
      msgCount: Array.isArray(body && body.messages) ? body.messages.length : 0,
      totalChars: Array.isArray(body && body.messages)
        ? body.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
        : 0,
      longTokens: Array.isArray(body && body.messages)
        ? body.messages.flatMap((m) => {
            const t = typeof m.content === 'string' ? m.content : '';
            // 找出 ≥32 位连续非空白字符段（疑似 hash/key/随机串）
            const re = /[^\s，。；：！？、,.;:!?'"()\[\]{}<>\/\\|=+*^$#@~`]{32,}/g;
            const hits = [];
            let mm; let cnt = 0;
            // 只记长度与类型：旧版记 head=原文前 20 字符（可能是真密钥前缀）
            while ((mm = re.exec(t)) && cnt < 8) { hits.push({ len: mm[0].length, kind: longTokenKind(mm[0]) }); cnt++; }
            return hits;
          }).slice(0, 20)
        : [],
    };
    const tag = String(provider.id).replace(/[^A-Za-z0-9_.-]/g, '_');   // 防 provider id 里的路径字符
    const f = path.join(dir, `blocked-${Date.now()}-${tag}.json`);
    fs.writeFileSync(f, JSON.stringify(digest, null, 2), 'utf8');
    log(`[dump] 被拦请求摘要 -> ${f}`);
    pruneDumpDir(dir, /^blocked-.*\.json$/i, DUMP_KEEP_FILES);
  } catch (_) { /* dump 失败不影响服务 */ }
}

/** Forward to one provider.
 *  返回值契约（审计修复 P1，本次）：
 *    true             → 响应已写回客户端
 *    false            → 本次失败但**可以**继续 failover（网络错/5xx/401/403/429/内容拦截）
 *    {stop:{status,upstreamStatus}} → 确定性 4xx：**立即终止**该模型的 failover 循环，由调用方
 *                        按 status 回复客户端（旧版把 400/404 也当"可切换"，同一个错误请求被
 *                        原样重发给每一家供应商 = N 倍计费 + N 倍风控）。
 */
async function forward(provider, upstreamPath, upstreamHeaders, body, res) {
  // 审计修复（P2，本次）：发请求前先占用熔断半开探测名额（唯一的状态转换点）。抢不到
  //（冷却未到点 / 已有探测在途）→ 本次不发任何上游请求，直接交给下一家。
  if (!breakerAcquire(provider.id)) {
    log(`skip ${provider.id} (breaker: cooldown or half-open probe already in flight)`);
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  let firstDetail = null;   // 首次响应体（若已读取，后续分支复用，避免 body 二次消费报错）
  try {
    // baseURL 允许“带 /v1”或“不带 /v1”两种写法（OpenAI SDK 惯例 / 用户习惯）：
    // upstreamBase() 统一规范化，upstreamPath 始终是相对 /v1 的路径（如 /chat/completions、/messages）
    // 注：Anthropic 协议（T5）下 upstreamHeaders 由 upstreamRequestHeaders(..., anthropic=true) 构造，
    // 含 x-api-key + anthropic-version、无 authorization Bearer；展开覆盖时不会被注入 Bearer。
    // R14：translateBody（role 兼容/推理翻译）是 OpenAI 协议专用——Anthropic 路径
    // 误用会破坏协议语义（如 thinking:{type:'disabled'} 被换成 reasoning_effort 字段，
    // 导致"关闭推理"失效——上游收到非 Anthropic 字段而按默认开推理处理）。
    // Anthropic 请求的 R9 打码已在 handleMessages 完成，这里原样透传。
    const isAnthropicPath = upstreamPath === '/messages';
    const outBody = isAnthropicPath ? body : translateBody(body, provider);   // R5：role 兼容 + 推理档位翻译
    upstream = await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(outBody),
      signal: controller.signal,
    });
    clearTimeout(timer);
    // R9c 自适应降敏：上游内容拦截（sensitive words / content-blocked）时，用降敏后的
    // 消息体**重试一次**（换新连接；历史里的 32+ 位技术串占位符化后不再命中平台
    // "疑似密钥"过滤）。重试成功则继续走正常流式转发；仍失败则按原逻辑处理。
    if (!upstream.ok) {
      firstDetail = await readTextWithTimeout(upstream, 5000, 500);
      if (CONTENT_BLOCK_RE.test(firstDetail)) {
        const deBody = desensitizeBodyMessages(outBody);
        if (deBody !== outBody) {
          log(`upstream ${provider.id} 内容拦截，已降敏重试一次…`);
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), UPSTREAM_TIMEOUT_MS);
          try {
            upstream = await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, {
              method: 'POST',
              headers: upstreamHeaders,
              body: JSON.stringify(deBody),
              signal: c2.signal,
            });
          } finally {
            // 重试 fetch 抛错时旧版跳过 clearTimeout → 悬挂 60s 定时器（本次一并清理）
            clearTimeout(t2);
          }
          firstDetail = null;   // 换了新响应，detail 需重读
        }
      }
    }
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
    // surface upstream error body if small（复用 firstDetail：body 只能读一次，
    // 之前 text() 已消费时再读会抛 "body already consumed" 丢失详情）
    let detail = firstDetail;
    if (detail === null) {
      detail = await readTextWithTimeout(upstream, 5000, 500);
    }
    log(`upstream ${provider.id} HTTP ${upstream.status}: ${maskSecrets(detail)}`);   // V1：日志脱敏
    const contentBlocked = CONTENT_BLOCK_RE.test(detail);
    // R8：上游内容拦截时，把触发请求的"结构摘要"落盘（不含明文 key、不含原文前缀），
    // 用于定位是什么特征触发了上游过滤（sensitive words / content-blocked）。
    // 审计修复（P3，本次）：受 env 开关控制（缺省不落盘）+ 目录保留上限，见 writeBlockedDump。
    if (contentBlocked) writeBlockedDump(provider, upstream.status, body);
    if (upstream.status === 401 || upstream.status === 403 || upstream.status === 429 || upstream.status >= 500) {
      // likely stale/misconfigured key, rate-limited, or dead endpoint —— 冷却缓存，防风暴（R3）
      // R25：429（限流）计入熔断——不熔断会加剧限流；短熔断（90s）已足够退避
      catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
      breakerRecordFail(provider.id, upstream.status);   // V2：按状态码分级熔断（401/403 → 30 分钟）
      return false;
    }
    // 审计修复（P1，本次）：确定性 4xx（401/403/429 之外的 4xx）**立即终止该模型的 failover**。
    // 旧版把 400/404 也归入"可切换"分支（有意为之的注释），结果是同一个"请求本身有错"的 body
    // 被原样重发给每一家供应商（N 倍计费 + N 倍风控画像），客户端最终拿到可重试的 503
    //（误导用户/客户端反复重试同一个必然失败的请求）。
    // 保留的例外：上游**内容拦截**（sensitive words / content_blocked）——换一家供应商 +
    // R9c 降敏重试可能成功，继续 failover（见上方的降敏重试）。
    // 这两种 4xx 都说明上游**能正常应答**（策略性拒绝，连接性是健康的）→ 释放熔断半开探测
    // 名额；否则"确定性 4xx 不记失败"会让半开名额永远被占（熔断卡死）。
    breakerRecordSuccess(provider.id);
    if (!contentBlocked) {
      // 审计补充：404 要分两种——
      //  · 上游**不实现该路由**（如某些供应商没有 /responses，返回通用 404/空体）：
      //    换下一家是有意义的，否则"Codex 仿真"用户会被优先级最高的那家直接打死；
      //  · 上游**明确说模型不存在/不支持**：这是确定性错误，重发给每一家只是 N 倍计费。
      // 用响应体特征区分，判不出来时保守按"路由不存在"继续 failover。
      if (upstream.status === 404 && !MODEL_MISSING_RE.test(detail)) {
        log(`upstream ${provider.id} HTTP 404（未见"模型不存在"特征，按路由不存在处理）→ 继续 failover`);
        return false;
      }
      const status = DETERMINISTIC_4XX_STATUS[upstream.status] || 400;
      log(`upstream ${provider.id} 确定性 4xx HTTP ${upstream.status} → 终止 failover（回 ${status}，不回显上游原文）`);
      return { stop: { status, upstreamStatus: upstream.status } };
    }
    log(`upstream ${provider.id} HTTP ${upstream.status} 判定为内容拦截 → 继续 failover（换供应商/降敏）`);
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
    // R7 强壮性：读流加"空闲超时"——上游已连接但长时间不吐数据（挂起/代理卡死）时
    // 主动断开，避免 dsh 客户端无限等待后重连（表现为"经常重连模型请求"）。
    const IDLE_READ_MS = 90_000;
    let lastRead = Date.now();
    let idleTimer = setInterval(() => {
      if (Date.now() - lastRead > IDLE_READ_MS) {
        log('upstream stream idle timeout (' + IDLE_READ_MS + 'ms)，断开。');
        clearInterval(idleTimer);
        try { reader.cancel(); } catch { }
        try { res.destroy(); } catch { }
      }
    }, 5000);
    // 审计修复（P1-3）：客户端断开必须**立即取消上游流**。旧版只 try/catch 包 res.write，
    // 但客户端 socket 销毁后 write 既不抛错也不发 error（只返回 false）——catch 是死代码，
    // 循环会一直读到上游结束：用户点"停止"后上游继续生成（重复计费/占额度），
    // 而且最终 return true → 日志与统计记成 status=ok。
    let clientGone = false;
    const onClientClose = () => {
      if (clientGone) return;
      clientGone = true;
      log('client closed connection, cancelling upstream stream');
      try { reader.cancel(); } catch { /* 忽略 */ }
      clearInterval(idleTimer);
    };
    try { res.once('close', onClientClose); } catch { /* 忽略 */ }
    try {
      while (true) {
        if (clientGone || res.destroyed || res.writableEnded) {
          try { await reader.cancel(); } catch { /* 忽略 */ }
          return false;   // 客户端已走：不能记 ok，也不必 failover（调用方有 headersSent 守卫）
        }
        const { done, value } = await reader.read();
        if (done) break;
        lastRead = Date.now();
        // 客户端可能随时断开（点停止/超时/关页）：write 抛 EPIPE 必须捕获，
        // 否则未处理异常会经 async 回调炸掉整个网关进程（C1）
        try {
          res.write(Buffer.from(value));
        } catch (writeErr) {
          log(`client disconnected during stream: ${writeErr.message}`);
          try { await reader.cancel(); } catch { }
          res.destroy();
          clearInterval(idleTimer);
          return false;
        }
      }
    } catch (readErr) {
      // 上游流异常：断开客户端，避免悬挂
      log(`upstream stream error: ${readErr.message}`);
      try { res.destroy(); } catch { }
      return false;
    } finally {
      clearInterval(idleTimer);
      try { res.removeListener('close', onClientClose); } catch { /* 忽略 */ }
      try { reader.releaseLock(); } catch { }
    }
    if (clientGone) return false;   // 收尾阶段才发现断开 → 同样不记成功
  }
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.end();
  } catch { }
  return true;
}

// 诊断 dump（R8）：env DSH_GATEWAY_DUMP_BODY=<dir> 时，把每个 chat/messages 请求的
// 结构摘要落盘（不存明文 key；摘要里的样本先经 maskSecretTokens 打码再落盘），
// 用于定位上游敏感词拦截的触发特征。
// env DSH_GATEWAY_DUMP_FULL=1 时额外把完整请求体落盘（脱敏 key），用于取证真实请求。
// 审计修复（P3，本次）：目录内 gw-*.json 摘要同样受保留上限约束（旧版无清理策略 → 无界增长）；
// full-*.json 是用户显式开启 DSH_GATEWAY_DUMP_FULL 才产生的取证文件，不做自动删除。
function dumpBodyDigest(body, tag) {
  try {
    const dir = process.env.DSH_GATEWAY_DUMP_BODY;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    // 完整请求体（脱敏后落盘，供逐字节对比/取证——明文 key/长串经 maskSecretTokens 打码）
    if (process.env.DSH_GATEWAY_DUMP_FULL === '1' && body && body.messages) {
      const sanitized = {
        ...body,
        messages: body.messages.map((m) => {
          if (!m) return m;
          const n = { ...m };
          if (typeof n.content === 'string') n.content = maskSecretTokens(n.content);
          if (Array.isArray(n.content)) {
            n.content = n.content.map((b) =>
              (b && b.type === 'text' && typeof b.text === 'string')
                ? { ...b, text: maskSecretTokens(b.text) } : b);
          }
          if (n.tool_calls) n.tool_calls = '<tool_calls>';   // 不落工具参数细节
          return n;
        }),
      };
      const fullF = path.join(dir, 'full-' + Date.now() + '-' + tag + '.json');
      fs.writeFileSync(fullF, JSON.stringify(sanitized), 'utf8');
      log(`[dump] 完整请求体(脱敏) -> ${fullF} (${sanitized.messages.length} 条消息)`);
    }
    const digest = {
      at: localStamp(),
      tag,
      model: body && body.model,
      stream: !!(body && body.stream),
      reasoning_effort: body && body.reasoning_effort,
      thinking: body && body.thinking,
      hasTools: Array.isArray(body && body.tools) ? body.tools.length : 0,
      msgCount: Array.isArray(body && body.messages) ? body.messages.length : 0,
      // R10：记录消息结构取证（roles 空说明 role 字段缺失/结构异常）
      msg0Keys: (body && body.messages && body.messages[0]) ? Object.keys(body.messages[0]) : [],
      msg0Role: (body && body.messages && body.messages[0]) ? body.messages[0].role : undefined,
      msg0ContentType: (body && body.messages && body.messages[0] && body.messages[0].content) ? (Array.isArray(body.messages[0].content) ? 'array:' + body.messages[0].content.length : typeof body.messages[0].content) : undefined,
      msg0Sample: (body && body.messages && body.messages[0] && typeof body.messages[0].content === 'string')
        ? maskSecretTokens(body.messages[0].content).slice(0, 80)   // 审计修复：样本先打码（旧版可能落真密钥前缀）
        : undefined,
      roles: Array.isArray(body && body.messages)
        ? body.messages.slice(0, 50).map((m) => (m && m.role) || '?').join(',')
        : '',
      tools: Array.isArray(body && body.tools)
        ? body.tools.map((t) => (t && t.function && t.function.name) || '?').join(',')
        : '',
    };
    const f = path.join(dir, 'gw-' + Date.now() + '-' + tag + '.json');
    fs.writeFileSync(f, JSON.stringify(digest, null, 2), 'utf8');
    log(`[dump] 请求摘要 -> ${f}`);
    pruneDumpDir(dir, /^gw-.*\.json$/i, DUMP_KEEP_FILES);
  } catch (_) { /* dump 失败不影响服务 */ }
}

async function handleCompletion(cfg, req, res, body, upstreamPath) {
  dumpBodyDigest(body, 'chat');   // R8：诊断用（env 控制）
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

  // 1) availability pre-filter（审计修复 P1，本次）：catalog × 配置 models，见 selectCandidates
  //    并行探测各供应商目录，避免串行等待放大首请求延迟（E3）
  const catalogResults = await Promise.all(candidates.map((p) => fetchCatalog(p, false, cfg.clientUA, cfg.clientProfile)));
  const { eligible, reasons } = selectCandidates(candidates, catalogResults, model);
  const reasonsText = routeReasonsText(reasons);

  // V1 防封：跳过熔断中的 provider（连续失败保护期，不发起上游请求）
  const breakerOpen = (p) => { if (breakerIsOpen(p.id)) { log(`skip ${p.id} (breaker open)`); return true; } return false; };
  const ordered = eligible.filter((p) => !breakerOpen(p));
  if (ordered.length === 0) {
    if (eligible.length === 0 && candidates.length > 0 && candidates.every((p) => breakerIsOpen(p.id))) {
      // 全部候选都熔断中（catalog 因熔断未探测 → 归属无法判定）：暂时状态 → 503 + 重试提示（R20）
      log(`[route] ${model}: 全部候选熔断，归属无法判定（${reasonsText}）`);
      logCall('breaker-all', 'fail');
      return json(res, 503, { error: { message: `all providers for model "${model}" are temporarily in breaker cooldown (network/upstream failures); retry in ~${breakerCooldownSecs(candidates)}s or restart the gateway` } });
    }
    if (eligible.length === 0) {
      // 没有任何候选承载该模型：catalog 未收录 / models 列表不含 → 404 + 排查提示
      //（只回网关自身的判定码，不回显上游内容）
      log(`[route] ${model}: 无候选 provider（${reasonsText}）`);
      logCall('no-provider', 'fail');
      return json(res, 404, { error: {
        message: `model "${model}" is not offered by any configured provider — ${MODEL_NOT_OFFERED_HINT}`,
        details: routeReasonsDetail(reasons),
      } });
    }
    // 候选存在但全部处于熔断冷却：暂时状态 → 503 + 重试提示（R20）
    log(`[route] ${model}: 候选全部熔断（${reasonsText}）`);
    logCall('breaker-all', 'fail');
    return json(res, 503, { error: { message: `all providers for model "${model}" are temporarily in breaker cooldown (network/upstream failures); retry in ~${breakerCooldownSecs(eligible)}s or restart the gateway` } });
  }

  // 路由模式（S1）：
  //  - 缺省 / "failover"：主备——固定从列表头开始尝试，失败切下一家（传统行为）
  //  - "round-robin"：轮询——同一模型每次请求从不同起点开始，流量分摊到各家；
  //    每家仍按 priority 顺序（candidates 已按 priority 排序），失败同样切下一家
  let tryOrder = ordered;
  if (cfg.routing === 'round-robin' && ordered.length > 1) {
    // 审计修复（P3）：rrCounters 的 key 是**客户端可控**的 model 字符串——无界增长。
    // 加一个粗粒度上限（超限即整体重置，轮询起点偏差可忽略）。
    if (rrCounters.size > 1000) rrCounters.clear();
    let n = rrCounters.get(model) || 0;
    rrCounters.set(model, n + 1);
    const start = n % ordered.length;
    if (start > 0) tryOrder = [...ordered.slice(start), ...ordered.slice(0, start)];
  }
  for (const p of tryOrder) {
    log(`try ${p.id} for ${model}`);
    // 透传 dsh 原始请求标识（K1 防屏蔽）/ 仿真模式（V2: clientProfile）：clientHeaders = req.headers
    const out = await forward(p, upstreamPath.replace(/^\/v1/, ''), passthroughHeaders(req.headers, p.apiKey, cfg.clientUA, cfg.clientProfile), body, res);
    if (out === true) {
      log(`served ${model} via ${p.id}`);
      logCall(`via=${p.id}`, 'ok');
      return;
    }
    // 审计修复（P1，本次）：确定性 4xx → 立即终止 failover，按映射后的状态码回复客户端
    if (out && out.stop) {
      log(`failover stopped (${model} via ${p.id} HTTP ${out.stop.upstreamStatus} → ${out.stop.status})`);
      logCall(`via=${p.id}`, 'fail:' + out.stop.status);
      return json(res, out.stop.status, { error: { message: stopFailoverMessage(p.id, model, out.stop.upstreamStatus) } });
    }
    // R25（审计修复）：响应头已发出（流中途失败/客户端断开）→ failover 无意义，
    // 继续只会对剩余供应商重复计费/风控
    if (res.headersSent || res.destroyed) {
      logCall('stream-broken', 'fail');
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
  dumpBodyDigest(body, 'messages');   // R8/R10：诊断 dump（env 控制）
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
  // R9：Anthropic content blocks 的 text 字段同样做密钥打码（与 OpenAI 路径一致）
  let outBody;
  if (body && Array.isArray(body.messages)) {
    let changed = false;
    const msgs = body.messages.map((m) => {
      if (!m) return m;
      // content 为字符串
      if (typeof m.content === 'string') {
        const d = maskSecretTokens(m.content);
        if (d !== m.content) { changed = true; return { ...m, content: d }; }
        return m;
      }
      // content 为 blocks 数组（[{type:'text',text:'…'}]）
      if (Array.isArray(m.content)) {
        let bc = false;
        const blocks = m.content.map((b) => {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            const d = maskSecretTokens(b.text);
            if (d !== b.text) { bc = true; return { ...b, text: d }; }
          }
          return b;
        });
        if (bc) { changed = true; return { ...m, content: blocks }; }
      }
      return m;
    });
    outBody = changed ? { ...body, messages: msgs, model } : { ...body, model };
  } else {
    outBody = { ...body, model };
  }

  const candidates = providersForModel(cfg, model);
  if (candidates.length === 0) {
    logCall('no-provider', 'fail');
    return json(res, 404, { type: 'error', error: { type: 'invalid_request_error', message: `model "${model}" is not configured on this gateway` } });
  }

  // 候选收敛（审计修复 P1，本次）：catalog × 配置 models，见 selectCandidates
  const catalogResults = await Promise.all(candidates.map((p) => fetchCatalog(p, false, cfg.clientUA, cfg.clientProfile)));
  const { eligible, reasons } = selectCandidates(candidates, catalogResults, model);
  const reasonsText = routeReasonsText(reasons);

  // V1 防封：跳过熔断中的 provider（连续失败保护期，不发起上游请求）
  const breakerOpen = (p) => { if (breakerIsOpen(p.id)) { log(`skip ${p.id} (breaker open)`); return true; } return false; };
  const ordered = eligible.filter((p) => !breakerOpen(p));
  if (ordered.length === 0) {
    if (eligible.length === 0 && candidates.length > 0 && candidates.every((p) => breakerIsOpen(p.id))) {
      // 全部候选都熔断中（catalog 因熔断未探测 → 归属无法判定）：暂时状态 → 503（R20），不再误报 404
      log(`[route] ${model}: 全部候选熔断，归属无法判定（${reasonsText}）`);
      logCall('breaker-all', 'fail');
      return json(res, 503, { type: 'error', error: { type: 'api_error', message: `all providers for model "${model}" are temporarily in breaker cooldown; retry in ~${breakerCooldownSecs(candidates)}s or restart the gateway` } });
    }
    if (eligible.length === 0) {
      // catalog 未收录且 models 列表不含 → 404 + 排查提示（只回网关自身的判定码，不回显上游内容）
      log(`[route] ${model}: 无候选 provider（${reasonsText}）`);
      logCall('no-provider', 'fail');
      return json(res, 404, { type: 'error', error: {
        type: 'invalid_request_error',
        message: `model "${model}" is not offered by any configured provider — ${MODEL_NOT_OFFERED_HINT}`,
        details: routeReasonsDetail(reasons),
      } });
    }
    // 候选存在但全部处于熔断冷却：暂时状态 → 503（R20）
    log(`[route] ${model}: 候选全部熔断（${reasonsText}）`);
    logCall('breaker-all', 'fail');
    return json(res, 503, { type: 'error', error: { type: 'api_error', message: `all providers for model "${model}" are temporarily in breaker cooldown; retry in ~${breakerCooldownSecs(eligible)}s or restart the gateway` } });
  }

  let tryOrder = ordered;
  if (cfg.routing === 'round-robin' && ordered.length > 1) {
    // 审计修复（P3）：rrCounters 的 key 是**客户端可控**的 model 字符串——无界增长。
    // 加一个粗粒度上限（超限即整体重置，轮询起点偏差可忽略）。
    if (rrCounters.size > 1000) rrCounters.clear();
    let n = rrCounters.get(model) || 0;
    rrCounters.set(model, n + 1);
    const start = n % ordered.length;
    if (start > 0) tryOrder = [...ordered.slice(start), ...ordered.slice(0, start)];
  }

  for (const p of tryOrder) {
    log(`try ${p.id} for ${model} (anthropic)`);
    const out = await forward(p, '/messages', upstreamRequestHeaders(req.headers, p.apiKey, cfg.clientUA, true, cfg.clientProfile), outBody, res);
    if (out === true) {
      log(`served ${model} via ${p.id} (anthropic)`);
      logCall(`via=${p.id}`, 'ok');
      return;
    }
    // 审计修复（P1，本次）：确定性 4xx → 立即终止 failover，按映射后的状态码回复客户端
    //（Anthropic 错误体形状：{type:'error',error:{type,message}}；不回显上游原文）
    if (out && out.stop) {
      log(`failover stopped (${model} via ${p.id} HTTP ${out.stop.upstreamStatus} → ${out.stop.status}, anthropic)`);
      logCall(`via=${p.id}`, 'fail:' + out.stop.status);
      return json(res, out.stop.status, { type: 'error', error: {
        type: 'invalid_request_error',
        message: stopFailoverMessage(p.id, model, out.stop.upstreamStatus),
      } });
    }
    // R25（审计修复）：响应头已发出（流中途失败/客户端断开）→ failover 无意义
    if (res.headersSent || res.destroyed) {
      logCall('stream-broken', 'fail');
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
    providersForModel(cfg).map((p) => fetchCatalog(p, false, cfg.clientUA, cfg.clientProfile)),
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
  const server = http.createServer((req, res) => {
    // 审计修复（P2）：路由整体兜底。旧版 handler 是 async 但返回的 promise 被丢弃——
    // 任何未预期抛出（畸形 Host 让 new URL 抛错、提供应商条目非法等）只进
    // unhandledRejection 日志，**客户端永远收不到响应**（requestTimeout=0 无兜底）。
    routeRequest(cfg, req, res).catch((err) => {
      log(`request handler error: ${err && err.message ? err.message : err}`);
      try {
        if (!res.headersSent) json(res, 500, { error: { message: 'gateway internal error' } });
        else res.destroy();
      } catch { /* 忽略 */ }
    });
  });
  installShutdown(server);

  // R7 强壮性：SSE 流可能持续数十秒（sensenova 等上游慢时 30-60s），
  // 关闭 Node 默认的 requestTimeout(300s 内请求必须结束) 上限，避免长流被掐断导致 dsh 重连；
  // headersTimeout 保留 60s（防慢速头攻击）。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
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

  // R17（假死自愈）：进程内自检 watchdog——每 60s 自请求 /health；事件循环卡死或
  // server 假死（表现：无调用一段时间后无法连接，重启才恢复）时自检超时，连续 3 次
  // 失败即自杀退出（宿主 gateway-manager 的 exit 处理会自动重启，清空全部状态复活）。
  {
    let fails = 0;
    setInterval(() => {
      const req = http.get({ host: '127.0.0.1', port: cfg.port, path: '/health', timeout: 8000 }, (res) => {
        res.resume();
        fails = res.statusCode === 200 ? 0 : fails + 1;
        if (fails >= 3) {
          log(`self-watchdog: /health 返回 ${res.statusCode} 连续 ${fails} 次，进程自杀重启。`);
          process.exit(1);
        }
      });
      req.on('timeout', () => { req.destroy(); checkFail('timeout'); });
      req.on('error', () => checkFail('error'));
    }, 60_000);
    function checkFail() {
      fails += 1;
      if (fails >= 3) {
        log(`self-watchdog: /health 自检连续 ${fails} 次失败，进程自杀重启。`);
        process.exit(1);
      }
    }
  }
  return server;
}

/** 请求路由（独立函数：由 createServer 的 handler 兜底 catch，见 startServer） */
async function routeRequest(cfg, req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
      // `Host: [` 或畸形绝对形式 request-URI 会让 new URL 抛 ERR_INVALID_URL
      json(res, 400, { error: { message: 'bad request target' } });
      try { req.destroy(); } catch { /* 忽略 */ }
      return;
    }
    const p = url.pathname;
    if (p === '/health') { json(res, 200, { ok: true }); return; }

    if (p.startsWith('/v1/')) {
      const anthropicRoute = (p === '/v1/messages');
      if (!authorized(req, cfg)) {
        return anthropicRoute
          ? json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
          : json(res, 401, { error: { message: 'invalid or missing API key' } });
      }
      if (req.method === 'GET' && p === '/v1/models') return await handleModels(cfg, req, res);
      if (req.method === 'POST' && p === '/v1/messages') {
        // T5：Anthropic Messages 协议（Claude Code 等）
        try {
          const body = await bodyOf(req);
          return await handleMessages(cfg, req, res, body);
        } catch (e) {
          return replyBodyError(res, req, e, true);
        }
      }
      if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/responses')) {
        try {
          const body = await bodyOf(req);
          return await handleCompletion(cfg, req, res, body, p);
        } catch (e) {
          return replyBodyError(res, req, e, false);
        }
      }
      return json(res, 404, { error: { message: `unsupported route ${p}` } });
    }

    json(res, 404, { error: { message: 'not found' } });
}

// —— 进程级优雅关停（审计 P3）：宿主 taskkill /T /F 之前会先尝试正常终止；
// 这里停止接收新请求并让在途请求有机会收尾，避免 SSE 直接被硬杀截断。 ——
function installShutdown(server) {
  let closing = false;
  const bye = (sig) => {
    if (closing) return;
    closing = true;
    try { log(`received ${sig}, shutting down gracefully`); } catch { /* 忽略 */ }
    try { server.close(() => process.exit(0)); } catch { /* 忽略 */ }
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('SIGINT', () => bye('SIGINT'));
}

/* ---------------- write-dsh: register gateway into dsh host config ---------------- */
/**
 * 在 settings.yaml 中「按层级」upsert `llm-pi-ai.providers.gateway`（审计修复 P1-7）。
 *
 * 只动 llm-pi-ai → providers → gateway 这一条路径，绝不触碰文件里其它位置同名/同缩进的键。
 * 返回新文本（无改动时返回原文本）。
 */
function upsertGatewayInSettings(settings, block) {
  const lines = settings.split('\n');
  const at = (i) => lines[i].replace(/\r$/, '');
  // 1) 顶层 llm-pi-ai: 块范围（第 0 列的键，块到下一个第 0 列非空行为止）
  let pi = -1;
  let piEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^llm-pi-ai:\s*$/.test(at(i))) {
      pi = i;
      piEnd = i + 1;
      for (; piEnd < lines.length; piEnd++) {
        const l = at(piEnd);
        if (l.trim() !== '' && !/^\s/.test(l)) break;
      }
      break;
    }
  }
  if (pi < 0) {
    // 整个 llm-pi-ai 段都不存在 → 追加
    const suffix = settings.trimEnd().length > 0 ? '\n' : '';
    return settings + suffix + 'llm-pi-ai:\n  providers:\n' + block + '\n';
  }
  // 2) 块内的 `  providers:`（缩进 2）
  let pIdx = -1;
  for (let i = pi + 1; i < piEnd; i++) {
    if (/^ {2}providers:\s*$/.test(at(i))) { pIdx = i; break; }
  }
  if (pIdx < 0) {
    lines.splice(piEnd, 0, '  providers:', ...block.split('\n'));
    return lines.join('\n');
  }
  // 3) providers 子块范围（缩进 > 2 的行）
  let pEnd = pIdx + 1;
  for (; pEnd < piEnd; pEnd++) {
    const l = at(pEnd);
    if (l.trim() === '') continue;
    if (/^ {0,2}\S/.test(l)) break;
  }
  // 4) 子块内的 `    gateway:`（缩进 4）
  let g = -1;
  let gEnd = -1;
  for (let i = pIdx + 1; i < pEnd; i++) {
    if (/^ {4}gateway:\s*$/.test(at(i))) {
      g = i;
      gEnd = i + 1;
      for (; gEnd < pEnd; gEnd++) {
        const l = at(gEnd);
        if (l.trim() === '') continue;
        if (/^ {0,4}\S/.test(l)) break;      // 缩进 ≤4 → 该 provider 条目结束
      }
      while (gEnd > g + 1 && at(gEnd - 1).trim() === '') gEnd--;   // 尾部空行留在块外
      break;
    }
  }
  const blockLines = block.split('\n');
  if (g >= 0) {
    if (lines.slice(g, gEnd).join('\n') === blockLines.join('\n')) return settings;   // 内容一致 → 不动
    lines.splice(g, gEnd - g, ...blockLines);
  } else {
    let ins = pEnd;
    while (ins > pIdx + 1 && at(ins - 1).trim() === '') ins--;
    lines.splice(ins, 0, ...blockLines);
  }
  return lines.join('\n');
}

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
  if (!fs.existsSync(cfgPath)) {
    console.error(`[write-dsh] gateway config not found: ${cfgPath}`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // R25（审计修复）：端口优先级 --port > cfg.port > 3091——旧版硬编码 3091，
  // 该文件随应用原样分发，直跑不传 --port 且配置为其他端口（如桌面助手 3090）时写错 baseURL
  const port = Number(get('--port') || cfg.port || 3091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[write-dsh] invalid port: ${get('--port') || cfg.port}`);
    process.exit(1);
  }
  const key = get('--key') || '';

  const apiKey = key || cfg.apiKey || '';
  if (!apiKey || apiKey === 'dsh-gateway-change-me') {
    console.error('[write-dsh] unified apiKey is not set (edit gateway.config.json first)');
    process.exit(1);
  }
  // R11：协议与仿真一致——clientProfile=claude → Anthropic 协议（与 Claude Code 同形态，
  // 经实测可避开 new-api 对 OpenAI 超长请求的内容拦截）；codex/缺省 → OpenAI 协议。
  // 写入 dsh 的 api 字段必须与网关服务路径一致：
  //   anthropic-messages → dsh 调 /v1/messages（网关 T5 转发 /messages + x-api-key）
  //   openai-completions → dsh 调 /v1/chat/completions（Bearer）
  // R12：baseURL 惯例按协议——anthropic-messages 的 SDK 期望 baseURL 不含 /v1
  // （SDK 自拼 /v1/messages；否则会出现 /v1/v1/messages 双前缀 404）。
  const clientProfile = String(cfg.clientProfile || '').trim();
  const wireApi = clientProfile === 'claude' ? 'anthropic-messages' : 'openai-completions';
  const baseURL = wireApi === 'anthropic-messages'
    ? `http://127.0.0.1:${port}`
    : `http://127.0.0.1:${port}/v1`;
  console.log(`[write-dsh] clientProfile="${clientProfile}" → api=${wireApi} baseURL=${baseURL}`);

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

  // R12：模型条目统一声明 reasoningEfforts（否则 pi-ai 回退已安装目录能力——
  // glm-5.3 等无 max 档会报 "does not support reasoning effort max"）。
  // off=null（不发字段）、其余档位 wire 值同档名；声明后选择器提供全部档位。
  const modelLines = models
    .map((m) => `        - id: ${yamlQuote(m)}\n          name: ${yamlQuote(m)}\n          contextWindow: 1024000\n          reasoningEfforts:\n            off: null\n            low: low\n            medium: medium\n            high: high\n            max: max`)
    .join('\n');
  const block =
`    gateway:
      displayName: DSH Model Gateway
      apiKeyEnv: DSH_GATEWAY_API_KEY
      api: ${wireApi}
      baseURL: ${baseURL}
      models:
${modelLines}`;

  // settings.yaml: insert/replace the gateway provider under llm-pi-ai.providers
  // 审计修复（P1-7）：旧实现用两条**全局**正则（`/\n    gateway:…/s` 与 `/\n  providers:…/s`）
  // 定位——文件里任何位置出现 4 空格缩进的 `gateway:`（例如某个 MCP server 就叫 gateway）
  // 都会被整段替换掉；`providers:` 后面跟同级键时还会把网关块插进那个键内部（层级错误，
  // dsh 看不到）。现在改为**逐行、按层级定位**：先找顶层 `llm-pi-ai:` 块，再在其内找
  // `  providers:`，再在其内找 `    gateway:`。写前留一份首次备份。
  let settings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
  const before = settings;
  settings = upsertGatewayInSettings(settings, block);
  if (settings === before) console.log('[write-dsh] settings.yaml: no change needed');
  else {
    try {
      const bak = settingsPath + '.bak-gateway';
      if (!fs.existsSync(bak)) fs.copyFileSync(settingsPath, bak);
    } catch { /* 备份失败不阻断 */ }
    fs.writeFileSync(settingsPath, settings, 'utf8');
    console.log('[write-dsh] settings.yaml: llm-pi-ai.providers.gateway upserted');
  }

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
  try { fs.appendFileSync(LOG_PATH, `[${localStamp()}] exit code=${code}\n`); } catch { }
});

if (process.argv.includes('--write-dsh')) {
  writeDshConfig(process.argv.slice(2));
} else {
  // 服务启动：--config / --log 可覆盖默认的 %APPDATA%\DSHDesktop 路径，
  // 使 dsh-app/桌面助手能把配置与日志指向自己的数据目录（否则误读/写旧位置）
  const cfgFromArg = argvGet('--config');
  if (cfgFromArg) CONFIG_PATH = cfgFromArg;
  const logFromArg = argvGet('--log');
  if (logFromArg) LOG_PATH = logFromArg;
  const cfg = loadConfig();
  if (cfg) startServer(cfg);
}

// 来源：dsh-desktop-github/gateway/model-gateway.mjs（DSH 桌面助手模型网关，随本应用原样分发）
