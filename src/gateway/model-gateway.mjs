#!/usr/bin/env node
/**
 * DSH Model Gateway
 * OpenAI-compatible unified model proxy with multi-provider routing.
 *
 * Features:
 *  - GET  /v1/models            merged, de-duplicated model list from all providers (sorted by name)
 *  - POST /v1/chat/completions  route by model availability -> provider list order -> failover
 *  - POST /v1/messages          Anthropic protocol (same routing)
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
 *         // 字符串 = 上游 ID 与逻辑名相同；对象 = 映射（as 为逻辑名）+ 可选 vision（图片输入）
 *         "models": ["deepseek-v4-flash", { "id": "v/vision-up", "as": "deepseek-v4-flash", "vision": true }],
 *         "priority": 1,          // 数值小者先尝试；同 priority 内按本数组顺序
 *         "enabled": true
 *       }
 *     ]
 *   }
 *
 * 选路顺序（2026-09-17 用户要求）：**先 priority 升序，同级内按 providers 数组顺序**。
 * 配置页 ▲▼ 仍然只改数组顺序、不改 priority（同级内调整先后）。
 * Config path: %APPDATA%\DSHDesktop\gateway.config.json (or DSH_GATEWAY_CONFIG).
 * A template is created on first run if the file is missing.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const APP_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.dsh'), 'DSHDesktop');
let CONFIG_PATH = process.env.DSH_GATEWAY_CONFIG || path.join(APP_DIR, 'gateway.config.json');
const MODEL_CACHE_TTL_MS = 60_000;
// 上游请求超时（time-to-headers）。可用 DSH_GATEWAY_UPSTREAM_TIMEOUT_MS 覆盖，
// 或按供应商用配置项 timeoutMs 单独放宽（如 x666/amd 这类慢速中转）。
const UPSTREAM_TIMEOUT_MS = (() => {
  const n = Number(process.env.DSH_GATEWAY_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
/** 供应商级超时：provider.timeoutMs > 全局默认；**半开探测**用短超时（见 BREAKER_PROBE_TIMEOUT_MS）。 */
function providerTimeoutMs(provider) {
  const n = Number(provider && provider.timeoutMs);
  const base = Number.isFinite(n) && n > 0 ? n : UPSTREAM_TIMEOUT_MS;
  // 2026-09-17 优化：半开探测不放满 60s——该请求同时在替所有人生死探测，不能让用户等满。
  try {
    const b = breaker.get(String((provider && provider.id) || ''));
    if (b && b.state === 'half-open') return Math.min(base, BREAKER_PROBE_TIMEOUT_MS);
  } catch (_) { /* 模块初始化早期（const 尚未就绪）→ 退回常规超时 */ }
  return base;
}
// 瞬时网络错重试（2026-09-16）：仅当失败**够快**时才重试——慢失败（如 60s 超时）重试只会翻倍等待
const NET_RETRY_MAX_ELAPSED_MS = (() => {
  const n = Number(process.env.DSH_GATEWAY_NET_RETRY_MAX_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * 把 fetch 的异常链压成一行可读文本（undici 的网络错误 message 恒为 "fetch failed"，
 * 真正原因在 cause 链里：ECONNRESET / ENOTFOUND / UND_ERR_SOCKET / 代理连接失败…）。
 */
function describeFetchError(e) {
  if (!e) return '';
  const parts = [];
  let cur = e.cause;
  let depth = 0;
  while (cur && depth < 3) {
    const t = cur.code || cur.errno || cur.message || String(cur);
    if (t) parts.push(String(t));
    cur = cur.cause;
    depth++;
  }
  return [...new Set(parts)].join(' < ');
}

/**
 * 是否"瞬时网络层错误"（值得原地重试一次）。
 * 排除我们自己的超时中止（AbortError）：那类失败重试只会把等待翻倍。
 */
function isTransientNetError(e) {
  if (!e) return false;
  const msg = String(e.message || '');
  if (e.name === 'AbortError' || /aborted/i.test(msg)) return false;
  if (/fetch failed|socket|network|ECONN|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(msg)) return true;
  let cur = e.cause;
  let depth = 0;
  while (cur && depth < 4) {
    const code = String(cur.code || cur.errno || '');
    if (TRANSIENT_NET_CODES.has(code)) return true;
    cur = cur.cause;
    depth++;
  }
  return false;
}

/**
 * 本进程的代理状态（v1.8.2）：宿主 gateway-manager 会注入 NODE_USE_ENV_PROXY=1 +
 * HTTP(S)_PROXY + NO_PROXY；这里只做**可见性**，便于 /health 与日志一眼看清
 * "到底走没走代理、哪些域名直连"。排障时不必再去翻宿主的 app.log。
 */
function proxyStatus() {
  const env = process.env;
  const url = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  const noProxy = env.NO_PROXY || env.no_proxy || '';
  return { url: url || null, noProxy: noProxy || null, envProxy: env.NODE_USE_ENV_PROXY === '1' };
}

/** host 是否命中 NO_PROXY 清单（精确或后缀——实测 `tencent.com` 命中 copilot.tencent.com）。 */
function hostInNoProxy(host, noProxy) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  for (const raw of String(noProxy || '').split(',')) {
    const e = raw.trim().toLowerCase().replace(/^\./, '').replace(/^\*\./, '');
    if (!e) continue;
    if (h === e || h.endsWith('.' + e)) return true;
  }
  return false;
}

/**
 * 网络错误归因（v1.8.2）。2026-09-16 19:19–19:23 事故：clash 的 7890 端口没在监听，
 * 网关所有上游请求（含 workbuddy）在 12–31ms 内 ECONNREFUSED——undici 报的是**代理地址**
 * 连不上，可日志里只有 "fetch failed"，于是熔断器写"保护上游账号"，把环境问题记成上游故障。
 * 这里在"本进程走代理且该域名不在 NO_PROXY"时补一句人话，直接指向代理。
 */
function proxyHintFor(url, causeText) {
  // 只在**确实拿到连接层错误码**时才提示代理（ENOTFOUND/证书类错误与代理无关，别误导）。
  // 2026-09-17 修正：旧判断写成"causeText 存在才校验"→ causeText 为空时无条件放行，而
  // AbortError（我方 60s 超时 / 客户端取消）的 cause 链恰好为空 → 把"超时"误报成"代理未运行"
  // （当天实测 6 次，误导排查方向）。现在必须非空且命中连接层错误码。
  if (!causeText || !/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT/i.test(String(causeText))) return '';
  const st = proxyStatus();
  if (!st.url) return '';
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { return ''; }
  if (hostInNoProxy(host, st.noProxy)) return '';
  return `（本进程走代理 ${st.url}：ECONNREFUSED/ECONNRESET 极可能是**代理未运行**（Clash 退出/切换节点/重启中），不是上游故障；请检查代理，或在网关配置里把该域名加入 noProxy 直连）`;
}
// R2 防封：catalog 探测失败后的冷却期（30s 内不重试探测，防请求风暴触发风控）
const CATALOG_FAIL_COOLDOWN_MS = 30_000;
let LOG_PATH = process.env.DSH_GATEWAY_LOG || path.join(APP_DIR, 'logs', 'gateway.log');

/* ---------------- logging ---------------- */
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 日志轮转上限 5MB（修复 G3：防止长期运行磁盘膨胀）

/* 日志时间口径（时区可移植性修复，2026-09-11）：
 * 旧版 localStamp 用 getHours() 等**系统时区**字段；把绿色目录复制到一台时区为 UTC 的
 * 电脑（镜像/克隆的 Windows 很常见）后，网关日志比北京时间早 8 小时，与宿主 app.log 的
 * 口径也可能不一致，排查时序会误导。现在缺省固定北京时区（UTC+8），与机器设置无关；
 * DSH_LOG_TZ 可覆盖：local|system（跟随系统）或 ±HH:MM。
 * 注：网关是零依赖单文件（会被解包到 data\gateway\ 单独运行），故这里内联同一套逻辑
 *（与 src/timestamp.js 语义一致，改动时两边必须同步）。 */
function logTzOffsetMin() {
  const v = String(process.env.DSH_LOG_TZ || '').trim().toLowerCase();
  if (v === 'local' || v === 'system') return null;
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(v);
  if (m) { const mins = Number(m[2]) * 60 + Number(m[3] || 0); return m[1] === '-' ? -mins : mins; }
  return 480;   // 缺省：北京时间
}
const LOG_TZ_MIN = logTzOffsetMin();

// 时间戳：YYYY-MM-DD HH:mm:ss.SSS（口径见上）
function localStamp(d) {
  const t = d || new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  const x = LOG_TZ_MIN === null ? t : new Date(t.getTime() + LOG_TZ_MIN * 60000);
  const Y = LOG_TZ_MIN === null ? x.getFullYear() : x.getUTCFullYear();
  const Mo = (LOG_TZ_MIN === null ? x.getMonth() : x.getUTCMonth()) + 1;
  const D = LOG_TZ_MIN === null ? x.getDate() : x.getUTCDate();
  const H = LOG_TZ_MIN === null ? x.getHours() : x.getUTCHours();
  const Mi = LOG_TZ_MIN === null ? x.getMinutes() : x.getUTCMinutes();
  const S = LOG_TZ_MIN === null ? x.getSeconds() : x.getUTCSeconds();
  const Ms = LOG_TZ_MIN === null ? x.getMilliseconds() : x.getUTCMilliseconds();
  return Y + '-' + p(Mo, 2) + '-' + p(D, 2) + ' ' + p(H, 2) + ':' + p(Mi, 2) + ':' + p(S, 2) + '.' + p(Ms, 3);
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

/* ---------------- OpenAI Responses 协议：会话/资源亲和性 ----------------
 * Responses 协议是**有状态**的：客户端拿到 response.id 后会用
 *   GET    /v1/responses/{id}
 *   DELETE /v1/responses/{id}
 *   POST   /v1/responses/{id}/cancel
 *   GET    /v1/responses/{id}/input_items
 * 以及 POST /v1/responses 带 previous_response_id 继续多轮。
 * 这些后续请求的 body 里**没有 model**（子路由连 body 都没有），无法按模型路由；
 * 而 response 对象只存在于**创建它的那家上游**——发错家必然 404。
 * 因此：创建成功后记下 id → providerId，后续请求优先回到原供应商；
 * 同时 previous_response_id 也用于把多轮对话钉在同一家（缓存命中/上下文一致）。
 * 容量有界（LRU 淘汰），避免客户端可控 id 造成无界增长。
 */
const RESPONSE_AFFINITY_MAX = 512;
const responseAffinity = new Map();   // responseId -> providerId

function affinitySet(id, providerId) {
  if (!id || !providerId) return;
  if (responseAffinity.has(id)) responseAffinity.delete(id);   // 重插 = 最近使用
  responseAffinity.set(id, providerId);
  while (responseAffinity.size > RESPONSE_AFFINITY_MAX) {
    const oldest = responseAffinity.keys().next();
    if (oldest.done) break;
    responseAffinity.delete(oldest.value);
  }
}

function affinityGet(id) {
  if (!id) return null;
  const pid = responseAffinity.get(id);
  if (!pid) return null;
  responseAffinity.delete(id);   // LRU 触碰
  responseAffinity.set(id, pid);
  return pid;
}

/** 从响应字节（JSON 或 SSE）里嗅探 Responses 的 response.id。
 * 三种形态，按可信度取：
 *   ① `"id":"resp_…"`（官方/new-api 惯例前缀，最可靠）
 *   ② SSE 的 `event: response.created` → `"response":{"id":"…"`（前缀不规范也认）
 *   ③ JSON 体里 `"id":"…","object":"response"`（明确声明 object 才认）
 * 只认这三类，避免把 output item 的 msg_/item/函数调用 id 误当成 response id。取不到返回 null。 */
const RESP_ID_RE = /"id"\s*:\s*"(resp[_-][A-Za-z0-9_-]{3,})"/;
const RESP_NESTED_ID_RE = /"response"\s*:\s*\{\s*"id"\s*:\s*"([A-Za-z0-9_.:-]{4,})"/;
const RESP_OBJECT_ID_RE = /"id"\s*:\s*"([A-Za-z0-9_.:-]{4,})"\s*,\s*"object"\s*:\s*"response"/;
function sniffResponseId(text) {
  if (!text || typeof text !== 'string') return null;
  const direct = RESP_ID_RE.exec(text);
  if (direct) return direct[1];
  const nested = RESP_NESTED_ID_RE.exec(text);
  if (nested) return nested[1];
  const obj = RESP_OBJECT_ID_RE.exec(text);
  return obj ? obj[1] : null;
}

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
// 2026-09-17 优化（实测事故：坏家长期霸占候选首位）：
//  ① 短熔断按"连续开闸次数"指数退避 90s→3m→6m→12m→24m→30m（封顶 30 分钟）。
//     旧实现固定 90 秒：windhub 当天被放了 28 次探测、x666 12 次，每次都在用户请求路径上白等。
//  ② 半开探测用**短超时**（默认 10 秒，而不是 60 秒）：冷却到点后的那一次请求是在替全家人
//     试错，不该占满用户 60 秒（实测 14:35:05 探 x666 → 14:36:05 放弃 = 正好 60s → 再转
//     agentrouter 18s → 该请求 78.5s；同模型正常只要 14–26s）。
const BREAKER_BACKOFF_MAX_MS = envMs('DSH_GATEWAY_BREAKER_BACKOFF_MAX_MS', 30 * 60_000);
const BREAKER_PROBE_TIMEOUT_MS = envMs('DSH_GATEWAY_BREAKER_PROBE_TIMEOUT_MS', 10_000);

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
const breaker = new Map();                      // providerId -> { state, fails, openUntil, opens }

/**
 * 空名 tool_use 告警计数器（2026-09-17）：见 anthropicToOpenAIRequest 里的去重日志。
 */
let emptyToolUseDropHits = 0;

/**
 * thinking 回传需求"学习"标记（2026-09-17 优化）。某些上游（实测 agentrouter/air-outer）对
 * "带 tool_use 但缺 thinking 块"的 assistant 轮回 400/500，网关补一次空占位即可通过。旧实现
 * **每次请求都要先失败一次**才知道（当天实测 13 次白打上游；失败调用上游通常照样计费）。
 * 现在记住"该家需要补位"，后续请求首次就带上。命中即记、成功不撤销（结构需求是稳定属性）。
 */
const thinkingPassbackProviders = new Set();

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
  const b = breaker.get(providerId) || { state: 'closed', fails: 0, openUntil: 0, opens: 0 };
  b.fails += 1;
  // V2b：401/403 业务性拒绝（鉴权失败/需充值/禁用）不会自愈——首次出现即长熔断 30 分钟，
  // 不必等连续 3 次（避免固定失败模式被风控画像）；网络错/5xx 仍按 3 次阈值短熔断
  const immediate = (httpStatus === 401 || httpStatus === 403);
  // half-open 探测失败必须回到 open（否则名额永远被占 → 熔断卡死），故不看阈值
  if (b.fails >= BREAKER_THRESHOLD || immediate || b.state === 'half-open') {
    const long = immediate;
    // 2026-09-17：网络/5xx 类短熔断按连续开闸次数指数退避（成功后 breakerRecordSuccess 清零 opens）
    b.opens = (b.opens || 0) + 1;
    const base = long ? BREAKER_LONG_MS : BREAKER_SHORT_MS;
    const ms = long ? base : Math.min(base * 2 ** (b.opens - 1), BREAKER_BACKOFF_MAX_MS);
    b.state = 'open';
    b.openUntil = Date.now() + ms;
    log(`breaker OPEN: ${providerId} 失败（${httpStatus || 'network'}），熔断 ${
      ms >= 60_000 ? Math.round(ms / 60_000) + ' 分钟' : ms + 'ms'}`
      + `${long ? '' : `（第 ${b.opens} 次开闸，退避递增；上限 ${Math.round(BREAKER_BACKOFF_MAX_MS / 60_000)} 分钟）`}（保护上游账号）`);
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

/**
 * 半开探测的代价控制（2026-09-17 评估结论，注意这里**没有**把探测挪到候选末尾）：
 * 曾实现过"待探测的家排到最后"，但那样只要备选一直可用，**首选家恢复后也不会再被用到**——
 * 等于静默改变优先级语义（用户把 x666 放第一是有意的）。因此只做两件事：
 *   ① 探测超时单独设短（BREAKER_PROBE_TIMEOUT_MS，默认 10s，而不是 60s）；
 *   ② 网络类熔断按连续开闸次数指数退避（90s→3m→6m→12m→24m→30m）。
 * 合起来：用户最多为探测多等 10 秒，且第 5 次之后基本每 30 分钟才会撞上一次。
 *（若要进一步做到"零用户代价"，需要后台恢复探测 + 只缩短冷却不直接解除熔断，属后续可选优化。）
 */


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
    // 目录 × 配置声明 一致性提示（2026-09-15 实测事故：chiyi-ds 目录里只有 Claude 模型，
    // 却声明了 deepseek-v4.1-flash → 每次请求都被上游拒（503/400），而配置页看不出问题）。
    // 只记日志、不作拦截依据（上游目录常滞后/不完整，声明仍以配置为准）。
    try {
      const entries = modelEntries(provider);
      const declared = logicalModelNames(provider);
      if (entries.length && declared.length) {
        const missing = declared.filter((as) => {
          const ups = entries.filter((e) => e.as === as).map((e) => e.up);
          return !ids.has(as) && !ups.some((u) => ids.has(u));   // 逻辑名或其上游 ID 都不在目录里
        });
        if (missing.length) {
          log(`[提示] ${provider.id} 的上游目录里没有这些已声明模型：${missing.join(', ')}`
            + '（目录可能滞后；若请求持续被上游拒绝，请核对该模型 ID 是否为其真实 ID）');
        }
      }
    } catch { /* 提示失败不影响探测 */ }
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

/**
 * 候选顺序（2026-09-17 用户要求，**规则变更**）：
 *   ① 先按 `priority` **升序**（数值小者先尝试）；缺省 / 非法 / ≤0 → 视为 1
 *   ② 同一 priority 内按 **providers 数组顺序**（= 配置页列表顺序；▲▼ 调整的就是它）
 *
 * 历史（避免以后又被"改回去"时不知道为什么）：
 *   · 2026-09-16 之前：按 priority 排序，但配置页 ▲▼ 为保持"界面顺序=实际选路"会把 priority
 *     重编号成 1…N —— 静默改写用户手写的优先级。用户当时要求"移动只改先后顺序、不要动优先级"，
 *     于是当天改成"完全不看 priority，纯数组顺序"。
 *   · 2026-09-17：用户明确要求"同一模型下先看供应商优先级，相同优先级再看排序"，即本实现。
 *     两者现在并存：▲▼ 只改数组顺序（**不触碰 priority**），而 priority 重新参与排序 ——
 *     因此**列表位置只决定同一优先级内的先后**。
 *
 * 注意：层级（tier）仍优先于 priority —— selectCandidates() 会把"配置里声明承载该模型"的家
 * 排在"一个模型都没配、只能靠上游目录兜底"的家之前。那是配置权威性规则（2026-09-15 事故），
 * 不是排序偏好；本函数只负责同一层级内的顺序。
 */
function providersForModel(cfg) {
  const list = cfg.providers.filter((p) => p.enabled !== false);
  // 稳定排序：同 priority 用原始下标兜底（不依赖引擎的排序稳定性）
  return list
    .map((p, i) => ({ p, i, pri: providerPriority(p) }))
    .sort((a, b) => (a.pri - b.pri) || (a.i - b.i))
    .map((x) => x.p);
}

/** priority 归一化：缺省 / 非数字 / ≤0 → 1（与历史默认一致，避免旧配置被排到末尾） */
function providerPriority(provider) {
  const n = Number(provider && provider.priority);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/* ---------------- 模型映射（上游真实 ID ↔ 逻辑模型名） ----------------
 * 背景（2026-09-11）：同一个逻辑模型在不同供应商的上游 ID 往往不同
 *（如 `deepseek-ai/deepseek-v4-flash` 与 `deepseek-v4-flash0731` 都是 deepseek-v4-flash）。
 * 旧配置只能写一串 ID，于是同一个模型被当成两个不同模型，按逻辑名路由就匹配不上。
 *
 * provider.models 每项支持两种形态（**向后兼容**）：
 *   "glm-5.3"                                    —— 字符串：上游 ID 与逻辑名相同
 *   { id: "deepseek-ai/deepseek-v4-flash",       —— 对象：id = 上游真实 ID（发给上游用）
 *     as: "deepseek-v4-flash" }                     as = 逻辑模型名（dsh 请求用；网关按它路由）
 * 同义字段：as / alias / model / name 任一都当逻辑名（手写配置容错）；as 缺省 = id。
 * 同一 provider 允许多条 as 相同的映射（该逻辑模型在该家有多个上游 ID 变体，取第一条命中）。
 */
function modelEntries(provider) {
  const out = [];
  const list = provider && Array.isArray(provider.models) ? provider.models : [];
  for (const m of list) {
    if (typeof m === 'string') {
      const s = m.trim();
      if (s) out.push({ up: s, as: s });
      continue;
    }
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      // 上游真实 ID：id（规范写法），同义键 up / upstream；都没有时兜底取 model
      //（配置页对 `{model,as}` 这种手写形态也这么读，两侧语义必须一致）
      const up = String(m.id ?? m.up ?? m.upstream ?? m.model ?? '').trim();
      if (!up) continue;
      const as = String(m.as ?? m.alias ?? m.model ?? m.name ?? up).trim();
      // 多模态声明（2026-09-16）：vision: true 或 input: ['text','image'] 都表示该条支持图片输入。
      // 只会影响两件事：① 写进 dsh settings.yaml 的 input 字段（否则 harness 直接拦下图片：
      // "当前模型不支持图片"）；② 带图片的请求只发给声明了图片的家。
      // 只在为真时附带该字段——保持条目 JSON 形状稳定（既有调用方/测试按 {up, as} 比对）。
      const vision = m.vision === true
        || (Array.isArray(m.input) && m.input.map((x) => String(x).toLowerCase()).includes('image'));
      const entry = { up, as: as || up };
      if (vision) entry.vision = true;
      // 上下文/输出上限（可选）：write-dsh 用它给 dsh 写准确的 contextWindow/maxTokens，
      // 避免"全部按 1M 虚报"导致长对话在上游上下文超限。
      const ctxWin = Number(m.contextWindow ?? m.context ?? m.ctx);
      const maxTok = Number(m.maxTokens ?? m.maxOutputTokens ?? m.max_output_tokens);
      if (Number.isFinite(ctxWin) && ctxWin > 0) entry.contextWindow = ctxWin;
      if (Number.isFinite(maxTok) && maxTok > 0) entry.maxTokens = maxTok;
      out.push(entry);
    }
  }
  return out;
}

/** 逻辑模型名 → 该 provider 的上游真实 ID（未声明该逻辑名 → null，表示原样透传请求里的 model） */
function upstreamIdFor(provider, logical) {
  const hit = modelEntries(provider).find((e) => e.as === logical);
  return hit ? hit.up : null;
}

/** 该 provider 声明的逻辑模型名（去重，保序） */
function logicalModelNames(provider) {
  const seen = new Set();
  const out = [];
  for (const e of modelEntries(provider)) {
    if (!seen.has(e.as)) { seen.add(e.as); out.push(e.as); }
  }
  return out;
}

/** 把一个逻辑模型名换成该 provider 的上游 ID（无需替换时原样返回传入对象） */
function bodyForProvider(body, provider, logical) {
  const up = upstreamIdFor(provider, logical);
  if (!up || up === logical) return body;
  return Object.assign({}, body, { model: up });
}

/* ---------------- 候选收敛：**以配置的模型列表为唯一权威** ----------------
 * 用户明确要求（2026-09-15）：*"不应该以目录命中（上游 /models 里有）为准，而应该以我配置的
 * 模型列表为准"*。因此规则简化为：
 *
 *   ① **配置声明了该逻辑名**（provider.models 里某条的 as / 字符串本身等于请求名）
 *        → 第一层候选（唯一可信的归属声明；轮询/优先级都只在这一层内进行）
 *   ② 该 provider **一个模型都没配**（models 缺失/空数组）
 *        → 第二层候选：没有可遵循的配置，只能按它的上游目录兜底（历史行为，保证"没配也不误杀"）
 *        · 目录里有该模型 → 候选（reason: no-models-declared,catalog-hit）
 *        · 目录探测失败/未知 → 也候选（无法判断，保持宽容）
 *        · 目录已知且没有 → 不是候选
 *   ③ 该 provider **配了别的模型但没配这个** → **不是候选**（即使上游目录里有！）
 *        这正是 2026-09-15 的事故形态：b.ai 目录里列着 deepseek-v4.1-flash，配置却只声明了
 *        mimo/glm-flash/qwen，转发过去上游回 400（欠费/不可用）→ 用户明明配了 chiyi-ds 承载它，
 *        却被"目录里有"的那家抢走。配置是用户意图的唯一来源，目录只用来兜底未配置的服务商。
 *
 * 顺序：本函数**不重排**，按传入 candidates 的既有顺序分层收集 —— 而 candidates 已由
 * providersForModel() 按"priority 升序、同级数组顺序"排好，因此每个层级内部都保持该顺序。
 * 最终 eligible = [配置声明的家（按 priority/数组序）] ++ [目录兜底的家（同序）]。
 *（层级优先于 priority：配置声明的家永远排在"只能靠目录兜底"的家前面。）
 *
 * 另：本函数同时返回 needCatalogFor（哪些 provider 需要查目录）——调用方据此**只为"没配模型"
 * 的 provider 探测目录**，配置齐全时请求路径上不再有任何目录探测（省掉每次请求 ~1.5s）。
 * 返回 { eligible, reasons, tierSizes }
 */
function selectCandidates(candidates, catalogResults, model) {
  const declaredTier = [];
  const fallbackTier = [];
  const reasons = [];
  candidates.forEach((p, i) => {
    const set = catalogResults ? catalogResults[i] : null;
    const entries = modelEntries(p);
    const declared = entries.filter((e) => e.as === model);   // 声明承载该逻辑名的条目（可能多条）
    if (declared.length) {
      declaredTier.push(p);
      reasons.push({ id: p.id, reason: 'models-declared' });
      return;
    }
    if (entries.length > 0) {
      // 配置了模型但没这个 → 配置权威：不是候选（无论上游目录里有没有）
      reasons.push({ id: p.id, reason: 'not-declared(config-authoritative)' });
      return;
    }
    // 一个模型都没配 → 目录兜底
    const catalogKnown = set !== null && set !== undefined;
    if (!catalogKnown) { fallbackTier.push(p); reasons.push({ id: p.id, reason: 'no-models-declared,catalog-unknown' }); return; }
    if (set.has(model)) { fallbackTier.push(p); reasons.push({ id: p.id, reason: 'no-models-declared,catalog-hit' }); return; }
    reasons.push({ id: p.id, reason: 'no-models-declared,catalog-miss' });
  });
  return { eligible: [...declaredTier, ...fallbackTier], reasons, tierSizes: [declaredTier.length, fallbackTier.length] };
}

/** 该 provider 是否需要查上游目录才能判定候选（= 它一个模型都没配） */
function needsCatalog(provider) {
  return modelEntries(provider).length === 0;
}

/* ---------------- 多模态（图片输入）支持判定 ----------------
 * 背景（2026-09-16 用户反馈）：第三方 deepseek-v4.1-flash 本身支持图片，但 harness 仍拦下并提示
 * "当前模型不支持图片"——因为写进 settings.yaml 的模型条目没有声明 input 能力，harness 按纯文本
 * 处理（dsh-llm-pi-ai: `input: declaredInput(entry.input) ?? base?.input ?? defaultInput`，
 * 遇到图片时 `!model.input.includes("image")` 直接抛 UNSUPPORTED_CONTENT）。
 * 现在：provider.models 条目可写 `vision: true`（或 `input: ['text','image']`）显式声明；
 * ① writeDshConfig 据此写 input；② 带图片的请求只发给声明了图片能力的家（避免路由到纯文本家后上游报错）。
 */

/** 该 provider 对该逻辑模型是否声明了图片能力 */
function providerSupportsVision(provider, logical) {
  return modelEntries(provider).some((e) => e.as === logical && e.vision === true);
}

/** 请求体里是否含图片块（兼容 Anthropic / OpenAI chat / Responses 三种形状） */
function bodyHasImage(body) {
  if (!body || typeof body !== 'object') return false;
  const hasImg = (content) => Array.isArray(content) && content.some((b) => b && (
    b.type === 'image' || b.type === 'image_url' || b.type === 'input_image' || b.image_url != null
  ));
  if (Array.isArray(body.messages) && body.messages.some((m) => m && hasImg(m.content))) return true;
  if (Array.isArray(body.input) && body.input.some((m) => m && hasImg(m.content))) return true;   // Responses API
  return false;
}

/**
 * 带图片的请求：只保留声明了图片能力的候选。
 * 若**没有任何候选声明图片能力**，则保持原候选（宁可原样转给上游拿明确报错，也不要凭空 404）。
 */
function filterVisionCandidates(eligible, reasons, model) {
  const visionOk = eligible.filter((p) => providerSupportsVision(p, model));
  if (visionOk.length === 0) return { eligible, reasons, dropped: 0 };
  const dropped = eligible.length - visionOk.length;
  const keptReasons = reasons.filter((r) => visionOk.some((p) => p.id === r.id));
  return { eligible: visionOk, reasons: keptReasons, dropped };
}

/** 该逻辑模型是否**任一**启用的家声明了图片能力（writeDshConfig 写 input 用） */
function logicalModelSupportsVision(cfg, logical) {
  return (cfg.providers || []).some((p) => p && p.enabled !== false && providerSupportsVision(p, logical));
}

/* ================= 供应商能力 / 账户池 / WorkBuddy 凭据（2026-09-16） =================
 * 背景：WorkBuddy（腾讯 CodeBuddy）桌面 App 的内置模型只有**客户端私有接口**可用：
 *   POST {base}/v2/chat/completions            —— OpenAI chat 线格式，但强制 stream:true
 *   POST {base}/v2/plugin/auth/token/refresh   —— 刷新 OAuth access token
 *   GET  {base}/console/enterprises/personal/models
 * 鉴权是**桌面 App 的 OAuth access token**（会过期）+ 一组身份头（X-User-Id / X-Enterprise-Id /
 * X-Domain / X-Product: SaaS）。用户可能登录多个账号（多份凭据文件）→ 需要账户池：
 * 轮询分配 + 额度耗尽/会话失效时切下一个账户。
 *
 * 全部以**可选配置项**提供，未配置的供应商行为完全不变：
 *   "protocol": "openai-chat"        上游线协议（缺省 = 跟随客户端请求路径，现有行为）
 *   "auth":     "workbuddy"          启用 WorkBuddy 凭据适配（解析 / 刷新 / 身份头）
 *   "accounts": [{ "id": "a1", "authFile": "…workbuddy-desktop.info" }, { "id": "a2", "apiKey": "…" }]
 *   "headers":  { "X-Product": "SaaS" }   附加静态头
 *   "quirks":   ["force-stream", "stringify-tool-choice", "prepend-system"]
 */

/** 上游线协议：'openai-chat' | 'anthropic-messages' | null（null = 跟随客户端请求路径） */
function providerProtocol(provider) {
  const v = String((provider && provider.protocol) || '').trim().toLowerCase();
  if (v === 'openai-chat' || v === 'openai-completions' || v === 'openai') return 'openai-chat';
  if (v === 'anthropic' || v === 'anthropic-messages') return 'anthropic-messages';
  return null;
}

/** 兼容性开关（quirk）集合 */
function providerQuirks(provider) {
  const raw = provider && provider.quirks;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  return new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
}

/** 附加静态头（值必须是字符串/数字；其它类型忽略） */
function providerExtraHeaders(provider) {
  const raw = provider && provider.headers;
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    out[String(k)] = String(v);
  }
  return out;
}

/** 供应商的多把 Key（`apiKeys: [...]`；也兼容逗号/空白/分号分隔的字符串），去空去重。 */
function apiKeysOf(provider) {
  const raw = provider && provider.apiKeys;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/[\s,;]+/) : []);
  const out = [];
  for (const v of list) {
    const k = String(v == null ? '' : v).trim();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * 账户池条目（id + authFile 或 apiKey）。
 *  ① 显式 `accounts` 优先（含 workbuddy 的 authFile / 只写 { id } 的自动发现）；
 *  ② 否则 `apiKeys: ["k1","k2",…]`（2026-09-17 新增：同一供应商配多把 Key）→ 映射成 key1/key2…
 *     直接复用**已验证的账户池**：轮询分流 + 额度耗尽/密钥失效/限流时自动换下一把 + /health 可见；
 *  ③ 都没有 → 空数组（沿用顶层单个 apiKey 的老路径）。
 */
function providerAccounts(provider) {
  const raw = provider && provider.accounts;
  const isWorkBuddy = String((provider && provider.auth) || '').toLowerCase() === 'workbuddy';
  if (!Array.isArray(raw) || raw.length === 0) {
    const keys = apiKeysOf(provider);
    if (keys.length) return keys.map((k, i) => ({ id: 'key' + (i + 1), authFile: '', apiKey: k }));
    // auth=workbuddy 但没写 accounts → 视为"自动发现本机凭据"的单个账户（开箱即用）
    return isWorkBuddy ? [{ id: 'auto', authFile: '', apiKey: '' }] : [];
  }
  const out = [];
  raw.forEach((a, i) => {
    if (!a || typeof a !== 'object') return;
    const id = String(a.id || a.name || ('acct' + (i + 1))).trim();
    const authFile = String(a.authFile || a.file || '').trim();
    const apiKey = String(a.apiKey || '').trim();
    // auth=workbuddy 时允许只写 { id }：authFile 留空 → 运行时按平台默认路径自动发现
    if (!authFile && !apiKey && !isWorkBuddy) return;
    out.push({ id, authFile, apiKey });
  });
  return out;
}

/**
 * WorkBuddy 桌面 App 凭据文件的平台默认位置（按优先级）。
 * 与插件实现一致：Windows 依次探测 Local/Roaming 两处 AppData；国内版与国际版文件名不同；
 * macOS / Linux 各有一条兜底。这样配置里**不必写死用户名路径**，换机也不用改。
 */
function workbuddyDefaultAuthFiles() {
  const home = os.homedir();
  const rel = ['CodeBuddyExtension', 'Data', 'Public', 'auth'];
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const names = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info'];   // 国内版 / 国际版
  const out = [];
  for (const root of [local, roaming]) for (const n of names) out.push(path.join(root, ...rel, n));
  for (const n of names) out.push(path.join(home, 'Library', 'Application Support', ...rel, n));   // macOS
  for (const n of names) out.push(path.join(home, '.config', ...rel, n));                          // Linux
  return out;
}

/** 自动发现第一个存在的 WorkBuddy 凭据文件（找不到返回 null） */
function findWorkbuddyAuthFile() {
  // 1) 环境变量显式指定（与 dsh-workbuddy-connect 插件一致，便于非标准安装位置）
  for (const name of ['WORKBUDDY_AUTH_FILE', 'WORKBUDDY_AI_AUTH_FILE']) {
    const v = String(process.env[name] || '').trim();
    if (!v) continue;
    try { if (fs.statSync(v).isFile()) return v; } catch { /* 指了但不存在 → 继续探测 */ }
  }
  // 2) 平台默认位置
  for (const p of workbuddyDefaultAuthFiles()) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 不存在 → 下一个 */ }
  }
  return null;
}

/* ---------------- 账户池状态（轮询 + 冷却） ---------------- */
const accountPool = new Map();     // `${providerId}#${acctId}` → { state, until, reason, fails }
const accountRR = new Map();       // providerId → 轮询游标
const ACCOUNT_CREDIT_COOLDOWN_MS = envMs('DSH_GATEWAY_ACCOUNT_CREDIT_COOLDOWN_MS', 30 * 60_000);  // 额度耗尽：长冷却
const ACCOUNT_SESSION_COOLDOWN_MS = envMs('DSH_GATEWAY_ACCOUNT_SESSION_COOLDOWN_MS', 60 * 60_000); // 会话失效：等重新登录
const ACCOUNT_RATE_COOLDOWN_MS = envMs('DSH_GATEWAY_ACCOUNT_RATE_COOLDOWN_MS', 90_000);            // 限流：短冷却

function accountKey(providerId, acctId) { return providerId + '#' + acctId; }

/** 该账户当前是否可用（纯读；冷却到点即视为可用，不清状态） */
function accountUsable(providerId, acct) {
  const st = accountPool.get(accountKey(providerId, acct.id));
  if (!st) return true;
  if (st.state === 'ok') return true;
  return Date.now() >= st.until;
}

/** 标记账户失败：额度耗尽 / 会话失效 / 限流 → 冷却并切下一个账户 */
function markAccountFailure(providerId, acct, kind, detail) {
  const ms = kind === 'credit' ? ACCOUNT_CREDIT_COOLDOWN_MS
    : kind === 'session' ? ACCOUNT_SESSION_COOLDOWN_MS
      : ACCOUNT_RATE_COOLDOWN_MS;
  const key = accountKey(providerId, acct.id);
  const prev = accountPool.get(key);
  accountPool.set(key, {
    state: kind, until: Date.now() + ms, fails: (prev ? prev.fails : 0) + 1,
    reason: String(detail || kind).replace(/\s+/g, ' ').slice(0, 120),
  });
  log(`account ${providerId}#${acct.id} 标记为 ${kind}（冷却 ${Math.round(ms / 1000)}s）：${String(detail || '').slice(0, 120)}`);
}

/** 账户成功一次 → 清掉失败状态 */
function markAccountOk(providerId, acct) {
  if (acct && accountPool.has(accountKey(providerId, acct.id))) accountPool.delete(accountKey(providerId, acct.id));
}

/** 最近一次实际使用的账户（providerId → acctId）；日志里以 `#acct` 标注，便于核对多账户分流 */
const accountLastUsed = new Map();

/** 日志用的 via 标签：provider 无账户池时就是 provider id；有则附上本次账户 `provider#acct` */
function viaTag(providerId) {
  const acct = accountLastUsed.get(providerId);
  return acct ? `${providerId}#${acct}` : providerId;
}

/**
 * 账户池快照（诊断用：/health 的 accounts 字段）。
 * 不仅列出"冷却中"的，而是**按配置列出全部账户**及其当前状态 —— 多账户场景下
 * "到底有几个账户、哪个被额度耗尽、还剩多久恢复"必须一眼可见。
 * @param {object} [cfg] 传入配置则连同未进入过冷却的账户一起列出（state='ok'）
 */
function accountPoolSnapshot(cfg) {
  const out = [];
  const seen = new Set();
  if (cfg && Array.isArray(cfg.providers)) {
    for (const p of cfg.providers) {
      if (!p || p.enabled === false) continue;
      for (const acct of providerAccounts(p)) {
        const key = accountKey(p.id, acct.id);
        seen.add(key);
        const st = accountPool.get(key);
        const usable = accountUsable(p.id, acct);
        out.push({
          key,
          provider: p.id,
          id: acct.id,
          state: st && !usable ? st.state : 'ok',
          remainMs: st && !usable ? Math.max(0, st.until - Date.now()) : 0,
          ...(st && !usable ? { reason: st.reason } : {}),
          ...(accountLastUsed.get(p.id) === acct.id ? { lastUsed: true } : {}),
        });
      }
    }
  }
  // 兜底：配置里已删除、但进程内仍有冷却记录的账户也列出来（便于发现"配置改了仍被冷却"）
  for (const [key, st] of accountPool) {
    if (seen.has(key)) continue;
    out.push({
      key,
      state: st.state,
      remainMs: Math.max(0, st.until - Date.now()),
      reason: st.reason,
      orphan: true,
    });
  }
  return out;
}

/**
 * 取该供应商本次要用的账户（轮询）。
 * 返回 null 表示"无账户池"（沿用顶层 apiKey 的旧路径）；返回 {accounts:[], allCooling:true}
 * 由调用方决定是否整体跳过。
 */
function pickAccount(provider) {
  const accounts = providerAccounts(provider);
  if (accounts.length === 0) return { acct: null, accounts, cooling: 0 };
  const usable = accounts.filter((a) => accountUsable(provider.id, a));
  if (usable.length === 0) return { acct: null, accounts, cooling: accounts.length };
  const n = accountRR.get(provider.id) || 0;
  accountRR.set(provider.id, n + 1);
  return { acct: usable[n % usable.length], accounts, cooling: 0 };
}

/* ---------------- WorkBuddy 凭据：解析 / 刷新 / 身份头 ---------------- */

/** 解析桌面 App 的 auth 文件（两种形态：{auth,account} 嵌套 与 扁平） */
function parseWorkBuddyAuth(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const nested = doc.auth && typeof doc.auth === 'object' && !Array.isArray(doc.auth);
  const auth = nested ? doc.auth : doc;
  const account = nested && doc.account && typeof doc.account === 'object' ? doc.account : doc;
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : '';
  if (!accessToken) return null;
  const toMs = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e12 ? n : n * 1000;   // 秒 / 毫秒两种上游写法
  };
  const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: toMs(auth.expiresAt ?? auth.expires_at),
    refreshExpiresAtMs: toMs(auth.refreshExpiresAt),
    domain: str(auth.domain) || '',
    uid: str(account.uid) || '',
    enterpriseId: str(account.enterpriseId),
    nickname: str(account.nickname),
  };
}

/** 自留副本路径（网关自己的目录，绝不写桌面 App 的文件） */
function workbuddyOwnPath(provider, acct) {
  const dir = path.join(path.dirname(CONFIG_PATH), 'workbuddy-auth');
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, `${safe(provider.id)}-${safe(acct.id)}.json`);
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 该凭据是否需要在本次请求前刷新（5 分钟余量） */
const WORKBUDDY_REFRESH_MARGIN_MS = 5 * 60_000;
function workbuddyNeedsRefresh(cred) {
  if (!cred || cred.expiresAtMs <= 0) return true;
  return Date.now() + WORKBUDDY_REFRESH_MARGIN_MS >= cred.expiresAtMs;
}

/** 刷新 OAuth token：POST {base}/plugin/auth/token/refresh（base 已含 /v2） */
async function refreshWorkBuddyToken(provider, acct, cred) {
  if (!cred.refreshToken) throw new Error('无 refreshToken，需在 WorkBuddy 桌面 App 重新登录');
  const base = upstreamBase(provider.baseURL);
  const origin = workbuddyOrigin(cred.domain);
  const res = await fetch(`${base}/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: origin,
      Referer: origin + '/',
      'User-Agent': providerExtraHeaders(provider)['User-Agent'] || 'CLI/2.63.2 CodeBuddy/2.63.2',
      'X-Refresh-Token': cred.refreshToken,
      'X-Auth-Refresh-Source': 'workbuddy',
      ...(cred.enterpriseId ? { 'X-Enterprise-Id': cred.enterpriseId } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let doc = null;
  try { doc = JSON.parse(text); } catch { /* 非 JSON：下面按失败处理 */ }
  const data = doc && typeof doc === 'object' && doc.data && typeof doc.data === 'object' ? doc.data : {};
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
  if (!res.ok || (doc && typeof doc.code === 'number' && doc.code !== 0) || !accessToken) {
    const msg = (doc && typeof doc.msg === 'string' && doc.msg) || text.slice(0, 160);
    throw new Error(`刷新失败（HTTP ${res.status}）：${msg}`);
  }
  const next = {
    ...cred,
    accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : cred.refreshToken,
    expiresAtMs: typeof data.expiresIn === 'number' && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1000 : cred.expiresAtMs,
    domain: typeof data.domain === 'string' && data.domain ? data.domain : cred.domain,
  };
  try {
    fs.mkdirSync(path.dirname(workbuddyOwnPath(provider, acct)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(workbuddyOwnPath(provider, acct), JSON.stringify({ version: 1, credential: next }, null, 2), { mode: 0o600 });
  } catch (e) {
    log(`account ${provider.id}#${acct.id} 凭据副本写入失败（不影响本次使用）：${e && e.message}`);
  }
  return next;
}

const workbuddyCredCache = new Map();      // key → { cred, ts }
const workbuddyInflight = new Map();       // key → Promise（单飞：并发请求共享一次刷新）

/** 解析该账户当前可用的凭据（缓存 → 自留副本 → 桌面 auth 文件），必要时单飞刷新 */
async function resolveWorkBuddyCredential(provider, acct) {
  if (acct.apiKey) return { accessToken: acct.apiKey, refreshToken: '', expiresAtMs: Date.now() + 3600_000, domain: '', uid: '' };
  const key = accountKey(provider.id, acct.id);
  const cached = workbuddyCredCache.get(key);
  if (cached && !workbuddyNeedsRefresh(cached.cred)) return cached.cred;
  if (workbuddyInflight.has(key)) return workbuddyInflight.get(key);
  const task = (async () => {
    const ownRaw = readJsonSafe(workbuddyOwnPath(provider, acct));
    const own = ownRaw && ownRaw.credential ? ownRaw.credential : null;
    let desktop = null;
    // authFile 留空 → 按平台默认位置自动发现（配置里不必写死机器相关路径）
    const authFile = acct.authFile || findWorkbuddyAuthFile();
    try {
      if (authFile) desktop = parseWorkBuddyAuth(fs.readFileSync(authFile, 'utf8'));
    } catch (e) {
      if (!own) throw new Error(`读凭据文件失败：${authFile}（${e && e.message}）`);
    }
    // 身份优先：桌面文件是"当前登录的是谁"的权威；自留副本可能是旧账号
    let cred = desktop || own;
    if (!cred) {
      throw new Error(authFile
        ? `账户 ${acct.id} 无可用凭据：${authFile} 未登录或已失效`
        : `账户 ${acct.id} 未找到 WorkBuddy 登录凭据——请先安装并登录 WorkBuddy 桌面 App`
          + `（已探测：${workbuddyDefaultAuthFiles().slice(0, 2).join('、')} 等）`);
    }
    if (desktop && own && desktop.uid !== own.uid) cred = desktop;
    if (workbuddyNeedsRefresh(cred)) {
      try {
        cred = await refreshWorkBuddyToken(provider, acct, cred);
      } catch (e) {
        if (cred.expiresAtMs > Date.now() + 30_000) {
          log(`account ${provider.id}#${acct.id} 刷新失败但 token 未过期，继续使用：${e && e.message}`);
        } else {
          throw e;
        }
      }
    }
    workbuddyCredCache.set(key, { cred, ts: Date.now() });
    return cred;
  })().finally(() => workbuddyInflight.delete(key));
  workbuddyInflight.set(key, task);
  return task;
}

/** WorkBuddy 的区域 origin（身份头 Origin/Referer 用） */
function workbuddyOrigin(domain) {
  const d = String(domain || '').toLowerCase();
  return d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai') ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
}

/* ---------------- WorkBuddy 客户端身份仿真（2026-09-16） ----------------
 * 官方桌面客户端的 chat 请求带 `WorkBuddy/<appVer> WorkBuddy/<appVer> CLI/<cliVer>` 形态 UA
 *（国际版产品名 `WorkBuddy AI`），而刷新/目录接口用 CLI 形态 UA。上游按客户端身份套用不同的
 * 模型能力/参数规则 —— 用 CLI 形态打 chat 会被判"参数不符合模型要求"
 *（实测 HTTP 400 code 11133 model_param_invalid）。这里按本机真实版本合成桌面 UA。
 * 版本来源（沿用 dsh-workbuddy-connect 的取值规则，并补上 Windows 路径）：
 *   · App：<安装目录>\resources\install-manifest.json 的 appVersion（Windows 实测可得）
 *   · CLI：<安装目录>\resources\app.asar.unpacked\cli\package.json —— version 为 0.0.0 占位时
 *     取 publishConfig.customPackage.version
 * 读不到就退回 CLI 形态常量（不阻塞请求），与插件"降级但不失败"的策略一致。
 */
const WORKBUDDY_FALLBACK_APP_VERSION = '5.5.6';           // 与插件 FALLBACK_CN_APP_VERSION 一致
const WORKBUDDY_CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';   // 刷新/目录用（插件同款常量）

/** 候选安装目录（Windows / macOS），env WORKBUDDY_APP_DIR 可覆盖 */
function workbuddyAppDirs() {
  const out = [];
  const env = String(process.env.WORKBUDDY_APP_DIR || '').trim();
  if (env) out.push(env);
  if (process.platform === 'win32') {
    for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (root) out.push(path.join(root, 'Programs', 'WorkBuddy'), path.join(root, 'WorkBuddy'));
    }
  } else {
    out.push(path.join(os.homedir(), 'Applications', 'WorkBuddy.app'), '/Applications/WorkBuddy.app');
  }
  return out;
}

const workbuddyVersionCache = new Map();   // dir → { appVersion, cliVersion }

/** 读一个安装目录里的 App / CLI 版本 */
function readWorkbuddyVersions(dir) {
  if (workbuddyVersionCache.has(dir)) return workbuddyVersionCache.get(dir);
  let appVersion = '';
  let cliVersion = '';
  const resDir = path.join(dir, 'resources');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(resDir, 'install-manifest.json'), 'utf8'));
    if (manifest && typeof manifest.appVersion === 'string' && /^\d+(\.\d+){1,3}$/.test(manifest.appVersion)) {
      appVersion = manifest.appVersion;
    }
  } catch { /* 该目录没有 → 试下一个 */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(resDir, 'app.asar.unpacked', 'cli', 'package.json'), 'utf8'));
    const declared = typeof pkg.version === 'string' ? pkg.version : '';
    const custom = pkg.publishConfig && pkg.publishConfig.customPackage
      && typeof pkg.publishConfig.customPackage.version === 'string' ? pkg.publishConfig.customPackage.version : '';
    const valid = (v) => /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/.test(v);
    if (valid(declared) && declared !== '0.0.0') cliVersion = declared;
    else if (valid(custom)) cliVersion = custom;
  } catch { /* CLI 版本可选 */ }
  const out = { appVersion, cliVersion };
  workbuddyVersionCache.set(dir, out);
  return out;
}

/** 本机 WorkBuddy 的 App / CLI 版本（找不到返回空串） */
function workbuddyVersions() {
  for (const dir of workbuddyAppDirs()) {
    const v = readWorkbuddyVersions(dir);
    if (v.appVersion) return v;
  }
  return { appVersion: '', cliVersion: '' };
}

/** 合成 chat 的桌面身份 UA：`WorkBuddy/<app> WorkBuddy/<app> [CLI/<cli>]` */
function workbuddyChatUserAgent(domain) {
  const { appVersion, cliVersion } = workbuddyVersions();
  if (!appVersion) return WORKBUDDY_CLI_UA;
  const d = String(domain || '').toLowerCase();
  const product = (d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')) ? 'WorkBuddy AI' : 'WorkBuddy';
  const parts = [`WorkBuddy/${appVersion}`, `${product}/${appVersion}`];
  if (cliVersion) parts.push(`CLI/${cliVersion}`);
  return parts.join(' ');
}

/**
 * 用凭据构造上游请求头（Authorization + 身份头 + 客户端仿真头）
 * @param {boolean} [forChat] true = chat 请求（用桌面身份 UA）；缺省 = 刷新/目录（CLI 形态 UA）
 */
function workbuddyHeaders(provider, cred, extra, forChat) {
  const origin = workbuddyOrigin(cred.domain);
  const h = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: origin + '/',
    'Content-Type': 'application/json',
    'X-Product': 'SaaS',
    Authorization: 'Bearer ' + cred.accessToken,
    ...(cred.uid ? { 'X-User-Id': cred.uid } : { 'X-No-User-Id': '1' }),
    ...(cred.enterpriseId ? { 'X-Enterprise-Id': cred.enterpriseId } : { 'X-No-Enterprise-Id': '1' }),
    ...(cred.domain ? { 'X-Domain': cred.domain } : { 'X-No-Department-Info': '1' }),
    ...(extra || {}),
  };
  // 身份仿真（关键）：chat 用桌面形态 UA；刷新/目录保持 CLI 形态。
  // 配置里的 headers.User-Agent 只作为刷新路径的覆盖，不参与 chat（chat 必须是桌面身份）。
  if (forChat) h['User-Agent'] = workbuddyChatUserAgent(cred.domain);
  else h['User-Agent'] = WORKBUDDY_CLI_UA;
  return h;
}

/**
 * 由网关独占的"凭据/身份"类请求头（大小写不敏感）。
 * 翻译路径重建上游头时先剔除它们，避免与账户凭据头重复（重复会变成 "Bearer A, Bearer B" 的坏值）。
 */
const RESERVED_UPSTREAM_HEADERS = new Set([
  'authorization', 'x-api-key', 'anthropic-version',
  'x-user-id', 'x-enterprise-id', 'x-domain', 'x-product',
  'x-no-user-id', 'x-no-enterprise-id', 'x-no-department-info',
  'origin', 'referer', 'x-requested-with',
]);

/** 大小写不敏感地删除某个头（Node 会把大小写不同的同名头用 ", " 合并成脏值） */
function dropHeaderCI(obj, name) {
  for (const k of Object.keys(obj)) if (k.toLowerCase() === name) delete obj[k];
}
/** 大小写不敏感地取某个头 */
function pickHeaderCI(obj, name) {
  for (const [k, v] of Object.entries(obj || {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

/**
 * 构造"用某个账户发上游请求"的完整请求头（翻译路径与直通路径共用，避免两处漂移）：
 *  ① 剔除网关独占的凭据/身份头（防重复 Authorization）；
 *  ② auth=workbuddy → 解析凭据 + 身份头 + **桌面客户端形态 UA**（chat）/CLI 形态 UA（刷新）；
 *  ③ 否则用账户自带 apiKey（OpenAI 线上游发 Bearer；Anthropic 线上游发 x-api-key）；
 *  ④ 合并供应商 `headers` 自定义头。
 * 凭据不可用时抛错，由调用方决定"换账户"还是"放弃该供应商"。
 */
async function accountUpstreamHeaders(provider, acct, baseHeaders, { anthropicUpstream }) {
  const extra = providerExtraHeaders(provider);
  const base = { ...(baseHeaders || {}) };
  for (const k of Object.keys(base)) {
    if (RESERVED_UPSTREAM_HEADERS.has(k.toLowerCase())) delete base[k];
  }
  // User-Agent 必须**只有一个**：供应商显式配置优先，其次沿用 base（Claude 仿真）；
  // 先记录再删除所有大小写变体，最后由下面按需写回唯一一个（WorkBuddy 分支写桌面身份）。
  const ua = pickHeaderCI(extra, 'user-agent') ?? pickHeaderCI(base, 'user-agent');
  const out = { ...base, ...extra };
  dropHeaderCI(out, 'user-agent');
  if (acct && acct.id) accountLastUsed.set(provider.id, acct.id);   // 日志/health 标注本次账户
  if (String(provider.auth || '').toLowerCase() === 'workbuddy') {
    const cred = await resolveWorkBuddyCredential(provider, acct || { id: 'default' });
    Object.assign(out, workbuddyHeaders(provider, cred, out, true));   // 内部设置唯一的桌面身份 UA
    return out;
  }
  if (ua) out['User-Agent'] = ua;
  const key = (acct && acct.apiKey) || provider.apiKey;
  if (key) {
    if (anthropicUpstream) {
      out['x-api-key'] = key;
      out['anthropic-version'] = out['anthropic-version'] || '2023-06-01';
    } else {
      out.authorization = 'Bearer ' + key;
    }
  }
  return out;
}

/**
 * 带账户池的上游转发（2026-09-16）：供应商配了 accounts 时，先用轮询选中的账户发；
 * 若失败属于**账户级**（额度耗尽 / 会话失效 / 限流），标记该账户并换下一个账户重试；
 * 全部账户都不可用（或失败与账户无关）才按 forward() 的原契约返回，交给下一家供应商。
 *
 * 实现要点：不改写 forward() 的主流程，只借 opts.failureSink 拿回"上游状态码 + 错误体"，
 * 由本函数做账户级判定 —— 这样流式透传 / SSE 首事件嗅探 / 熔断等既有行为完全复用。
 */
async function forwardWithAccounts(provider, upstreamPath, baseHeaders, body, res, opts) {
  const accounts = providerAccounts(provider);
  // 无账户池：仍要走一遍账户头构造 —— 否则供应商 `headers`（自定义 UA/品牌头）在直通路径上会被丢掉
  if (accounts.length === 0) {
    const anthropicUpstream = upstreamPath === '/messages' || upstreamPath === '/v1/messages';
    let headers = baseHeaders;
    try {
      headers = await accountUpstreamHeaders(provider, null, baseHeaders, { anthropicUpstream });
    } catch (e) {
      log(`provider ${provider.id} 头部构造失败：${e && e.message}`);
      return false;
    }
    return forward(provider, upstreamPath, headers, body, res, opts);
  }
  const usable = accounts.filter((a) => accountUsable(provider.id, a));
  if (usable.length === 0) {
    log(`provider ${provider.id}: ${accounts.length} 个账户全部冷却中 → 交给下一家`);
    return false;
  }
  // 轮询起点（与翻译路径共用同一游标，保证多账户分流均匀）
  const n = accountRR.get(provider.id) || 0;
  accountRR.set(provider.id, n + 1);
  const ordered = [...usable.slice(n % usable.length), ...usable.slice(0, n % usable.length)];
  const anthropicUpstream = upstreamPath === '/messages' || upstreamPath === '/v1/messages';
  let lastOut = false;
  for (let i = 0; i < ordered.length; i++) {
    const acct = ordered[i];
    let headers;
    try {
      // eslint-disable-next-line no-await-in-loop
      headers = await accountUpstreamHeaders(provider, acct, baseHeaders, { anthropicUpstream });
    } catch (e) {
      log(`account ${provider.id}#${acct.id} 凭据不可用：${e && e.message}`);
      markAccountFailure(provider.id, acct, 'session', e && e.message);
      continue;
    }
    const sink = {};
    // eslint-disable-next-line no-await-in-loop
    const out = await forward(provider, upstreamPath, headers, body, res, { ...(opts || {}), failureSink: sink, accountScoped: true });
    if (out === true) { markAccountOk(provider.id, acct); return true; }
    if (res.headersSent) return out;                     // 已经写给客户端了，不能再重试
    const kind = classifyAccountFailure(sink.status || 0, sink.detail || '');
    if (kind && i + 1 < ordered.length) {
      markAccountFailure(provider.id, acct, kind, sink.detail);
      continue;                                          // 换下一个账户
    }
    if (kind) markAccountFailure(provider.id, acct, kind, sink.detail);   // 最后一个账户也要标记
    lastOut = out;
    if (!kind) return out;                               // 与账户无关的失败 → 原样返回
  }
  return lastOut;
}

/**
 * 直通路径（客户端说 OpenAI 协议）也要应用供应商 quirks —— 2026-09-16 实测：
 * 同一份配置里的 `stringify-tool-choice` 只在**翻译路径**生效，于是 OpenAI 客户端把
 * `tool_choice` 以对象形态透传，上游直接 400
 *（`11101: cannot unmarshal object into Go struct field Request.tool_choice of type string`）。
 * 这里统一在发请求前改写 body；返回 { body, forceStreamForNonStream } 供调用方决定是否聚合流。
 */
function applyOpenAIQuirks(body, provider) {
  const quirks = providerQuirks(provider);
  if (!body || typeof body !== 'object' || quirks.size === 0) return { body, needAggregate: false };
  let out = body;
  const detach = () => { if (out === body) out = { ...body }; return out; };
  // ① tool_choice 必须是字符串（对象形态会被上游拒绝）
  if (quirks.has('stringify-tool-choice') && out.tool_choice && typeof out.tool_choice === 'object') {
    const tc = detach().tool_choice;
    out.tool_choice = (tc.function && tc.function.name) || tc.name || 'auto';
  }
  // ② 首条必须是 system：缺失时补一条（仅当确实没有 system 时才补，顺序不动）
  if (quirks.has('prepend-system')) {
    const msgs = Array.isArray(out.messages) ? out.messages : null;
    if (msgs && !(msgs[0] && msgs[0].role === 'system')) {
      detach().messages = [{ role: 'system', content: 'You are a helpful assistant.' }, ...msgs];
    }
  }
  // ③ 上游只接受流式：强制 stream=true；客户端要非流式 → 由调用方聚合后回单条 JSON
  let needAggregate = false;
  if (quirks.has('force-stream') && out.stream !== true) {
    needAggregate = !out.stream;   // 客户端本来要非流式 → 需要聚合
    detach().stream = true;
  }
  return { body: out, needAggregate };
}

/**
 * OpenAI SSE → 单个 chat.completion（聚合）：用于"上游强制流式、而客户端要非流式"的直通路径。
 * 只聚合文本/推理/工具调用分片与 finish_reason/usage，不做协议翻译。
 */
async function aggregateOpenAIStream(upstream, headBytes) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let id = '';
  let model = '';
  let content = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  const toolCalls = new Map();
  const feed = (text) => {
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      const m = /^data:\s*(.*)$/.exec(line);
      if (!m) continue;
      const payload = m[1].trim();
      if (payload === '[DONE]') continue;
      let json = null;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json.id) id = json.id;
      if (json.model) model = json.model;
      if (json.usage) usage = json.usage;
      const choice = (Array.isArray(json.choices) ? json.choices[0] : null) || {};
      const d = choice.delta || {};
      if (typeof d.content === 'string') content += d.content;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      for (const call of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const idx = Number.isInteger(call.index) ? call.index : 0;
        const entry = toolCalls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) entry.id = call.id;
        if (call.function && call.function.name) entry.function.name = call.function.name;
        if (call.function && call.function.arguments) entry.function.arguments += call.function.arguments;
        toolCalls.set(idx, entry);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  };
  try {
    // 注意：forward() 为识别"首事件即错误"已偷看过首个事件，那些字节必须原样喂回来，否则丢内容
    if (headBytes && headBytes.length) feed(Buffer.from(headBytes).toString('utf8'));
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    log(`上游流聚合失败：${e && e.message}`);
  } finally {
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
  const message = { role: 'assistant', content: content === '' && toolCalls.size ? null : content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.values()].map((t) => ({
    ...t, id: t.id || 'call_' + Math.random().toString(36).slice(2, 10),
  }));
  return {
    id: id || 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

/** 账户级失败判定（额度耗尽 / 会话失效 / 限流）——决定"换账户"而不是"换供应商" */
const WORKBUDDY_CREDIT_RE = /insufficient credit|no credit|credit exhausted|credits exhausted|out of credit|quota exceeded|quota exhaust|payment required|credit not enough|not enough credit|积分不足|额度不足|余额不足|积分用完|额度用尽|没有积分/i;
const WORKBUDDY_SESSION_RE = /Offline user session not found|12153|session not found|login expired|重新登录/i;
function classifyAccountFailure(status, detail) {
  if (status === 402) return 'credit';
  if (WORKBUDDY_CREDIT_RE.test(detail)) return 'credit';
  if (WORKBUDDY_SESSION_RE.test(detail)) return 'session';
  if (status === 429) return 'rate';
  return null;
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

/* ---------------- OpenAI Responses 协议（POST /v1/responses）请求体处理 ----------------
 * Responses 与 chat/completions 是同一家上游的两种协议，字段结构不同：
 *   messages[]（chat）        → input（字符串 / item 数组）+ instructions（系统提示）
 *   reasoning_effort/thinking → reasoning.effort
 * 因此 chat 路径的 translateBody / desensitizeBodyMessages **在 Responses 上完全不生效**
 *（它们只认 body.messages）——密钥打码、role 兼容、推理档位翻译在 Responses 路径等于全缺失。
 * 这里补齐同一套语义（与 chat 路径共用 reasoningEffortMap 和 maskSecretTokens，
 * 保证两种协议的网关行为一致）。
 * @returns 翻译后的 body（无变化时返回原对象）
 */
function translateResponsesBody(body, provider) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let out = body;
  const detach = () => { if (out === body) out = { ...body }; return out; };

  // 1) 推理档位（R4）：Responses 只认 reasoning.effort 字符串。
  //    对象形态映射（chat 用 { thinking: 'disabled'|'enabled' }）在 Responses 里的等价物是
  //    "有没有 reasoning 字段"：disabled → 整段移除；enabled → 保留原档位。
  //    字符串形态中的 off 语义（off/none/disabled）同样按"移除 reasoning"处理：
  //    Responses 协议没有"关闭"枚举值（官方就是靠不发该字段来关闭），照抄 chat 的
  //    `effort: "disabled"` 会被严格校验的上游直接 400；其余档位照抄映射值。
  const map = provider && provider.reasoningEffortMap && typeof provider.reasoningEffortMap === 'object'
    ? provider.reasoningEffortMap : null;
  const r = body.reasoning;
  const OFF_LIKE_RE = /^(off|none|disabled|false)$/i;
  if (map && r && typeof r === 'object' && !Array.isArray(r) && typeof r.effort === 'string') {
    const want = r.effort;
    const mapped = map[want];
    if (typeof mapped === 'string') {
      if (OFF_LIKE_RE.test(mapped) || OFF_LIKE_RE.test(want)) delete detach().reasoning;
      else if (mapped !== want) detach().reasoning = { ...r, effort: mapped };
    } else if (mapped && typeof mapped === 'object') {
      if (typeof mapped.effort === 'string') {
        if (OFF_LIKE_RE.test(mapped.effort)) delete detach().reasoning;
        else if (mapped.effort !== want) detach().reasoning = { ...r, effort: mapped.effort };
      } else if (mapped.thinking === 'disabled') {
        // 关闭推理：上游收到未知的 thinking 字段会 400，直接不发 reasoning
        delete detach().reasoning;
      }
    }
  }

  // 2) 打码（R9）：instructions（等价 chat 的 system 消息）与 input（等价 messages）
  if (typeof out.instructions === 'string') {
    const m = maskSecretTokens(out.instructions);
    if (m !== out.instructions) detach().instructions = m;
  }
  if (typeof out.input === 'string') {
    const m = maskSecretTokens(out.input);
    if (m !== out.input) detach().input = m;
  } else if (Array.isArray(out.input)) {
    const items = maskResponsesItems(out.input);
    if (items) detach().input = items;
  }
  return out;
}

/** Responses input item 数组：developer→system（R5 role 兼容）+ 文本打码（R9）。
 * 覆盖 { role, content: '…' }、{ role, content: [{ type:'input_text', text }] }、
 * { type:'function_call_output', output }（等价 chat 的 tool 消息 = 长串重灾区）。
 * @returns 新数组；无改动返回 null */
function maskResponsesItems(items) {
  let changed = false;
  const next = items.map((it) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
    let n = it;
    const detach = () => { if (n === it) { n = { ...it }; changed = true; } return n; };
    if (n.role === 'developer' && (!n.type || n.type === 'message')) detach().role = 'system';
    if (typeof n.content === 'string') {
      const m = maskSecretTokens(n.content);
      if (m !== n.content) detach().content = m;
    } else if (Array.isArray(n.content)) {
      const parts = n.content.map((pt) => {
        if (pt && typeof pt === 'object' && !Array.isArray(pt) && typeof pt.text === 'string') {
          const m = maskSecretTokens(pt.text);
          if (m !== pt.text) { changed = true; return { ...pt, text: m }; }
        }
        return pt;
      });
      if (parts.some((pt, i) => pt !== n.content[i])) detach().content = parts;
    }
    if (typeof n.output === 'string') {
      const m = maskSecretTokens(n.output);
      if (m !== n.output) detach().output = m;
    }
    return n;
  });
  return changed ? next : null;
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

// R9c：Responses 协议的降敏重试（对应 desensitizeBodyMessages）——对 instructions / input
// 的文本与文本块降敏；function_call 的 arguments（JSON 结构）不动，避免破坏工具调用。
function desensitizeResponsesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let out = body;
  const detach = () => { if (out === body) out = { ...body }; return out; };
  if (typeof body.instructions === 'string') {
    const d = desensitizeLongTokens(body.instructions);
    if (d !== body.instructions) detach().instructions = d;
  }
  if (typeof body.input === 'string') {
    const d = desensitizeLongTokens(body.input);
    if (d !== body.input) detach().input = d;
  } else if (Array.isArray(body.input)) {
    let changed = false;
    const next = body.input.map((it) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
      let n = it;
      if (typeof n.content === 'string') {
        const d = desensitizeLongTokens(n.content);
        if (d !== n.content) { n = { ...n, content: d }; changed = true; }
      } else if (Array.isArray(n.content)) {
        const parts = n.content.map((pt) => {
          if (pt && typeof pt === 'object' && !Array.isArray(pt) && typeof pt.text === 'string') {
            const d = desensitizeLongTokens(pt.text);
            if (d !== pt.text) return { ...pt, text: d };
          }
          return pt;
        });
        if (parts.some((pt, i) => pt !== n.content[i])) { n = { ...n, content: parts }; changed = true; }
      }
      if (typeof n.output === 'string') {
        const d = desensitizeLongTokens(n.output);
        if (d !== n.output) { n = { ...n, output: d }; changed = true; }
      }
      return n;
    });
    if (changed) detach().input = next;
  }
  return out;
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

/**
 * 404 的第二种细分（2026-09-11 实测补充）：**整条路由都没实现**。
 * 实测证据：new-api / one-api 系上游只实现了 `POST /v1/responses`（生成），对 Responses
 * 资源子路由一律回 `{"error":{"message":"Invalid URL (GET /v1/responses/resp_…)"}}`。
 * 这与"资源确实不存在/已过期"是两件不同的事：前者重试、换供应商、等一会儿都不会好，
 * 是供应商能力缺失。网关据此给出可操作的提示，而不是笼统地说"可能被删了"。
 */
const ROUTE_MISSING_RE = /invalid\s+url|not\s+implemented|unsupported\s+(method|route|endpoint|operation)|no\s+such\s+route|method\s+not\s+allowed|cannot\s+(get|post|delete|put)|unknown\s+(method|endpoint|route)/i;

/** 确定性 4xx → 回给客户端的状态码（只映射到这几个"语义明确且不泄露上游信息"的状态码）。 */
const DETERMINISTIC_4XX_STATUS = { 400: 400, 404: 404, 413: 413, 422: 422 };

/**
 * 「供应商侧」4xx（账号/额度/权限/套餐）——**不是**请求本身有错，而是"这家现在不能给你服务"。
 * 实测事故（2026-09-15）：b.ai 余额为 0 时回 HTTP **400** `credit insufficient balance: balance=0`，
 * 旧实现按"确定性 4xx"终止 failover → 用户明明还有可用的 chiyi-ds，却被欠费的那家直接打死
 * （客户端拿到 400「请求本身无效」，误导排查方向）。
 * 语义上它与 401/403 同类：冷却该家 + 计入熔断 + **继续换下一家**。
 * 注意：必须在"内容拦截"判定之后使用，且不能吞掉真正的客户端错误（参数/size/不可处理）。
 */
const PROVIDER_SIDE_4XX_RE = /credit|balance|insufficient|quota|deposit|billing|unpaid|arrears|recharge|top\s*up|account\s+(?:suspended|disabled|locked|deactivated|banned)|no\s+available\s+(?:channel|quota|balance)|exceeded\s+your\s+(?:current\s+)?quota|not\s+available\s+(?:for|on)\s+your\s+(?:plan|account)|欠费|余额|额度|充值|未开通|无可用(?:渠道|额度)/i;
/** 其中"余额/欠费"类属于长期状态（充值前不会自愈）→ 用长熔断，避免反复打点 */
const PERSISTENT_ACCOUNT_RE = /credit|balance|deposit|billing|unpaid|arrears|欠费|余额|充值|budget\s*pool|quota|额度|预算|套餐/i;

/**
 * thinking 回传要求（2026-09-16 实测事故：air-outer / agentrouter）。
 *
 * Claude 的扩展思考语义：请求开了 thinking（或历史里出现过 thinking）时，**带 tool_use 的
 * assistant 轮必须把 thinking 块一起回传**，否则上游回
 *   HTTP 400 {"error":{"message":"The `content[].thinking` in the thinking mode must be
 *   passed back to the API. ..."}}
 * 实测触发条件（见下）与内容无关，**只看结构**：
 *   · assistant 轮里只有 tool_use（或 text+tool_use）→ 400；
 *   · 补一个 thinking 块（哪怕 thinking:'' + signature:''，甚至不带 signature 字段）→ 200。
 * 客户端（pi-ai）在"thinking 无签名"时会把该块降级成普通 text（allowEmptySignature 未开），
 * 于是上游只看到 text+tool_use → 400。两条对应修复：
 *   ① 客户端侧：dsh settings.yaml 的模型加 compat.allowEmptySignature: true（writeDshConfig 写入）；
 *   ② 网关侧：命中该 400 时补空占位 thinking 块重试一次（下面的 withThinkingPlaceholders），
 *      兜住任何未开该开关的客户端。实测 chiyi-ds / amd 等不要求该结构的家接受占位块，无副作用。
 */
const THINKING_PASSBACK_RE = /content\[\]\.thinking|thinking[^.\n]{0,40}must be passed back|thinking mode must be passed back/i;

/**
 * 同一规则的**另一种上游措辞**（2026-09-16 实测补充）：agentrouter 不解释原因，只回
 *   HTTP 500 {"error":{"message":"Upstream rejected the request as invalid","type":"invalid_request_error"}}
 * 实测同一请求体（带 tool_use 的 assistant 轮缺 thinking 块）补空占位后即 200，故该措辞也纳入
 * 补位触发条件。**注意**：该措辞本身很泛，所以只在"确实存在可补位的轮次"
 *（withThinkingPlaceholders 返回非 null）时才真正重试，不会对无关的 500 盲目重发。
 */
const THINKING_REJECTED_GENERIC_RE = /rejected the request as invalid/i;

/**
 * 给"带 tool_use 但缺 thinking 块"的 assistant 轮补一个空占位 thinking 块。
 * 只做**结构性补齐**：thinking 正文与签名都为空（不伪造推理内容）。
 * @returns {{body:object, repaired:number}|null} 无需修复时返回 null。
 */
function withThinkingPlaceholders(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  let repaired = 0;
  const messages = body.messages.map((msg) => {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
    if (msg.content.some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))) return msg;
    const firstTool = msg.content.findIndex((b) => b && b.type === 'tool_use');
    if (firstTool < 0) return msg;
    const content = msg.content.slice();
    content.splice(firstTool, 0, { type: 'thinking', thinking: '', signature: '' });
    repaired++;
    return { ...msg, content };
  });
  return repaired ? { body: { ...body, messages }, repaired } : null;
}

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
async function forward(provider, upstreamPath, upstreamHeaders, body, res, opts) {
  const responsesMode = !!(opts && opts.responses);
  // raw 模式（Responses 资源子路由 GET/DELETE/cancel）：无请求体、不做协议翻译、方法可变，
  // 只把上游响应原样流回。有 body 的转发一律走 POST + 翻译路径。
  const rawMode = !!(opts && opts.raw);
  const method = (opts && opts.method) || 'POST';
  // 审计修复（P2，本次）：发请求前先占用熔断半开探测名额（唯一的状态转换点）。抢不到
  //（冷却未到点 / 已有探测在途）→ 本次不发任何上游请求，直接交给下一家。
  if (!breakerAcquire(provider.id)) {
    log(`skip ${provider.id} (breaker: cooldown or half-open probe already in flight)`);
    return false;
  }
  const startedAt = Date.now();   // 网络错"够快才重试"的判定基准
  const timeoutMs = providerTimeoutMs(provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let upstream;
  let init = null;   // 首次请求的 fetch init（网络错原地重试用；见下方 catch）
  let firstDetail = null;   // 首次响应体（若已读取，后续分支复用，避免 body 二次消费报错）
  let needAggregate = false;   // 上游被强制流式、客户端要非流式 → 成功路径需聚合（见 applyOpenAIQuirks）
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
    let outBody = rawMode ? null
      : (isAnthropicPath
        ? body
        : (responsesMode ? translateResponsesBody(body, provider) : translateBody(body, provider)));   // R5：role 兼容 + 推理档位翻译（Responses 走对应实现）
    // 直通路径也要应用供应商 quirks（2026-09-16 实测：stringify-tool-choice 只在翻译路径生效，
    // OpenAI 客户端把 tool_choice 对象透传 → 上游 11101 拒绝）
    if (!rawMode && !isAnthropicPath && !responsesMode) {
      const q = applyOpenAIQuirks(outBody, provider);
      outBody = q.body;
      needAggregate = q.needAggregate;
    }
    // 2026-09-17 优化（P2）：该家已"学会"需要 thinking 回传 → **首次请求就补齐**，
    // 不再先打一次注定失败的 400/500（实测当天 13 次白打上游，失败调用通常照样计费）。
    if (!rawMode && isAnthropicPath && thinkingPassbackProviders.has(provider.id)) {
      const pre = withThinkingPlaceholders(outBody);
      if (pre) {
        outBody = pre.body;
        log(`upstream ${provider.id}（已学习）预先补齐 ${pre.repaired} 处空占位 thinking 块，省掉一次失败往返`);
      }
    }
    // raw 模式不带 body：显式传 undefined，避免 fetch 在没有 content-length 时挂起等待请求体
    init = { method, headers: upstreamHeaders, signal: controller.signal };
    if (!rawMode) init.body = JSON.stringify(outBody);
    upstream = await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, init);
    clearTimeout(timer);
    // R9c 自适应降敏：上游内容拦截（sensitive words / content-blocked）时，用降敏后的
    // 消息体**重试一次**（换新连接；历史里的 32+ 位技术串占位符化后不再命中平台
    // "疑似密钥"过滤）。重试成功则继续走正常流式转发；仍失败则按原逻辑处理。
    if (!rawMode && !upstream.ok) {
      firstDetail = await readTextWithTimeout(upstream, 5000, 500);
      if (CONTENT_BLOCK_RE.test(firstDetail)) {
        const deBody = responsesMode ? desensitizeResponsesBody(outBody) : desensitizeBodyMessages(outBody);
        if (deBody !== outBody) {
          log(`upstream ${provider.id} 内容拦截，已降敏重试一次…`);
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), timeoutMs);
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
      } else if (isAnthropicPath
        && (THINKING_PASSBACK_RE.test(firstDetail) || THINKING_REJECTED_GENERIC_RE.test(firstDetail))) {
        // Anthropic 协议专属：上游要求"带 tool_use 的 assistant 轮必须回传 thinking 块"。
        // 客户端没开 allowEmptySignature 时会把无签名的 thinking 降级成 text → 上游只看到
        // text+tool_use → 报错。这里补空占位块重试一次（实测上游只做结构检查，空占位即可通过）。
        // 两种上游措辞：明确点名 thinking 的 400；以及 agentrouter 的笼统 500
        // "Upstream rejected the request as invalid"（同一规则，实测补位后即 200）。
        // 笼统措辞下**只有确实存在可补位轮次时才重试**（fix 非空），避免无谓重发。
        const fix = withThinkingPlaceholders(body);
        if (fix) {
          thinkingPassbackProviders.add(provider.id);   // 学习：后续请求首次就带上（见文件顶部说明）
          log(`upstream ${provider.id} 要求 thinking 回传（HTTP ${upstream.status}）`
            + ` → 补齐 ${fix.repaired} 处空占位 thinking 块后重试一次（已记住该家需求）`);
          const c3 = new AbortController();
          const t3 = setTimeout(() => c3.abort(), timeoutMs);
          try {
            const retried = await fetch(`${upstreamBase(provider.baseURL)}${upstreamPath}`, {
              method: 'POST',
              headers: upstreamHeaders,
              body: JSON.stringify(fix.body),
              signal: c3.signal,
            });
            upstream = retried;
            firstDetail = null;   // 换了新响应，detail 需重读
          } catch (e) {
            // 重试本身失败：保留原始 4xx 响应与已读到的 detail，走下面的既有判定
            log(`upstream ${provider.id} thinking 占位重试失败: ${e.message}`);
          } finally {
            clearTimeout(t3);
          }
        }
      }
    }
  } catch (e) {
    clearTimeout(timer);
    // 2026-09-16 修复（日志可诊断性）：undici 的网络层错误 message 恒为 "fetch failed"，
    // 真正的原因在 e.cause（ECONNRESET / ENOTFOUND / UND_ERR_SOCKET / 代理连接失败…）。
    // 旧实现只记 e.message → 一整天 170 条 "fetch failed" 完全无法定位（实测根因是本机
    // Clash TUN 的 TLS 被重置，日志里看不出来）。现在把 cause 链一并落盘。
    const causeText = describeFetchError(e);
    // 2026-09-16 修复（瞬时网络错重试）：实测 clash/代理节点抖动会让**单次**请求
    // ECONNRESET（5s 内失败），而同一家下一次就好。旧实现首次失败即 90s 熔断 ——
    // 单候选模型（如 deepseek-v4.1-flash → chiyi-ds）会因此整段不可用 1.5 分钟。
    // 现在：**仅对"快速失败的网络层错误"重试一次**（本地超时中止不重试，否则白白翻倍等待）。
    const elapsed = Date.now() - startedAt;
    const upstreamUrl = `${upstreamBase(provider.baseURL)}${upstreamPath}`;
    if (isTransientNetError(e) && elapsed < NET_RETRY_MAX_ELAPSED_MS) {
      log(`upstream ${provider.id} 网络错误（${causeText}，${elapsed}ms）→ 原地重试一次`);
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), providerTimeoutMs(provider));
      try {
        const retried = await fetch(upstreamUrl, {
          ...init,
          signal: c2.signal,
        });
        upstream = retried;
        log(`upstream ${provider.id} 重试成功（网络抖动已恢复）`);
      } catch (e2) {
        log(`upstream ${provider.id} 重试仍失败：${describeFetchError(e2)}`);
      } finally {
        clearTimeout(t2);
      }
    }
    if (!upstream) {
      // R3 防封：失败冷却而非立即删缓存（防每个请求都重试上游形成风暴）
      catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
      breakerRecordFail(provider.id, 0);   // V2：网络错误 → 短熔断
      log(`upstream ${provider.id} request error: ${e.message}${causeText ? ' (' + causeText + ')' : ''}${proxyHintFor(upstreamUrl, causeText)}`);
      return rawMode ? { retryable: 0 } : false;
    }
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
    // 账户池（2026-09-16）：把状态码与错误体回传给包装函数，由它判定"该换账户还是换供应商"
    if (opts && opts.failureSink) {
      opts.failureSink.status = upstream.status;
      opts.failureSink.detail = detail;
    }
    // 账户池场景（opts.accountScoped）：额度耗尽 / 会话失效 / 限流属于**账户**问题，不是供应商问题 ——
    // 直接交回账户池换账户，**不计供应商熔断**（否则第一次额度耗尽就会把整家熔断 30 分钟，
    // 换账户的重试会被 breakerAcquire 挡在门外 → 客户端拿到 503，账户池形同虚设）。
    if (opts && opts.accountScoped) {
      const acctKind = classifyAccountFailure(upstream.status, detail);
      if (acctKind) {
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为账户级失败（${acctKind}）→ 交回账户池处理（不计供应商熔断）`);
        return rawMode ? { retryable: upstream.status } : false;
      }
    }
    const contentBlocked = CONTENT_BLOCK_RE.test(detail);
    // R8：上游内容拦截时，把触发请求的"结构摘要"落盘（不含明文 key、不含原文前缀），
    // 用于定位是什么特征触发了上游过滤（sensitive words / content-blocked）。
    // 审计修复（P3，本次）：受 env 开关控制（缺省不落盘）+ 目录保留上限，见 writeBlockedDump。
    if (contentBlocked && !rawMode) writeBlockedDump(provider, upstream.status, body);
    if (upstream.status === 401 || upstream.status === 403 || upstream.status === 429 || upstream.status >= 500) {
      // likely stale/misconfigured key, rate-limited, or dead endpoint —— 冷却缓存，防风暴（R3）
      // R25：429（限流）计入熔断——不熔断会加剧限流；短熔断（90s）已足够退避
      catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
      breakerRecordFail(provider.id, upstream.status);   // V2：按状态码分级熔断（401/403 → 30 分钟）
      // raw 模式（资源子路由）：这不是"资源不存在"而是"这家上游暂时不可用"，
      // 把状态码带回去让调用方回 502，避免误导客户端以为 response 已被删除
      return rawMode ? { retryable: upstream.status } : false;
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
        const routeMissing = ROUTE_MISSING_RE.test(detail);
        log(`upstream ${provider.id} HTTP 404（未见"模型不存在"特征，按路由不存在处理）→ 继续 failover`);
        // raw 模式（Responses 资源子路由）：把"整条路由没实现"与"资源不存在"的区别带回调用方，
        // 让它能给客户端一句能照着排查的提示（实测 new-api 对 GET/DELETE/cancel 回 Invalid URL）
        return rawMode ? { notFound: true, routeMissing } : false;
      }
      // 2026-09-15 实测修复：**供应商侧 4xx（账号/额度/权限/套餐）不属于"请求本身有错"**——
      // 实测 b.ai 余额为 0 时回 HTTP 400 `credit insufficient balance: balance=0`，旧实现
      // 把它当确定性错误终止 failover，用户明明还有可用的 chiyi-ds 却直接失败（且客户端被告知
      // "请求无效"，排查方向全错）。现在按"这家暂时不能服务"处理：冷却 + 熔断 + 继续换下一家，
      // 与 401/403 同类（余额/欠费类状态在充值前不会自愈 → 长熔断，避免反复打点）。
      if (PROVIDER_SIDE_4XX_RE.test(detail)) {
        const persistent = PERSISTENT_ACCOUNT_RE.test(detail);
        log(`upstream ${provider.id} HTTP ${upstream.status} 判定为"供应商账号/额度/权限"类错误`
          + `（${persistent ? '长期状态' : '临时'}）→ 冷却该家并继续 failover`);
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, persistent ? 403 : 0);   // 403 → 长熔断（30 分钟）；0 → 短熔断
        return rawMode ? { retryable: upstream.status } : false;
      }
      const status = DETERMINISTIC_4XX_STATUS[upstream.status] || 400;
      log(`upstream ${provider.id} 确定性 4xx HTTP ${upstream.status} → 终止 failover（回 ${status}，不回显上游原文）`);
      return { stop: { status, upstreamStatus: upstream.status } };
    }
    log(`upstream ${provider.id} HTTP ${upstream.status} 判定为内容拦截 → 继续 failover（换供应商/降敏）`);
    return false;
  }
  breakerRecordSuccess(provider.id);   // V1：成功清零熔断计数
  const bodyStream = upstream.body;
  const ctype = String(upstream.headers.get('content-type') || 'application/json');
  // —— SSE「首事件就是错误」识别（2026-09-15 实测事故）——
  // 部分上游（实测 api.chiyi.cc）对失败的请求回 **HTTP 200 + text/event-stream**，流里第一件事
  // 就是 `event: error` + `data: {"error":{"message":"Service temporarily unavailable",...}}`。
  // 旧实现按"成功"直接透传：日志记 status=ok（说谎）、不计熔断、不 failover，客户端拿到的是
  // **上游的错误原文**（用户看到的那句就是这个）。
  // 现在：写响应头之前先偷看首个 SSE 事件——若它是 error，就当作该供应商失败（冷却+熔断+换下一家）。
  // 关键点：此时**还没向客户端写任何字节**，所以 failover 是安全的（客户端最终收到的是
  // 下一家的正常流，或全部失败时网关自己的 503 文案）。
  let pendingHead = null;   // 偷看得到的首事件字节（未判失败时原样补发给客户端）
  if (bodyStream && /event-stream/i.test(ctype)) {
    try {
      const peekReader = bodyStream.getReader();
      const chunks = [];
      let total = 0;
      while (total < 8192) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await peekReader.read();
        if (done) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        total += buf.length;
        const txt = Buffer.concat(chunks).toString('utf8');
        if (/\n\n|\r\n\r\n/.test(txt)) break;   // 首个事件已完整
      }
      const head = Buffer.concat(chunks).toString('utf8');
      pendingHead = Buffer.concat(chunks);
      const hasRealEvent = /event:\s*(message_start|content_block_start|content_block_delta|response\.created|response\.in_progress|response\.output_item)/i.test(head)
        || /"type"\s*:\s*"(message_start|content_block_start|response\.created)"/.test(head);
      const looksError = !hasRealEvent && (/event:\s*error/i.test(head) || /"type"\s*:\s*"error"/.test(head.slice(0, 2048)));
      if (looksError) {
        const detail = head.replace(/\s+/g, ' ').slice(0, 200);
        log(`upstream ${provider.id} HTTP 200 但 SSE 首事件是错误 → 判定该家失败并换下一家：${maskSecrets(detail)}`);
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, 0);   // 短熔断（连续 3 次 / 或半开探测失败）
        try { await peekReader.cancel(); } catch { /* 忽略 */ }
        return rawMode ? { retryable: 0 } : false;
      }
      peekReader.releaseLock();   // 未判失败：把流交回下面的正常消费路径
    } catch (peekErr) {
      log(`upstream ${provider.id} 首事件偷看失败（按正常流继续）：${peekErr && peekErr.message}`);
      pendingHead = null;
    }
  }
  // 上游被强制流式、而客户端要非流式 → 聚合后回单条 JSON（2026-09-16：直通路径补齐 quirk 语义）
  if (needAggregate && bodyStream && /event-stream/i.test(ctype)) {
    const completion = await aggregateOpenAIStream(upstream, pendingHead);
    if (res.destroyed || res.writableEnded) return false;
    json(res, 200, completion);
    return true;
  }
  // success: stream through
  try {
    res.writeHead(upstream.status, {
      'content-type': ctype,
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
  } catch (writeHeadErr) {
    log(`client disconnected before headers: ${writeHeadErr.message}`);
    try { await upstream.body?.cancel(); } catch { }
    res.destroy();
    return false;
  }
  if (pendingHead && pendingHead.length) {
    // 偷看过的首事件原样补发（客户端不该察觉这一步）
    if (opts && typeof opts.onSniff === 'function') {
      try { opts.onSniff(pendingHead.toString('utf8')); } catch { /* 忽略 */ }
    }
    try { res.write(pendingHead); } catch { /* 客户端可能已断开，下面循环会兜住 */ }
  }
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
    // Responses 亲和性：从响应字节里嗅探 response.id（JSON 与 SSE 都含 "id":"resp_…"），
    // 只嗅探头部有限字节，取到即停（回调返回 true）。绝不影响转发本身。
    let sniff = (opts && typeof opts.onSniff === 'function') ? { fn: opts.onSniff, text: '' } : null;
    const SNIFF_MAX = 8192;
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
        if (sniff) {
          try {
            sniff.text += Buffer.from(value).toString('utf8');
            if (sniff.fn(sniff.text) === true || sniff.text.length >= SNIFF_MAX) sniff = null;
          } catch { sniff = null; }   // 嗅探失败绝不影响转发
        }
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

/* ================= 协议翻译：Anthropic ↔ OpenAI（2026-09-16） =================
 * 用途：客户端（dsh，clientProfile=claude）说 Anthropic 协议，而部分上游只会 OpenAI chat
 *（WorkBuddy 的 /v2/chat/completions；sensenova 也是——它此前每次 401，正是因为网关把
 * /v1/messages 原样转给了只认 OpenAI 路径的上游）。
 * 声明方式：供应商配置 `"protocol": "openai-chat"` —— 只影响该供应商，其它家不变。
 */

/** Anthropic content 块数组 → OpenAI content 部分（text / image_url） */
function anthropicPartsToOpenAI(content) {
  const parts = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source && typeof b.source === 'object') {
      const src = b.source;
      const url = src.type === 'base64'
        ? `data:${src.media_type || 'image/png'};base64,${src.data || ''}`
        : (typeof src.url === 'string' ? src.url : '');
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return parts;
}

/** tool_result 的 content（字符串 / 块数组）→ 纯文本 */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
  }
  return '';
}

/**
 * Anthropic Messages 请求体 → OpenAI chat/completions 请求体。
 * 覆盖：system、多模态 content、tool_use/tool_result ↔ tool_calls/role:tool、tools、tool_choice、
 * stop_sequences、thinking(budget)→reasoning_effort（再交由 translateBody 按家映射档位）。
 */
function anthropicToOpenAIRequest(body, provider) {
  const messages = [];
  // 2026-09-16 防御：历史里若存在**名字为空的 tool_use**（修复前产生的坏数据、或上游协议异常），
  // 原样回传会让上游 400（`tool_calls[].function.name` 非法）→ 之后每一轮都被打死。
  // 这里把这类 tool_use 连同它对应的 tool_result 一起丢弃（保留其余历史），并记一条日志。
  const droppedToolIds = new Set();
  let droppedCount = 0;
  const sysText = typeof body.system === 'string'
    ? body.system
    : (Array.isArray(body.system) ? body.system.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '');
  if (sysText.trim()) messages.push({ role: 'system', content: sysText });

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = msg.content;
    if (typeof content === 'string') { messages.push({ role, content }); continue; }
    if (!Array.isArray(content)) continue;

    if (role === 'assistant') {
      const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      const calls = [];
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue;
        const name = String(b.name || '').trim();
        if (!name) {   // 空名工具调用：丢弃（连它的 tool_result 一起），否则整轮 400
          if (b.id) droppedToolIds.add(String(b.id));
          droppedCount++;
          continue;
        }
        calls.push({
          id: String(b.id || 'call_' + Math.random().toString(36).slice(2, 10)),
          type: 'function',
          function: { name, arguments: JSON.stringify(b.input === undefined ? {} : b.input) },
        });
      }
      const out = { role: 'assistant', content: text === '' && calls.length ? null : text };
      if (calls.length) out.tool_calls = calls;
      if (calls.length || text !== '') messages.push(out);
      continue;
    }
    // user：tool_result 必须拆成独立的 role:'tool' 消息（顺序要紧：紧跟发起调用的 assistant 轮）
    for (const b of content) {
      if (b && b.type === 'tool_result') {
        if (droppedToolIds.has(String(b.tool_use_id || ''))) continue;   // 对应的 tool_use 已被丢弃 → 不留孤儿子消息
        messages.push({
          role: 'tool',
          tool_call_id: String(b.tool_use_id || ''),
          content: toolResultText(b.content),
        });
      }
    }
    const parts = anthropicPartsToOpenAI(content);
    if (parts.length) {
      messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    }
  }

  const out = {
    model: body.model,
    max_tokens: body.max_tokens,
    messages,
  };
  if (droppedCount) {
    // 去重（2026-09-17）：同一段坏历史会在**每个请求**上重复命中（实测 165 行/天，淹没有效日志）。
    // 丢弃行为不受影响，只是告警改成"首次 + 每 100 次汇总一行"。
    emptyToolUseDropHits += 1;
    if (emptyToolUseDropHits === 1 || emptyToolUseDropHits % 100 === 0) {
      log(`翻译告警：历史里有 ${droppedCount} 个**名字为空**的 tool_use（及其 tool_result）已丢弃——`
        + `否则回传给上游会 400（该轮可能由此前版本的空名 bug 产生）；本进程累计命中 ${emptyToolUseDropHits} 次请求`
        + `${emptyToolUseDropHits === 1 ? '' : '（同类告警已静默，每 100 次汇总一行）'}`);
    }
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: String(t && t.name || ''),
        ...(t && t.description ? { description: String(t.description) } : {}),
        parameters: (t && t.input_schema) || { type: 'object', properties: {} },
      },
    }));
  }
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    const tc = body.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: String(tc.name) } };
  }
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  // thinking(budget_tokens) → reasoning_effort 粗映射；再由 translateBody 按 provider.reasoningEffortMap 归一
  const th = body.thinking;
  if (th && typeof th === 'object' && th.type !== 'disabled') {
    const budget = Number(th.budget_tokens) || 0;
    out.reasoning_effort = budget >= 16384 ? 'max' : budget >= 8192 ? 'high' : budget >= 2048 ? 'medium' : 'low';
  }
  return out;
}

/** Anthropic stop_reason 映射（OpenAI finish_reason → Anthropic） */
function stopReasonFromFinish(finish) {
  switch (String(finish || '').toLowerCase()) {
    case 'tool_calls': case 'function_call': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'refusal';
    default: return 'end_turn';
  }
}

/** 粗略 token 估算（上游不给 usage 时兜底：约 4 字符/token）——好过报 0 让客户端以为上下文为空 */
const estimateTokens = (s) => Math.max(1, Math.ceil(String(s || '').length / 4));

/** OpenAI 非流式响应 → Anthropic message */
function openaiToAnthropicMessage(json, model, fallbackInTokens) {
  const choice = (json && Array.isArray(json.choices) ? json.choices[0] : null) || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: '' });
  }
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    let input = {};
    try { input = JSON.parse((call.function && call.function.arguments) || '{}'); } catch { input = {}; }
    content.push({
      type: 'tool_use',
      id: String(call.id || 'call_' + Math.random().toString(36).slice(2, 10)),
      name: String((call.function && call.function.name) || ''),
      input,
    });
  }
  const usage = json && json.usage ? json.usage : {};
  const inTok = Number(usage.prompt_tokens) > 0 ? Number(usage.prompt_tokens) : (fallbackInTokens || 0);
  const outTok = Number(usage.completion_tokens) > 0
    ? Number(usage.completion_tokens)
    : estimateTokens(content.map((c) => c.text || c.thinking || JSON.stringify(c.input || '')).join(''));
  return {
    id: (json && json.id) || ('msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)),
    type: 'message',
    role: 'assistant',
    model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: stopReasonFromFinish(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

/** 写一个 Anthropic SSE 事件 */
function sseWrite(res, type, payload) {
  try {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch { /* 客户端已断开：由调用方的写失败检查兜住 */ }
}

/**
 * OpenAI SSE → Anthropic SSE 流翻译。
 * 逐块解析 `data: {...}`，把 delta.content / delta.reasoning_content / delta.tool_calls 映射成
 * Anthropic 的 content_block_start/delta/stop 事件序列。
 * @param {object} o { res, upstream, model, inputTokens, onDone }
 * @returns {Promise<{ok:boolean, usage?:object, text?:string}>} 聚合结果（非流式客户端用它拼完整消息）
 */
async function translateOpenAIStreamToAnthropic({ res, upstream, model, inputTokens, aggregateOnly, headBytes }) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let started = false;
  let blockIndex = -1;          // 当前打开的 content block 下标
  let openKind = null;          // 'text' | 'thinking' | 'tool_use'
  let finished = false;
  let stopReason = 'end_turn';
  let outText = '';
  let outThinking = '';
  const toolCalls = new Map();  // index → { id, name, args }
  let usage = null;

  const startBlock = (kind, block) => {
    blockIndex++;
    openKind = kind;
    if (!aggregateOnly) {
      sseWrite(res, 'content_block_start', { type: 'content_block_start', index: blockIndex, content_block: block });
    }
  };
  const closeBlock = () => {
    if (openKind === null) return;
    if (!aggregateOnly) sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    openKind = null;
  };
  const ensureStart = () => {
    if (started) return;
    started = true;
    if (!aggregateOnly) {
      sseWrite(res, 'message_start', {
        type: 'message_start',
        message: {
          id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: inputTokens || 0, output_tokens: 0 },
        },
      });
    }
  };

  const handleChunk = (json) => {
    ensureStart();
    if (json && json.usage && (json.usage.prompt_tokens || json.usage.completion_tokens)) usage = json.usage;
    const choice = (Array.isArray(json.choices) ? json.choices[0] : null) || {};
    const delta = choice.delta || {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (openKind !== 'thinking') { closeBlock(); startBlock('thinking', { type: 'thinking', thinking: '' }); }
      outThinking += delta.reasoning_content;
      if (!aggregateOnly) {
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
      }
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (openKind !== 'text') { closeBlock(); startBlock('text', { type: 'text', text: '' }); }
      outText += delta.content;
      if (!aggregateOnly) {
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } });
      }
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const idx = Number.isInteger(call.index) ? call.index : 0;
      let entry = toolCalls.get(idx);
      if (!entry) {
        // 关键（2026-09-16 真实事故回归）：**不要立刻开块**——很多上游先发 id、名字在后续分片才到；
        // 若此时开块，客户端记录到的 tool_use 名字就是空串（pi-ai 只认 content_block_start 里的 name），
        // 表现为 `unknown tool ""`，下一轮再把空名工具回传 → 上游 400 打死整轮。
        // 现在：先缓冲 id/名字/参数，**拿到非空名字才开块**，并一次性补发已缓冲的参数分片。
        entry = { id: call.id || ('call_' + Math.random().toString(36).slice(2, 10)), name: '', args: '', started: false, sent: 0 };
        toolCalls.set(idx, entry);
      }
      if (call.id) entry.id = call.id;
      if (call.function && typeof call.function.name === 'string' && call.function.name) entry.name = call.function.name;
      const frag = (call.function && call.function.arguments) || '';
      if (frag) entry.args += frag;
      if (!entry.started && entry.name) {
        closeBlock();
        startBlock('tool_use', { type: 'tool_use', id: entry.id, name: entry.name, input: {} });
        entry.started = true;
        if (entry.args) {   // 名字到达前缓冲的参数分片在此一次性补发（不能丢）
          if (!aggregateOnly) {
            sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: entry.args } });
          }
          entry.sent = entry.args.length;
        }
      } else if (entry.started && entry.args.length > entry.sent) {
        const chunkText = entry.args.slice(entry.sent);
        entry.sent = entry.args.length;
        if (!aggregateOnly) {
          sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: chunkText } });
        }
      }
    }
    if (choice.finish_reason) { stopReason = stopReasonFromFinish(choice.finish_reason); finished = true; }
  };

  /** 流结束时仍未开块的工具调用（上游始终没给名字）：兜底开块并补发参数，绝不静默丢调用 */
  const flushPendingToolCalls = () => {
    for (const [idx, entry] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (entry.started) continue;
      if (!entry.name) log(`上游工具调用缺少 name（index=${idx}）→ 以空名透传（上游协议异常）`);
      closeBlock();
      startBlock('tool_use', { type: 'tool_use', id: entry.id, name: entry.name, input: {} });
      entry.started = true;
      if (entry.args && !aggregateOnly) {
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: entry.args } });
        entry.sent = entry.args.length;
      }
    }
  };

  let clientGone = false;
  const onClose = () => { clientGone = true; try { reader.cancel(); } catch { /* 忽略 */ } };
  try { res.once('close', onClose); } catch { /* 忽略 */ }
  // 把"行切分 + data: 解析"抽成闭包：偷看过的首事件字节（headBytes）先喂进来，再读流
  const feed = (text) => {
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      const m = /^data:\s*(.*)$/.exec(line);
      if (!m) continue;
      const payload = m[1].trim();
      if (payload === '[DONE]') { finished = true; continue; }
      try { handleChunk(JSON.parse(payload)); } catch { /* 非 JSON 心跳/注释：跳过 */ }
    }
  };
  try {
    if (headBytes && headBytes.length) feed(Buffer.from(headBytes).toString('utf8'));
    for (;;) {
      if (clientGone || res.destroyed || res.writableEnded) { try { await reader.cancel(); } catch { /* 忽略 */ } return { ok: false }; }
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    log(`流翻译读取失败：${e && e.message}`);
  } finally {
    try { res.removeListener('close', onClose); } catch { /* 忽略 */ }
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
  if (clientGone) return { ok: false };

  ensureStart();
  flushPendingToolCalls();   // 兜底：名字始终没到的调用也要开块（流式会写事件；聚合只补数据），绝不静默丢调用
  closeBlock();
  const outTok = usage && Number(usage.completion_tokens) > 0
    ? Number(usage.completion_tokens)
    : estimateTokens(outText + outThinking + [...toolCalls.values()].map((t) => t.args).join(''));
  if (!aggregateOnly) {
    sseWrite(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: toolCalls.size && stopReason === 'end_turn' ? 'tool_use' : stopReason, stop_sequence: null },
      usage: { output_tokens: outTok },
    });
    sseWrite(res, 'message_stop', { type: 'message_stop' });
    try { res.end(); } catch { /* 忽略 */ }
  }
  return {
    ok: true,
    usage: { input_tokens: (usage && Number(usage.prompt_tokens)) || inputTokens || 0, output_tokens: outTok },
    stopReason: toolCalls.size && stopReason === 'end_turn' ? 'tool_use' : stopReason,
    text: outText,
    thinking: outThinking,
    toolCalls: [...toolCalls.values()],
    finished,
  };
}

/**
 * 把"Anthropic 协议的客户端请求"转发给"只支持 OpenAI chat 的上游"。
 * 返回值与 forward() 契约一致：true / false / {stop:{status,upstreamStatus}}。
 * 账户池：额度耗尽 / 会话失效 / 限流 → 换**同供应商的下一个账户**；全部不可用才交给下一家供应商。
 */
async function forwardAnthropicViaOpenAI(provider, upstreamBaseHeaders, body, res, opts) {
  if (!breakerAcquire(provider.id)) {
    log(`skip ${provider.id} (breaker: cooldown or half-open probe already in flight)`);
    return false;
  }
  const quirks = providerQuirks(provider);
  const wantsStream = !!body.stream;
  const picked = pickAccount(provider);
  if (picked.acct === null && picked.cooling > 0) {
    log(`provider ${provider.id}: ${picked.cooling} 个账户全部冷却中 → 交给下一家`);
    return false;
  }
  const attemptAccounts = picked.acct ? [picked.acct, ...picked.accounts.filter((a) => a !== picked.acct && accountUsable(provider.id, a))] : [null];
  const upstreamPath = '/chat/completions';
  let lastDetail = '';
  let lastStatus = 0;

  for (const acct of attemptAccounts) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), providerTimeoutMs(provider));
    let headers;
    try {
      // 与直通路径共用同一套账户头构造（凭据 / 身份头 / Bearer / 自定义头，避免两处漂移）
      headers = await accountUpstreamHeaders(provider, acct, upstreamBaseHeaders, { anthropicUpstream: false });
    } catch (e) {
      log(`provider ${provider.id} 凭据不可用（${acct ? acct.id : '-'}）：${e && e.message}`);
      if (acct) { clearTimeout(timer); markAccountFailure(provider.id, acct, 'session', e && e.message); continue; }
      clearTimeout(timer);
      breakerRecordFail(provider.id, 401);
      return false;
    }

    const openaiBody = anthropicToOpenAIRequest(body, provider);
    if (quirks.has('force-stream')) openaiBody.stream = true;
    else openaiBody.stream = wantsStream;
    if (quirks.has('stringify-tool-choice') && openaiBody.tool_choice && typeof openaiBody.tool_choice === 'object') {
      openaiBody.tool_choice = (openaiBody.tool_choice.function && openaiBody.tool_choice.function.name) || 'auto';
    }
    if (quirks.has('prepend-system') && Array.isArray(openaiBody.messages)
      && !(openaiBody.messages[0] && openaiBody.messages[0].role === 'system')) {
      openaiBody.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
    }
    // 复用 OpenAI 路径的角色/推理档位归一（developer→system、reasoning_effort 按家映射）
    const finalBody = translateBody(openaiBody, provider);

    let upstream = null;
    const upstreamUrl = `${upstreamBase(provider.baseURL)}${upstreamPath}`;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST', headers, body: JSON.stringify(finalBody), signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const causeText = describeFetchError(e);
      const elapsed = Date.now() - startedAt;
      if (isTransientNetError(e) && elapsed < NET_RETRY_MAX_ELAPSED_MS) {
        log(`upstream ${provider.id} 网络错误（${causeText}，${elapsed}ms）→ 原地重试一次`);
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), providerTimeoutMs(provider));
        try {
          upstream = await fetch(upstreamUrl, {
            method: 'POST', headers, body: JSON.stringify(finalBody), signal: c2.signal,
          });
        } catch (e2) {
          log(`upstream ${provider.id} 重试仍失败：${describeFetchError(e2)}`);
        } finally { clearTimeout(t2); }
      }
      if (!upstream) {
        log(`upstream ${provider.id} request error: ${e.message}${causeText ? ' (' + causeText + ')' : ''}${proxyHintFor(upstreamUrl, causeText)}`);
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, 0);
        return false;
      }
    }
    clearTimeout(timer);

    if (!upstream.ok) {
      lastStatus = upstream.status;
      lastDetail = await readTextWithTimeout(upstream, 5000, 500);
      log(`upstream ${provider.id} HTTP ${upstream.status}: ${maskSecrets(lastDetail)}`);
      const acctKind = acct ? classifyAccountFailure(upstream.status, lastDetail) : null;
      if (acctKind) {
        markAccountFailure(provider.id, acct, acctKind, lastDetail);
        continue;   // 换下一个账户（此时尚未向客户端写任何字节）
      }
      if (upstream.status === 401 || upstream.status === 403 || upstream.status === 429 || upstream.status >= 500) {
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, upstream.status);
        return false;
      }
      breakerRecordSuccess(provider.id);
      if (PROVIDER_SIDE_4XX_RE.test(lastDetail)) {
        catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
        breakerRecordFail(provider.id, PERSISTENT_ACCOUNT_RE.test(lastDetail) ? 403 : 0);
        return false;
      }
      const status = DETERMINISTIC_4XX_STATUS[upstream.status] || 400;
      log(`upstream ${provider.id} 确定性 4xx HTTP ${upstream.status} → 终止 failover（回 ${status}，不回显上游原文）`);
      return { stop: { status, upstreamStatus: upstream.status } };
    }

    // 成功：OpenAI 响应 → Anthropic
    if (acct) markAccountOk(provider.id, acct);
    breakerRecordSuccess(provider.id);
    const ctype = String(upstream.headers.get('content-type') || '');
    const inputTokens = estimateTokens(JSON.stringify(finalBody.messages || []));
    try {
      if (/event-stream/i.test(ctype)) {
        // —— SSE「首事件就是 error」识别（2026-09-16，与 forward() 同规则）——
        // 实测部分上游/中转对失败请求回 HTTP 200 + text/event-stream，流里第一件事就是
        // `data: {"error":…}`（chiyi-ds 形态）。若不识别就按成功往客户端写头，客户端会拿到
        // 一条**空回复**而不是"换下一家"。这里在写响应头之前偷看首个事件：是错误就当作该家失败，
        // 依账户池/供应商顺序继续；此时尚未向客户端写任何字节，failover 是安全的。
        let headBytes = null;
        try {
          const peekReader = upstream.body.getReader();
          const chunks = [];
          let total = 0;
          while (total < 8192) {
            // eslint-disable-next-line no-await-in-loop
            const { done, value } = await peekReader.read();
            if (done) break;
            const buf = Buffer.from(value);
            chunks.push(buf);
            total += buf.length;
            if (/\n\n|\r\n\r\n/.test(Buffer.concat(chunks).toString('utf8'))) break;
          }
          headBytes = Buffer.concat(chunks);
          const head = headBytes.toString('utf8');
          const looksError = /"error"\s*:/.test(head) && !/"choices"\s*:/.test(head);
          if (looksError) {
            const detail = head.replace(/\s+/g, ' ').slice(0, 200);
            log(`upstream ${provider.id} HTTP 200 但 SSE 首事件是错误 → 判定该家失败并换下一家：${maskSecrets(detail)}`);
            const kind = acct ? classifyAccountFailure(200, detail) || classifyAccountFailure(402, detail) : null;
            if (acct && kind) { markAccountFailure(provider.id, acct, kind, detail); }
            catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
            breakerRecordFail(provider.id, 0);
            try { await peekReader.cancel(); } catch { /* 忽略 */ }
            return false;   // 未写任何字节 → 交给账户池/下一家供应商
          }
          peekReader.releaseLock();
        } catch (peekErr) {
          log(`上游首事件偷看失败（按正常流继续）：${peekErr && peekErr.message}`);
          headBytes = null;
        }
        if (wantsStream && !opts?.aggregateOnly) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            'access-control-allow-origin': '*',
          });
          const r = await translateOpenAIStreamToAnthropic({ res, upstream, model: body.model, inputTokens, aggregateOnly: false, headBytes });
          return r.ok ? true : false;
        }
        // 客户端要非流式（或下游是 Responses 聚合）：把流收完再回一条完整 message
        const agg = await translateOpenAIStreamToAnthropic({ res, upstream, model: body.model, inputTokens, aggregateOnly: true, headBytes });
        if (!agg.ok) return false;
        const content = [];
        if (agg.thinking) content.push({ type: 'thinking', thinking: agg.thinking, signature: '' });
        if (agg.text) content.push({ type: 'text', text: agg.text });
        for (const t of agg.toolCalls || []) {
          let input = {};
          try { input = JSON.parse(t.args || '{}'); } catch { input = {}; }
          content.push({ type: 'tool_use', id: t.id, name: t.name, input });
        }
        json(res, 200, {
          id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'message', role: 'assistant', model: body.model,
          content: content.length ? content : [{ type: 'text', text: '' }],
          stop_reason: agg.stopReason, stop_sequence: null,
          usage: agg.usage,
        });
        return true;
      }
      const text = await readTextWithTimeout(upstream, 30_000, 4 * 1024 * 1024);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* 非 JSON：按失败处理 */ }
      if (!parsed) {
        log(`upstream ${provider.id} 非 JSON 响应（anthropic→openai 翻译路径）`);
        return false;
      }
      json(res, 200, openaiToAnthropicMessage(parsed, body.model, inputTokens));
      return true;
    } catch (e) {
      log(`anthropic→openai 响应翻译失败：${e && e.message}`);
      if (!res.headersSent) return false;
      try { res.destroy(); } catch { /* 忽略 */ }
      return false;
    }
  }
  // 所有账户都不行：把最后一次的失败按供应商级处理
  log(`provider ${provider.id} 全部账户不可用（最后 HTTP ${lastStatus}）：${maskSecrets(lastDetail).slice(0, 160)}`);
  if (lastStatus === 401 || lastStatus === 403 || lastStatus === 429 || lastStatus >= 500) {
    catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
    breakerRecordFail(provider.id, lastStatus);
  }
  return false;
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
    // Responses 协议（tag='responses'）没有 messages：input 才是"消息"（字符串 / item 数组）
    const items = Array.isArray(body && body.input) ? body.input
      : (Array.isArray(body && body.messages) ? body.messages : null);
    // 完整请求体（脱敏后落盘，供逐字节对比/取证——明文 key/长串经 maskSecretTokens 打码）
    if (process.env.DSH_GATEWAY_DUMP_FULL === '1' && body && (body.messages || body.input)) {
      const sanitized = { ...body };
      if (typeof sanitized.instructions === 'string') sanitized.instructions = maskSecretTokens(sanitized.instructions);
      if (typeof body.input === 'string') {
        sanitized.input = maskSecretTokens(body.input);
      } else if (Array.isArray(body.input)) {
        sanitized.input = body.input.map((it) => {
          if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
          const n = { ...it };
          if (typeof n.content === 'string') n.content = maskSecretTokens(n.content);
          if (Array.isArray(n.content)) {
            n.content = n.content.map((b) =>
              (b && typeof b.text === 'string') ? { ...b, text: maskSecretTokens(b.text) } : b);
          }
          if (typeof n.output === 'string') n.output = maskSecretTokens(n.output);
          if (n.arguments) n.arguments = '<arguments>';   // 不落工具参数细节
          return n;
        });
      }
      if (Array.isArray(body.messages)) {
        sanitized.messages = body.messages.map((m) => {
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
        });
      }
      const fullF = path.join(dir, 'full-' + Date.now() + '-' + tag + '.json');
      fs.writeFileSync(fullF, JSON.stringify(sanitized), 'utf8');
      log(`[dump] 完整请求体(脱敏) -> ${fullF} (${(items || []).length} 条消息)`);
    }
    const digest = {
      at: localStamp(),
      tag,
      model: body && body.model,
      stream: !!(body && body.stream),
      // R4：Responses 用 reasoning.effort 表达推理档位（chat 用 reasoning_effort/thinking）
      reasoning_effort: (body && body.reasoning_effort) ?? (body && body.reasoning && body.reasoning.effort),
      thinking: body && body.thinking,
      previous_response_id: body && body.previous_response_id,
      hasTools: Array.isArray(body && body.tools) ? body.tools.length : 0,
      msgCount: items ? items.length : 0,
      // R10：记录消息结构取证（roles 空说明 role 字段缺失/结构异常）
      msg0Keys: (items && items[0]) ? Object.keys(items[0]) : [],
      msg0Role: (items && items[0]) ? items[0].role : undefined,
      msg0ContentType: (items && items[0] && items[0].content) ? (Array.isArray(items[0].content) ? 'array:' + items[0].content.length : typeof items[0].content) : (items && items[0] && typeof items[0].output === 'string' ? 'output:string' : undefined),
      msg0Sample: (items && items[0] && typeof items[0].content === 'string')
        ? maskSecretTokens(items[0].content).slice(0, 80)   // 审计修复：样本先打码（旧版可能落真密钥前缀）
        : undefined,
      roles: items
        ? items.slice(0, 50).map((m) => (m && (m.role || m.type)) || '?').join(',')
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

async function handleCompletion(cfg, req, res, body, upstreamPath, opts) {
  const responsesMode = !!(opts && opts.responses);          // POST /v1/responses
  const search = (opts && opts.search) || '';                // 查询串原样带给上游（?api-version= 等）
  dumpBodyDigest(body, responsesMode ? 'responses' : 'chat');   // R8：诊断用（env 控制）
  const model = body && body.model;
  if (!model) return json(res, 400, { error: { message: 'model is required' } });
  const reqStart = Date.now();   // 调用计时（T1 调用日志）
  const client = req.socket?.remoteAddress || 'local';
  const stream = !!(body && body.stream);
  const logCall = (via, status) =>
    log(`[call] ${model} ${via} status=${status} stream=${stream ? 1 : 0} dur=${Date.now() - reqStart}ms from=${client}${responsesMode ? ' proto=responses' : ''}`);

  const candidates = providersForModel(cfg, model);
  if (candidates.length === 0) {
    return json(res, 404, { error: { message: `no providers configured for model "${model}"` } });
  }

  // 1) 候选收敛（**配置列表为唯一权威**，见 selectCandidates）：
  //    只为"一个模型都没配"的 provider 探测上游目录 —— 配置齐全时请求路径上零探测
  //    （旧版对每个候选都探测，实测每次请求要多等 ~1.5s；而且探测结果会把
  //     "目录里有但其实不能服务"的供应商拉进候选，正是 2026-09-15 事故的来源）。
  const catalogResults = await Promise.all(candidates.map((p) => (needsCatalog(p)
    ? fetchCatalog(p, false, cfg.clientUA, cfg.clientProfile)
    : null)));
  let { eligible, reasons, tierSizes } = selectCandidates(candidates, catalogResults, model);
  // 多模态（2026-09-16）：请求里带图片时，只保留声明了图片能力的候选
  //（否则会被路由到纯文本家，上游报错或图片被忽略）
  if (bodyHasImage(body)) {
    const vf = filterVisionCandidates(eligible, reasons, model);
    if (vf.dropped > 0) {
      log(`[route] ${model}: 请求含图片 → 跳过未声明图片能力的 ${vf.dropped} 家`);
      eligible = vf.eligible;
      reasons = vf.reasons;
    }
  }
  const reasonsText = routeReasonsText(reasons);
  // 选路决策日志（2026-09-15 加）：**每次请求都记**——"为什么发给了这家"必须能在日志里
  // 直接看到（此前只在失败时才记原因，用户遇到"该走 A 却走了 B"时无从判断）。
  log(`[route] ${model}: ${eligible.length} 个候选（配置声明 ${tierSizes[0]} / 未配置按目录兜底 ${tierSizes[1]}）｜${reasonsText}`);

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
  //  - 缺省 / "failover"：主备——固定从候选头开始尝试，失败切下一家（传统行为）；
  //    候选顺序 = priority 升序、同级按配置数组顺序（见 providersForModel）
  //  - "round-robin"：轮询——同一模型每次请求从不同起点开始，流量分摊到各家；失败同样切下一家
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
  // Responses 有状态：多轮请求（previous_response_id）必须回到持有该上下文的原供应商，
  // 否则上游不认识这个 id（404）或上下文丢失。命中亲和表 → 提到尝试序列最前（其余仍可 failover）。
  if (responsesMode && typeof body.previous_response_id === 'string' && body.previous_response_id) {
    const owner = affinityGet(body.previous_response_id);
    if (owner) {
      const i = tryOrder.findIndex((x) => x.id === owner);
      if (i > 0) {
        tryOrder = [tryOrder[i], ...tryOrder.slice(0, i), ...tryOrder.slice(i + 1)];
        log(`responses affinity: previous_response_id ${body.previous_response_id} → ${owner} 优先`);
      } else if (i < 0) {
        log(`responses affinity: previous_response_id 属于 ${owner}，但它不是 "${model}" 的候选 → 忽略`);
      }
    }
  }
  for (const p of tryOrder) {
    // 模型映射：把逻辑名换成该供应商的上游真实 ID（未声明映射 → 原样透传）
    const attemptBody = bodyForProvider(body, p, model);
    const upModel = attemptBody.model;
    log(`try ${p.id} for ${model}${upModel !== model ? ' → ' + upModel : ''}`);
    // 透传 dsh 原始请求标识（K1 防屏蔽）/ 仿真模式（V2: clientProfile）：clientHeaders = req.headers
    // Responses：记录 response.id → provider 亲和（后续 GET/DELETE/cancel/input_items 与多轮都靠它）
    let sniffed = false;
    const fwdOpts = responsesMode ? {
      responses: true,
      onSniff: (text) => {
        if (sniffed) return true;
        const id = sniffResponseId(text);
        if (!id) return false;
        sniffed = true;
        affinitySet(id, p.id);
        log(`responses affinity: ${id} → ${p.id}`);
        return true;
      },
    } : undefined;
    const out = await forwardWithAccounts(p, upstreamPath.replace(/^\/v1/, '') + search, passthroughHeaders(req.headers, p.apiKey, cfg.clientUA, cfg.clientProfile), attemptBody, res, fwdOpts);
    if (out === true) {
      log(`served ${model} via ${viaTag(p.id)}`);
      logCall(`via=${viaTag(p.id)}`, 'ok');
      return;
    }
    // 审计修复（P1，本次）：确定性 4xx → 立即终止 failover，按映射后的状态码回复客户端
    if (out && out.stop) {
      log(`failover stopped (${model} via ${p.id} HTTP ${out.stop.upstreamStatus} → ${out.stop.status})`);
      logCall(`via=${viaTag(p.id)}`, 'fail:' + out.stop.status);
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

/* ---------------- OpenAI Responses 协议：资源子路由（GET/DELETE/cancel/input_items） ----------------
 * Responses 是**有状态**协议：response 对象只存在于创建它的那家上游。客户端（Codex、OpenAI
 * SDK、dsh 的 responses 模式）在 POST 之后会用 response.id 继续操作：
 *   GET    /v1/responses/{id}               取回响应对象
 *   GET    /v1/responses/{id}/input_items   取回输入条目（分页 ?limit=&after=&order=）
 *   DELETE /v1/responses/{id}               删除
 *   POST   /v1/responses/{id}/cancel        取消进行中的响应
 * 旧版这些路径全部落到 `404 unsupported route`（网关只认 POST /v1/responses）——
 * 客户端表现为"会话无法恢复/取消无效"，而 Codex 这类客户端会真的用到它们。
 *
 * 路由规则：
 *   ① 亲和表命中（本进程创建过）→ 只发原供应商（唯一持有该资源的家）；失败不再猜别家；
 *   ② 未知 id（网关重启后、或别的实例创建）→ **只读**操作（GET/input_items）按 priority
 *      逐家试探：每家对不属于自己的 id 都回 404，换家无副作用；**写**操作（DELETE/cancel）
 *      不猜，直接 404——避免把删除/取消误发给无关供应商；
 *   ③ 查询串原样透传；上游 JSON 响应原样回传（含状态码）。
 */
async function handleResponsesResource(cfg, req, res, url, tail) {
  const segs = String(tail || '').split('/').filter((s) => s !== '');
  const rawId = segs[0] || '';
  const action = segs[1] || '';
  if (!rawId) return json(res, 404, { error: { message: `unsupported route ${url.pathname}` } });
  let id;
  try { id = decodeURIComponent(rawId); } catch { id = rawId; }   // 畸形百分号编码 → 原样
  const method = req.method;
  const base = '/responses/' + encodeURIComponent(id);
  let upstreamPath = null;
  if (method === 'GET' && !action) upstreamPath = base;
  else if (method === 'GET' && action === 'input_items') upstreamPath = base + '/input_items';
  else if (method === 'DELETE' && !action) upstreamPath = base;
  else if (method === 'POST' && action === 'cancel') upstreamPath = base + '/cancel';
  if (!upstreamPath) {
    return json(res, 404, { error: { message: `unsupported route ${url.pathname}` } });
  }
  // cancel 可能带 body（通常为空）：读完丢弃，避免 keep-alive 下未消费的请求体影响连接
  if (method === 'POST') {
    try { await bodyOf(req); } catch (e) { return replyBodyError(res, req, e, false); }
  }

  const readOnly = method === 'GET';
  // 候选供应商：与模型路由一致，按 priority 升序、同级按配置数组顺序（见 providersForModel）
  const enabled = (cfg.providers || []).filter((p) => p && p.enabled !== false);
  let targets = null;
  const owner = affinityGet(id);
  if (owner) {
    const p = enabled.find((x) => x.id === owner);
    if (p) targets = [p];
    else log(`responses ${method} ${id}: 亲和供应商 ${owner} 已不在配置中，改走探测`);
  }
  if (!targets) {
    if (!readOnly) {
      log(`responses ${method} ${id}: 未知 id 且为写操作 → 不试探供应商（避免误删/误取消别家资源）`);
      return json(res, 404, { error: {
        message: `response "${id}" is not known to this gateway instance; `
          + `refusing to guess which provider owns it for ${method} (re-create it via POST /v1/responses)`,
      } });
    }
    targets = enabled;
  }
  if (targets.length === 0) {
    return json(res, 404, { error: { message: 'no providers configured' } });
  }

  const reqStart = Date.now();
  const client = req.socket?.remoteAddress || 'local';
  const callLog = (via, status) =>
    log(`[call] responses ${method} ${id} ${via} status=${status} dur=${Date.now() - reqStart}ms from=${client} proto=responses`);
  const upPath = upstreamPath + (url.search || '');
  // 上游"故障"（≠ 资源不存在）：502=上游不可用/报错，503=熔断冷却中。
  // 关键点：不能回 404 —— 那等于告诉客户端"response 已被删除"（客户端会丢弃上下文）。
  let failStatus = 0;
  let upstreamNote = '';
  let sawNotFound = false;      // 上游确实回了 404（资源/路由不存在）
  let sawRouteMissing = false;  // 其中至少一家是"整条子路由没实现"（供应商能力缺失）
  for (const p of targets) {
    if (breakerIsOpen(p.id)) {
      log(`skip ${p.id} (breaker open)`);
      if (owner) { failStatus = 503; upstreamNote = 'provider in breaker cooldown'; }
      continue;
    }
    const out = await forward(p, upPath, passthroughHeaders(req.headers, p.apiKey, cfg.clientUA, cfg.clientProfile), null, res, { raw: true, method });
    if (out === true) {
      callLog(`via=${p.id}`, 'ok');
      return;
    }
    if (out && out.stop) {   // 确定性 4xx（400/413/422/404…）：请求本身有问题，不再换家
      callLog(`via=${p.id}`, 'fail:' + out.stop.status);
      // 注意：不能复用 stopFailoverMessage——那句文案是"模型"语境（model "…"），
      // 而这里的主语是 response 资源，照抄会把 response id 说成模型名，越看越糊涂。
      return json(res, out.stop.status, { error: {
        message: `provider "${p.id}" rejected ${method} /v1/responses/{id} with HTTP ${out.stop.upstreamStatus} — `
          + 'the request itself was rejected upstream (e.g. the response already completed / is not cancellable, '
          + 'or the provider validates this endpoint differently); see the gateway log for the upstream detail.',
      } });
    }
    if (out && out.notFound) {
      sawNotFound = true;
      if (out.routeMissing) sawRouteMissing = true;
    }
    if (out && out.retryable !== undefined) {
      failStatus = 502;
      upstreamNote = out.retryable ? 'upstream HTTP ' + out.retryable : 'upstream request failed';
    }
    if (res.headersSent || res.destroyed) { callLog('stream-broken', 'fail'); return; }
  }
  if (failStatus) {
    callLog(owner ? 'owner-unavailable' : 'probe-unavailable', 'fail:' + failStatus);
    return json(res, failStatus, { error: {
      message: `provider unavailable while handling response "${id}" (${upstreamNote}); the resource is not necessarily gone — retry shortly`,
    } });
  }
  callLog((owner ? 'owner-miss' : 'probe-miss') + (sawRouteMissing ? '/route-missing' : ''), 'fail');
  const ep = `${method} /v1/responses/{id}${upstreamPath.endsWith('/input_items') ? '/input_items' : (upstreamPath.endsWith('/cancel') ? '/cancel' : '')}`;
  const routeHint = sawRouteMissing
    ? ` — the provider does not implement the Responses resource endpoint "${ep}" `
      + '(many new-api/one-api style gateways only support response creation via POST /v1/responses); '
      + 'this is a provider capability limit, not a deletion'
    : (owner ? ` (owner ${owner} returned no such resource — it may have expired or been deleted)` : '');
  json(res, 404, { error: {
    message: `response "${id}" was not found on any configured provider` + routeHint,
  } });
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

  // 候选收敛（**配置列表为唯一权威**，见 selectCandidates）：只探测"没配模型"的 provider
  const catalogResults = await Promise.all(candidates.map((p) => (needsCatalog(p)
    ? fetchCatalog(p, false, cfg.clientUA, cfg.clientProfile)
    : null)));
  let { eligible, reasons, tierSizes } = selectCandidates(candidates, catalogResults, model);
  // 多模态（2026-09-16）：请求里带图片时，只保留声明了图片能力的候选
  if (bodyHasImage(body)) {
    const vf = filterVisionCandidates(eligible, reasons, model);
    if (vf.dropped > 0) {
      log(`[route] ${model}: 请求含图片 → 跳过未声明图片能力的 ${vf.dropped} 家`);
      eligible = vf.eligible;
      reasons = vf.reasons;
    }
  }
  const reasonsText = routeReasonsText(reasons);
  // 选路决策日志（2026-09-15 加）：**每次请求都记**——"为什么发给了这家"必须能在日志里
  // 直接看到（此前只在失败时才记原因，用户遇到"该走 A 却走了 B"时无从判断）。
  log(`[route] ${model}: ${eligible.length} 个候选（配置声明 ${tierSizes[0]} / 未配置按目录兜底 ${tierSizes[1]}）｜${reasonsText}`);

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
    // 模型映射：逻辑名 → 该供应商的上游真实 ID（Anthropic 路径同样处理）
    const attemptBody = bodyForProvider(outBody, p, model);
    const upModel = attemptBody.model;
    // 上游线协议：声明 openai-chat 的家走协议翻译（客户端说 Anthropic，上游只会 OpenAI）
    const toOpenAI = providerProtocol(p) === 'openai-chat';
    log(`try ${p.id} for ${model} (${toOpenAI ? 'anthropic→openai' : 'anthropic'})${upModel !== model ? ' → ' + upModel : ''}`);
    const baseHeaders = upstreamRequestHeaders(req.headers, p.apiKey, cfg.clientUA, !toOpenAI, cfg.clientProfile);
    const out = toOpenAI
      ? await forwardAnthropicViaOpenAI(p, baseHeaders, attemptBody, res, undefined)
      : await forwardWithAccounts(p, '/messages', baseHeaders, attemptBody, res);
    if (out === true) {
      log(`served ${model} via ${viaTag(p.id)} (anthropic)`);
      logCall(`via=${viaTag(p.id)}`, 'ok');
      return;
    }
    // 审计修复（P1，本次）：确定性 4xx → 立即终止 failover，按映射后的状态码回复客户端
    //（Anthropic 错误体形状：{type:'error',error:{type,message}}；不回显上游原文）
    if (out && out.stop) {
      log(`failover stopped (${model} via ${p.id} HTTP ${out.stop.upstreamStatus} → ${out.stop.status}, anthropic)`);
      logCall(`via=${viaTag(p.id)}`, 'fail:' + out.stop.status);
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
  const seen = new Set();
  const rows = [];
  const push = (id, owner) => {
    const name = String(id || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    // T5：同时携带 Anthropic 模型发现字段（display_name/type）——Claude Code 等
    // Anthropic 客户端可读；OpenAI 客户端忽略多余字段，互不影响
    rows.push({ id: name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: owner, type: 'model', display_name: name, created_at: new Date().toISOString() });
  };
  const providers = providersForModel(cfg);
  // 1) 先列**配置里声明的逻辑模型名**（模型映射后，dsh 请求的是逻辑名，目录里可能根本没有它）
  for (const p of providers) for (const as of logicalModelNames(p)) push(as, p.id);
  // 2) 只对**一个模型都没配**的服务商补目录（配置列表是权威：配了就不看目录，
  //    否则会列出网关根本不会路由的模型——dsh 选中后才 404，体验更差）
  await Promise.all(providers.filter((p) => needsCatalog(p)).map((p) => fetchCatalog(p, false, cfg.clientUA, cfg.clientProfile)));
  for (const p of providers) {
    if (!needsCatalog(p)) continue;
    const entry = catalogCache.get(p.id);
    // 失败冷却期（models=null）或无缓存：跳过（R10：不能对 null models 迭代）
    if (!entry || !entry.models) continue;
    const alias = new Map(modelEntries(p).map((e) => [e.up, e.as]));
    for (const id of entry.models) push(alias.get(id) || id, p.id);
  }
  // 2026-09-16：按模型名排序输出（选择器/客户端列表不再杂乱无章；此前是"供应商配置顺序+去重"）
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true, sensitivity: 'base' }));
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
  // 2026-09-16：泛化到任意 /vN —— WorkBuddy 的接口在 /v2（旧实现只认 /v1，会拼成 /v1/chat/completions）。
  // 带版本号（/v1、/v2…）→ 收敛到该版本；不带 → 补 /v1（OpenAI SDK 惯例，保持旧行为）。
  const m = b.match(/\/(v\d+)(?:\/.*)?$/i);
  if (m) return b.slice(0, b.length - m[0].length + m[1].length + 1);
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
    // 代理状态自述（v1.8.2）：每次启动都留一行"走不走代理 / 哪些域名直连"，
    // 于是"上游 ECONNREFUSED 到底是代理挂了还是上游挂了"一眼可判。
    {
      const st = proxyStatus();
      log(`proxy: ${st.url ? '走 ' + st.url + (st.envProxy ? '（NODE_USE_ENV_PROXY=1）' : '') : '直连（未注入代理）'}；NO_PROXY=${st.noProxy || '(空)'}`);
    }
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
  //
  // v1.8.2 加固（2026-09-16 事故：**健康进程自杀**）：
  //   旧实现用 http.get 探 127.0.0.1——而 NODE_USE_ENV_PROXY=1 时 Node 连回环请求也走代理，
  //   clash 端口一没监听就 8ms ECONNREFUSED，三次自检全败 → 自杀 → 宿主当崩溃重启（19:22:40）。
  //   两处修正：① 改成**裸 socket 发最小 HTTP 请求**，不经过任何代理层——自检只测"本进程
  //   server 是否还能应答"，代理死活与此无关；② 每次自检**最多记一次失败**（旧实现
  //   timeout 后 destroy 又触发 error，一次超时记两笔，两分钟就能凑够 3 次）；并把失败
  //   原因/耗时写进日志，不再只写"连续 3 次失败"。
  {
    let fails = 0;
    const probe = () => new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      const finish = (ok, why) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch (_) { /* 已关 */ }
        if (ok) { fails = 0; return; }
        fails += 1;
        log(`self-watchdog: /health ${why}（${Date.now() - t0}ms，连续失败 ${fails}/3）`);
        if (fails >= 3) {
          log('self-watchdog: 连续 3 次自检失败，进程自杀重启（宿主会自动拉起，属自愈行为）。');
          process.exit(1);
        }
      };
      const sock = net.connect({ host: '127.0.0.1', port: cfg.port });
      sock.setTimeout(8000);
      let buf = '';
      sock.on('connect', () => sock.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
        if (m) finish(m[1] === '200', `返回 HTTP ${m[1]}`);
      });
      sock.on('timeout', () => finish(false, '超时 8s（事件循环疑似卡死）'));
      sock.on('error', (e) => finish(false, `连接错误 ${e && e.code ? e.code : e.message}`));
      sock.on('close', () => finish(false, '连接被关闭且无响应'));
    });
    setInterval(() => { probe().catch(() => { /* 自检本身绝不抛 */ }); }, 60_000);
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
    if (p === '/health') {
      // 账户池可见性（2026-09-16）：WorkBuddy 这类按账户计费/限流的供应商，出问题时必须能
      // 一眼看出"哪个账户在冷却、为什么"。无账户池时该字段为空数组，不影响旧客户端解析。
      // 代理可见性（v1.8.2）：把"是否走代理 / 哪些域名直连"也放进来——2026-09-16 事故里
      // 上游 ECONNREFUSED 的真凶是 clash 端口没在监听，而 /health 当时只有 accounts。
      json(res, 200, { ok: true, accounts: accountPoolSnapshot(cfg), proxy: proxyStatus() });
      return;
    }

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
          // Responses 与 chat/completions 共用同一个处理器（同一家上游的两种协议）：
          // Responses 走自己的体翻译（instructions/input/reasoning.effort）与亲和路由
          return await handleCompletion(cfg, req, res, body, p, {
            responses: p === '/v1/responses',
            search: url.search || '',
          });
        } catch (e) {
          return replyBodyError(res, req, e, false);
        }
      }
      // Responses 资源子路由（有状态协议：客户端用 response.id 取回/删除/取消/取输入）
      if (p.startsWith('/v1/responses/')) {
        return await handleResponsesResource(cfg, req, res, url, p.slice('/v1/responses/'.length));
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
  // 模型映射（2026-09-11）：写进 dsh 的必须是**逻辑模型名**（dsh 请求用它，网关按它路由并改写为
  // 各供应商的上游真实 ID）；配置里 `{id, as}` 时取 as，字符串则取本身。
  const modelMap = new Map();
  for (const p of cfg.providers || []) {
    if (p.enabled === false) continue;
    for (const as of logicalModelNames(p)) if (!modelMap.has(as)) modelMap.set(as, as);
  }
  const models = [...modelMap.values()].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' }));
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
  // 2026-09-16 实测修复（air-outer / agentrouter 的 thinking 回传 400）：
  // 上游对"带 tool_use 的 assistant 轮"要求必须回传 thinking 块。pi-ai 在 thinking **无签名**
  // 时（上游不回 signature_delta，或流被中断）默认把该块降级成普通 text，于是下一轮请求里
  // 只剩 text+tool_use → 上游 400「content[].thinking ... must be passed back」。
  // compat.allowEmptySignature: true 让 pi-ai 保留为 thinking 块（签名为空），实测上游接受。
  // 该字段由 dsh-llm-pi-ai 的 COMPAT_GATES["anthropic-messages"] 门控为 "offer"（本版本支持）。
  const compatLines = wireApi === 'anthropic-messages'
    ? `\n          compat:\n            allowEmptySignature: true`
    : '';
  // 2026-09-16 用户反馈修复（图片输入被拦）：harness 按模型条目的 input 判断能否收图，
  // 未声明即按纯文本处理 → 附件入口直接提示"当前模型不支持图片，请切换支持图片的模型"。
  // 这里对**任一启用供应商声明了图片能力（vision: true / input: ['text','image']）**的逻辑模型
  // 写出 input: [text, image]；其余不写（保持纯文本，避免"声称能收图但上游不支持"）。
  const inputLines = (m) => (logicalModelSupportsVision(cfg, m)
    ? `\n          input:\n            - text\n            - image`
    : '');
  // 2026-09-16：模型条目可显式声明 contextWindow / maxTokens —— 各家上游实际窗口差异很大
  //（WorkBuddy 实测：hy3 192K、minimax-m3 512K、glm-5.3 1M…）。对全部模型统一写 1M 属于**虚报**，
  // 会让 dsh 以为还能塞很多 → 长对话在上游直接报上下文超限。取该逻辑模型在所有启用供应商里的
  // **最小值**（保守：任一家装不下就按装不下的算），没声明才退回默认。
  const modelLimits = (() => {
    const ctx = new Map();
    const out = new Map();
    for (const p of cfg.providers || []) {
      if (!p || p.enabled === false) continue;
      for (const e of modelEntries(p)) {
        const c = Number(e.contextWindow) > 0 ? Number(e.contextWindow) : 0;
        const o = Number(e.maxTokens) > 0 ? Number(e.maxTokens) : 0;
        if (c) ctx.set(e.as, ctx.has(e.as) ? Math.min(ctx.get(e.as), c) : c);
        if (o) out.set(e.as, out.has(e.as) ? Math.min(out.get(e.as), o) : o);
      }
    }
    return { ctx, out };
  })();
  const modelLines = models
    .map((m) => {
      const ctxWin = modelLimits.ctx.get(m) || 1024000;
      const maxTok = modelLimits.out.get(m);
      return `        - id: ${yamlQuote(m)}\n          name: ${yamlQuote(m)}\n          contextWindow: ${ctxWin}`
        + (maxTok ? `\n          maxTokens: ${maxTok}` : '')
        + `\n          reasoningEfforts:\n            off: null\n            low: low\n            medium: medium\n            high: high\n            max: max${inputLines(m)}${compatLines}`;
    })
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
