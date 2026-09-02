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

const catalogInflight = new Map(); // providerId -> Promise（并发去重）

async function fetchCatalog(provider, force) {
  const cached = catalogCache.get(provider.id);
  if (!force && cached && Date.now() - cached.ts < MODEL_CACHE_TTL_MS) return cached.models;
  // 并发去重：同一 provider 已有在途目录请求时直接复用（修复 G5）
  if (!force && catalogInflight.has(provider.id)) return catalogInflight.get(provider.id);
  const promise = doFetchCatalog(provider);
  catalogInflight.set(provider.id, promise);
  try {
    return await promise;
  } finally {
    catalogInflight.delete(provider.id);
  }
}

async function doFetchCatalog(provider) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${trimSlash(provider.baseURL)}/models`, {
      headers: { authorization: `Bearer ${provider.apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const body = await res.json();
    const ids = new Set((body.data || []).map((m) => m && m.id).filter(Boolean));
    if (ids.size === 0) throw new Error('empty catalog');
    catalogCache.set(provider.id, { models: ids, ts: Date.now() });
    log(`catalog ${provider.id}: ${ids.size} models`);
    return ids;
  } catch (e) {
    catalogCache.delete(provider.id);
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

/** Forward to one provider; returns true when the response was written. */
async function forward(provider, upstreamPath, upstreamHeaders, body, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    // baseURL already ends with /v1 (OpenAI SDK convention); the path here is
    // relative to it (e.g. /chat/completions, /responses).
    upstream = await fetch(`${trimSlash(provider.baseURL)}${upstreamPath}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...upstreamHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    catalogCache.delete(provider.id);
    log(`upstream ${provider.id} request error: ${e.message}`);
    return false;
  }
  clearTimeout(timer);
  if (!upstream.ok) {
    // surface upstream error body if small
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 500); } catch { }
    log(`upstream ${provider.id} HTTP ${upstream.status}: ${detail}`);
    if (upstream.status === 401 || upstream.status === 403 || upstream.status >= 500) {
      catalogCache.delete(provider.id); // likely stale/misconfigured key or dead endpoint
    }
    return false;
  }
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

  const candidates = providersForModel(cfg, model);
  if (candidates.length === 0) {
    return json(res, 404, { error: { message: `no providers configured for model "${model}"` } });
  }

  // 1) availability pre-filter: prefer providers whose catalog advertises the model
  //    (cached; fallback to trying in priority order when catalog unknown)
  //    并行探测各供应商目录，避免串行等待放大首请求延迟（E3）
  const withCatalog = [];
  const unknown = [];
  const catalogResults = await Promise.all(candidates.map((p) => fetchCatalog(p, false)));
  candidates.forEach((p, i) => {
    const set = catalogResults[i];
    if (set === null) { unknown.push(p); return; }
    if (set.has(model)) withCatalog.push(p);
  });

  const ordered = [...withCatalog, ...unknown];
  if (ordered.length === 0) {
    return json(res, 404, { error: { message: `model "${model}" is not offered by any configured provider` } });
  }
  for (const p of ordered) {
    log(`try ${p.id} for ${model}`);
    const ok = await forward(p, upstreamPath.replace(/^\/v1/, ''), {}, body, res);
    if (ok) {
      log(`served ${model} via ${p.id}`);
      return;
    }
  }
  json(res, 503, { error: { message: `all providers for model "${model}" are unavailable` } });
}

async function handleModels(cfg, req, res) {
  const byId = new Map();
  const rows = [];
  const results = await Promise.all(
    providersForModel(cfg).map((p) => fetchCatalog(p, false)),
  );
  for (const p of providersForModel(cfg)) {
    const set = catalogCache.get(p.id);
    if (!set) continue;
    for (const id of set.models) {
      if (!byId.has(id)) {
        byId.set(id, rows.length);
        rows.push({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: p.id });
      }
    }
  }
  json(res, 200, { object: 'list', data: rows });
}

/* ---------------- server ---------------- */
function trimSlash(u) { return u.replace(/\/+$/, ''); }

function startServer(cfg) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/health') { json(res, 200, { ok: true }); return; }

    if (p.startsWith('/v1/')) {
      if (!authorized(req, cfg)) {
        return json(res, 401, { error: { message: 'invalid or missing API key' } });
      }
      if (req.method === 'GET' && p === '/v1/models') return handleModels(cfg, req, res);
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
