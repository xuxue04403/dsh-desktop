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

async function fetchCatalog(provider, force, clientUA, clientProfile) {
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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    // Q1：catalog 探测同样走上游请求头构造（clientUA/clientProfile 配置时完全仿真，
    // 否则 new-api 客户端白名单会拦 catalog 导致模型列表为空）
    const headers = upstreamRequestHeaders({}, provider.apiKey, clientUA, false, clientProfile);
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

/** Forward to one provider; returns true when the response was written. */
async function forward(provider, upstreamPath, upstreamHeaders, body, res) {
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
      try { firstDetail = (await upstream.text()).slice(0, 500); } catch { }
      if (/sensitive\s*words|content[-_]blocked|content_blocked/i.test(firstDetail)) {
        const deBody = desensitizeBodyMessages(outBody);
        if (deBody !== outBody) {
          log(`upstream ${provider.id} 内容拦截，已降敏重试一次…`);
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), UPSTREAM_TIMEOUT_MS);
          upstream = await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, {
            method: 'POST',
            headers: upstreamHeaders,
            body: JSON.stringify(deBody),
            signal: c2.signal,
          });
          clearTimeout(t2);
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
      try { detail = (await upstream.text()).slice(0, 500); } catch { }
    }
    log(`upstream ${provider.id} HTTP ${upstream.status}: ${maskSecrets(detail)}`);   // V1：日志脱敏
    // R8：上游内容拦截/异常时，把触发请求的"结构摘要"落盘（不含明文 key，内容截 60 字符），
    // 用于定位是什么特征触发了上游过滤（sensitive words / content-blocked）。
    if (/sensitive\s*words|content[-_]blocked|content_blocked/i.test(detail)) {
      try {
        const dir = path.join(path.dirname(LOG_PATH), 'dump');
        fs.mkdirSync(dir, { recursive: true });
        const digest = {
          at: localStamp(), provider: provider.id, status: upstream.status,
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
                while ((mm = re.exec(t)) && cnt < 8) { hits.push({ len: mm[0].length, head: mm[0].slice(0, 20) + '…' }); cnt++; }
                return hits;
              }).slice(0, 20)
            : [],
        };
        const f = path.join(dir, `blocked-${Date.now()}-${provider.id}.json`);
        fs.writeFileSync(f, JSON.stringify(digest, null, 2), 'utf8');
        log(`[dump] 被拦请求摘要 -> ${f}`);
      } catch (_) { /* dump 失败不影响服务 */ }
    }
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
    try {
      while (true) {
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
      try { reader.releaseLock(); } catch { }
    }
  }
  try {
    res.end();
  } catch { }
  return true;
}

// 诊断 dump（R8）：env DSH_GATEWAY_DUMP_BODY=<dir> 时，把每个 chat/messages 请求的
// 结构摘要落盘（不存明文 key；内容只截前 60 字符），用于定位上游敏感词拦截的触发特征。
// env DSH_GATEWAY_DUMP_FULL=1 时额外把完整请求体落盘（脱敏 key），用于取证真实请求。
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
      msg0Sample: (body && body.messages && body.messages[0] && typeof body.messages[0].content === 'string') ? body.messages[0].content.slice(0, 80) : undefined,
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

  // 1) availability pre-filter: prefer providers whose catalog advertises the model
  //    (cached; fallback to trying in priority order when catalog unknown)
  //    并行探测各供应商目录，避免串行等待放大首请求延迟（E3）
  const withCatalog = [];
  const unknown = [];
  const catalogResults = await Promise.all(candidates.map((p) => fetchCatalog(p, false, cfg.clientUA, cfg.clientProfile)));
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
    // 透传 dsh 原始请求标识（K1 防屏蔽）/ 仿真模式（V2: clientProfile）：clientHeaders = req.headers
    const ok = await forward(p, upstreamPath.replace(/^\/v1/, ''), passthroughHeaders(req.headers, p.apiKey, cfg.clientUA, cfg.clientProfile), body, res);
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

  const withCatalog = [];
  const unknown = [];
  const catalogResults = await Promise.all(candidates.map((p) => fetchCatalog(p, false, cfg.clientUA, cfg.clientProfile)));
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
    const ok = await forward(p, '/messages', upstreamRequestHeaders(req.headers, p.apiKey, cfg.clientUA, true, cfg.clientProfile), outBody, res);
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
