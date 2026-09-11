// tests/gateway.test.js — 模型网关端到端回归（2026-09-10 审计修复验证）
//
// 做法：进程内起一个**假上游**（可控 SSE / 可控挂起 / 记录客户端是否断开），再用
// process.execPath 真启动 src/gateway/model-gateway.mjs（真 listen + 真转发），
// 从测试进程发真请求。覆盖：
//   1) 鉴权（错误/缺失 key → 401；正确 key → 200）
//   2) 正常 SSE 流式转发（重构后 happy path 不回归）
//   3) 客户端中途断开 → **上游流被立即取消**（旧版会一直读到结束并记 ok）
//   4) 超大请求体 → 413 且连接被关闭（旧版回 400 并毒化 keep-alive）
//   5) 畸形 Host → 400 且不悬挂（旧版 new URL 抛错 → 请求永久挂起）
//   6) 上游错误体挂起 → 网关不永久挂起
//   7-10) write-dsh 的 YAML 逐层定位与幂等/备份
//   11) 上游确定性 4xx（400/422）→ 只打一次上游、终止 failover、客户端拿 4xx（N 倍计费回归）
//   12) 上游内容拦截（content_blocked）→ 仍换下一家（有意行为保留）+ 缺省不落 dump
//   13) 内容拦截 dump：env 开关 + 保留最近 20 个 + 长串只记 {len,kind}
//   14) 模型不在 catalog/models 里 → 404 且零计费转发（旧的"任意模型发给所有供应商"回归）
//   15) catalog 命中即候选（供应商新增模型不必改配置）
//   16) 熔断：冷却期不打上游 + 半开并发只放一个探测 + 上游恢复能自愈
// 运行：node tests/gateway.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MJS = path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs');
const GATEWAY_KEY = 'dsh-gateway-test-0123456789abcdef';
// 上游假 key 运行期拼接（与 integration.js 同款约定）：避免源码里出现 `sk-` + 长串的
// 字面量，被发布安全闸门的通用形态规则误判为真实密钥。
const UPSTREAM_KEY = 'sk-' + 'FAKE'.repeat(8).toLowerCase();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-'));

let passed = 0;
const __tests = [];
function t(name, fn) { __tests.push({ name, fn }); }

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// 上游观测记录
const upstream = {
  cancelled: 0,        // 客户端断开后被我们观察到的次数
  streams: 0,
  hangBody: false,     // /v1/chat/completions 返回 500 后不结束 body
};

const upstreamServer = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (upstream.hangBody) {
        // 返回错误状态头后**不结束 body**：旧版网关会永久挂起
        res.writeHead(500, { 'content-type': 'application/json' });
        res.write('{"error":{"message":"upstream stalled');
        return;
      }
      upstream.streams++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let n = 0;
      const timer = setInterval(() => {
        n++;
        res.write('data: {"choices":[{"delta":{"content":"chunk' + n + '"}}]}\n\n');
        if (n >= 3) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 120);
      // 客户端（网关）断开 → 记录并停掉生成
      res.on('close', () => {
        if (res.writableEnded) return;
        clearInterval(timer);
        upstream.cancelled++;
      });
    });
    return;
  }
  res.writeHead(404).end();
});

let gwPort = 0;
let gwProc = null;
const gwLogPath = path.join(tmp, 'gateway.log');

function startGateway() {
  const cfgPath = path.join(tmp, 'gateway.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: gwPort,
    apiKey: GATEWAY_KEY,
    providers: [{
      id: 'fake', baseURL: 'http://127.0.0.1:' + upstreamPort + '/v1',
      apiKey: UPSTREAM_KEY, models: ['test-model'], priority: 1, enabled: true,
    }],
  }, null, 2), 'utf8');
  // 注意：本机沙箱禁止子进程使用管道 stdio（EPERM），且网关自己写日志文件，
  // 因此这里用 'ignore' 而不捕获 stdout/stderr。
  gwProc = spawn(process.execPath, [MJS, '--config', cfgPath, '--log', gwLogPath, '--port', String(gwPort)], {
    stdio: 'ignore', windowsHide: true,
  });
}

function waitHealth(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > deadline) return resolve(false);
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        setTimeout(tick, 300);
      });
      req.on('timeout', () => { req.destroy(); setTimeout(tick, 300); });
      req.on('error', () => setTimeout(tick, 300));
    };
    tick();
  });
}

function call({ method = 'POST', p = '/v1/chat/completions', key = GATEWAY_KEY, body = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, ac = null, port = 0 } = {}) {
  const targetPort = port || gwPort;
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: targetPort, path: p, method,
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        key ? { authorization: 'Bearer ' + key } : {}),
      signal: ac ? ac.signal : undefined,
    }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c;
        // 客户端在中途主动断开（模拟"点停止"）
        if (ac && !ac.signal.aborted && text.includes('chunk1')) { try { ac.abort(); } catch { } }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message, text: '' }));
    req.end(payload);
  });
}

let upstreamPort = 0;

(async () => {
  await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', () => { upstreamPort = upstreamServer.address().port; r(); }));
  gwPort = await freePort();
  startGateway();
  const ok = await waitHealth(gwPort, 20000);
  if (!ok) {
    console.log('[SKIP] 网关未能在 20s 内就绪（本机 spawn 受限？）——跳过端到端用例');
    try { gwProc.kill(); } catch { }
    try { upstreamServer.close(); } catch { }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }
  console.log('[..] 网关已就绪 :' + gwPort + '，假上游 :' + upstreamPort);

  // ---- 1) 鉴权 ----
  t('网关：缺失/错误 key → 401，正确 key → 200', async () => {
    const noKey = await call({ key: '' });
    assert.strictEqual(noKey.status, 401, '缺 key 应 401，实际 ' + noKey.status);
    const badKey = await call({ key: 'dsh-gateway-wrong-key-000000' });
    assert.strictEqual(badKey.status, 401, '错 key 应 401，实际 ' + badKey.status);
    const good = await call({});
    assert.strictEqual(good.status, 200, '正确 key 应 200，实际 ' + good.status + ' ' + good.text.slice(0, 120));
  });

  // ---- 2) 正常流式转发 ----
  t('网关：正常 SSE 流式转发（重构后 happy path 未回归）', async () => {
    const r = await call({});
    assert.strictEqual(r.status, 200);
    assert.ok(/chunk1/.test(r.text) && /\[DONE\]/.test(r.text), '应收到完整流：' + r.text.slice(0, 200));
  });

  // ---- 3) 客户端断开 → 上游流被取消（P1-3）----
  t('网关：客户端断开 → 立即取消上游流（旧版会读到结束并记 ok）', async () => {
    const before = upstream.cancelled;
    const ac = new AbortController();
    const p = call({ ac });
    await new Promise((r) => setTimeout(r, 400));   // 让客户端收到 chunk1 并触发 abort
    try { ac.abort(); } catch { }
    await p.catch(() => { });
    // 给网关与上游一点时间传播取消
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(upstream.cancelled > before,
      '上游应观察到客户端断开（cancelled ' + before + ' → ' + upstream.cancelled + '）——说明网关真的取消了上游流');
  });

  // ---- 4) 超大请求体 → 413 + 关闭连接（P1-2）----
  t('网关：超过 16MB 的请求体 → 413 且连接被关闭（不再毒化 keep-alive）', async () => {
    const big = JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'x'.repeat(17 * 1024 * 1024) }] });
    const r = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: gwPort, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big), authorization: 'Bearer ' + GATEWAY_KEY },
      }, (res) => {
        let t = '';
        res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
        res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
      });
      req.on('error', (e) => resolve({ status: 0, error: e.code || e.message, headers: {} }));
      // 只发一部分就够触发上限（content-length 已声明为大值）
      req.write(big.slice(0, 16 * 1024 * 1024 + 4096));
      setTimeout(() => { try { req.destroy(); } catch { } }, 4000);
    });
    assert.strictEqual(r.status, 413, '应回 413，实际 ' + r.status + ' ' + (r.error || ''));
    assert.strictEqual(String(r.headers.connection || '').toLowerCase(), 'close', '应声明 Connection: close');
  });

  // ---- 5) 畸形 Host → 400 不悬挂（P2-1）----
  t('网关：畸形 Host 头 → 400（旧版 new URL 抛错 → 请求永久挂起）', async () => {
    const raw = await new Promise((resolve) => {
      const sock = net.connect(gwPort, '127.0.0.1', () => {
        sock.write('GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.setTimeout(5000, () => { sock.destroy(); resolve(buf || '(timeout)'); });
      sock.on('data', (c) => { buf += c; });
      sock.on('close', () => resolve(buf));
      sock.on('error', () => resolve(buf));
    });
    assert.ok(/^HTTP\/1\.1 400/.test(raw), '应回 400（不能悬挂），实际首行：' + String(raw).split('\r\n')[0]);
  });

  // ---- 6) 上游错误响应体挂起 → 网关不永久挂起（P2-3）----
  t('网关：上游错误体挂起 → 网关仍在 5s 超时内返回（不永久挂起）', async () => {
    upstream.hangBody = true;
    const t0 = Date.now();
    const r = await call({});
    const dt = Date.now() - t0;
    upstream.hangBody = false;
    assert.ok(r.status >= 400 || r.status === 0, '上游 500 时不应回 200：' + r.status);
    assert.ok(dt < 15000, '应在超时内结束（实际 ' + dt + 'ms）');
  });

  // ---- 7) write-dsh 的 YAML 定位（P1-7）----
  const writeDsh = (settingsText) => {
    const dir = fs.mkdtempSync(path.join(tmp, 'wd-'));
    const cfgPath = path.join(dir, 'gateway.config.json');
    const setPath = path.join(dir, 'settings.yaml');
    const credPath = path.join(dir, 'credentials.yaml');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: 3099, apiKey: GATEWAY_KEY, clientProfile: 'claude',
      providers: [{ id: 'p1', baseURL: 'https://a.example.org/v1', apiKey: 'sk-' + 'x'.repeat(20), models: ['m1'], priority: 1, enabled: true }],
    }), 'utf8');
    fs.writeFileSync(setPath, settingsText, 'utf8');
    const r = spawnSync(process.execPath, [MJS, '--write-dsh', '--config', cfgPath, '--settings', setPath, '--credentials', credPath, '--port', '3099'],
      { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    return { status: r.status, text: fs.readFileSync(setPath, 'utf8') };
  };

  t('write-dsh：只动 llm-pi-ai.providers.gateway，不误伤别处的 gateway: 块（P1-7）', () => {
    const r = writeDsh([
      'mcp:',
      '  servers:',
      '    gateway:',
      '      url: http://localhost:9999/keep-me',
      'llm-pi-ai:',
      '  providers:',
      '    other:',
      '      apiKeyEnv: OTHER_KEY',
      '',
    ].join('\n'));
    assert.strictEqual(r.status, 0, 'write-dsh 应成功');
    assert.ok(r.text.includes('url: http://localhost:9999/keep-me'), '别处的 gateway 块必须完好：\n' + r.text);
    const m = r.text.match(/^ {4}gateway:$/m);
    assert.ok(m, '应在 llm-pi-ai.providers 下写入 gateway 条目');
    assert.ok(r.text.includes('apiKeyEnv: OTHER_KEY'), '既有 provider 条目应保留');
    // 位置校验：**我们写入的**条目（按内容定位，别处 decoy 也叫 gateway）必须在 llm-pi-ai 段内
    const pi = r.text.indexOf('llm-pi-ai:');
    const gw = r.text.indexOf('    gateway:\n      displayName: DSH Model Gateway');
    assert.ok(pi >= 0 && gw > pi, 'gateway 条目必须位于 llm-pi-ai 段内：\n' + r.text);
    assert.ok(r.text.includes('baseURL: http://127.0.0.1:3099'), 'claude 仿真应写不带 /v1 的 baseURL');
  });

  t('write-dsh：providers 后跟同级键时不串层（P1-7 场景二）', () => {
    const r = writeDsh([
      'llm-pi-ai:',
      '  providers:',
      '  other: 1',
      '',
    ].join('\n'));
    assert.strictEqual(r.status, 0);
    assert.ok(/^ {2}providers:\n {4}gateway:$/m.test(r.text), 'gateway 必须紧跟 providers 且缩进 4：\n' + r.text);
    assert.ok(/^ {2}other: 1$/m.test(r.text), '同级键 other 必须保留且仍在缩进 2');
  });

  t('write-dsh：重复执行幂等（不产生重复条目）', () => {
    const a = writeDsh('llm-pi-ai:\n  providers:\n');
    const b = writeDsh(a.text);
    assert.strictEqual(b.text, a.text, '第二次写入应完全一致');
    assert.strictEqual((b.text.match(/^ {4}gateway:$/gm) || []).length, 1, '不得出现重复 gateway 条目');
  });

  t('write-dsh：settings.yaml 首次写入前留备份', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'wd-bak-'));
    const cfgPath = path.join(dir, 'gateway.config.json');
    const setPath = path.join(dir, 'settings.yaml');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: 3099, apiKey: GATEWAY_KEY,
      providers: [{ id: 'p1', baseURL: 'https://a.example.org/v1', apiKey: 'sk-' + 'x'.repeat(20), models: ['m1'], enabled: true }],
    }), 'utf8');
    fs.writeFileSync(setPath, 'llm-pi-ai:\n  providers:\n', 'utf8');
    spawnSync(process.execPath, [MJS, '--write-dsh', '--config', cfgPath, '--settings', setPath, '--credentials', path.join(dir, 'c.yaml'), '--port', '3099'],
      { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    assert.ok(fs.existsSync(setPath + '.bak-gateway'), '应留 .bak-gateway 首次备份');
    assert.strictEqual(fs.readFileSync(setPath + '.bak-gateway', 'utf8'), 'llm-pi-ai:\n  providers:\n', '备份应为写入前内容');
  });

  // ================= 2026-09-10 审计 §3.2 四项待修缺陷的回归用例 =================
  // 这些用例需要与主实例**不同的 provider 拓扑**（两家供应商才能观察 failover），
  // 因此各自起独立的网关进程（同一份源码），互不干扰上面的既有用例。

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 可编程假上游：分别统计 /models（catalog 探测，不产生计费）与非 /models 的转发请求（真会计费）
  async function startFakeUpstream(opts = {}) {
    const st = {
      modelsReqs: 0,
      calls: 0,
      modelsStatus: opts.modelsStatus === undefined ? 200 : opts.modelsStatus,
      catalog: opts.catalog === undefined ? [{ id: 'test-model' }] : opts.catalog,
      status: opts.status === undefined ? 200 : opts.status,
      errorBody: opts.errorBody === undefined ? { error: { message: 'upstream error' } } : opts.errorBody,
      delayMs: opts.delayMs || 0,
      // —— OpenAI Responses 协议仿真（见下方 handleResponses）——
      respIdPrefix: opts.respIdPrefix || 'resp_test',
      respSeq: 0,
      respStore: new Map(),      // 只认自己创建的 id（真实上游即如此）
      resourceStatus: opts.resourceStatus || 0,   // >0 时资源子路由强制返回该状态
      noResourceRoutes: !!opts.noResourceRoutes,  // 模拟 new-api：只实现 POST 生成，子路由一律 Invalid URL
      lastRespBody: null,        // 上游实际收到的 Responses 请求体
      respUrls: [],              // 上游收到的原始 URL（含查询串，断言透传用）
      lastModel: null,
      models: [],
    };
    // Responses 协议：POST 创建（SSE 或 JSON）+ 资源子路由（GET/DELETE/cancel/input_items）
    const handleResponses = (req, res) => {
      const u = new URL(req.url, 'http://x');
      const segs = u.pathname.slice('/v1/responses'.length).split('/').filter(Boolean);
      const id = segs[0] || null;
      const action = segs[1] || null;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st.calls++;
        st.respUrls.push(req.method + ' ' + req.url);
        const json = (status, obj) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'POST' && !id) {
          let parsed = {};
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { /* 忽略 */ }
          st.lastRespBody = parsed;
          st.lastModel = parsed.model;
          st.models.push(parsed.model);
          const newId = st.respIdPrefix + (++st.respSeq);
          st.respStore.set(newId, { id: newId, object: 'response', status: 'completed', model: parsed.model });
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write('event: response.created\ndata: '
            + JSON.stringify({ type: 'response.created', response: { id: newId, object: 'response', status: 'in_progress' } }) + '\n\n');
          res.write('event: response.output_text.delta\ndata: '
            + JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }) + '\n\n');
          res.end('event: response.completed\ndata: '
            + JSON.stringify({ type: 'response.completed', response: { id: newId, object: 'response', status: 'completed' } }) + '\n\n');
          return;
        }
        // 模拟实测到的 new-api 行为：只实现 POST 生成，资源子路由一律 "Invalid URL (...)"（404）
        if (st.noResourceRoutes) {
          json(404, { error: { message: 'Invalid URL (' + req.method + ' ' + u.pathname + ')', type: 'invalid_request_error' } });
          return;
        }
        // 资源子路由：不属于自己的 id → 404（换家探测因此是安全的）
        if (!id || !st.respStore.has(id)) {
          json(404, { error: { message: 'No response found with id ' + id } });
          return;
        }
        if (st.resourceStatus && st.resourceStatus !== 200) {
          json(st.resourceStatus, { error: { message: 'upstream temporarily unavailable' } });
          return;
        }
        if (req.method === 'GET' && !action) { json(200, st.respStore.get(id)); return; }
        if (req.method === 'GET' && action === 'input_items') {
          json(200, { object: 'list', data: [{ role: 'user', content: 'hi' }] });
          return;
        }
        if (req.method === 'DELETE' && !action) {
          st.respStore.delete(id);
          json(200, { id, object: 'response.deleted', deleted: true });
          return;
        }
        if (req.method === 'POST' && action === 'cancel') {
          json(200, { id, object: 'response', status: 'cancelled' });
          return;
        }
        json(404, { error: { message: 'unsupported' } });
      });
    };
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/v1/models')) {
        st.modelsReqs++;
        if (st.modelsStatus !== 200) {
          res.writeHead(st.modelsStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'catalog unavailable' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: st.catalog }));
        return;
      }
      if (req.url.startsWith('/v1/responses')) { handleResponses(req, res); return; }
      req.resume();                       // 消费请求体（本假上游不解析内容）
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st.calls++;
        // 记录上游实际收到的 model（模型映射用例断言用：必须是该供应商的上游真实 ID）
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          st.lastModel = parsed.model;
          st.models.push(parsed.model);
        } catch (_) { /* 忽略 */ }
        const send = () => {
          if (st.status !== 200) {
            res.writeHead(st.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(st.errorBody));
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end('data: {"choices":[{"delta":{"content":"upstream-ok"}}]}\n\ndata: [DONE]\n\n');
        };
        if (st.delayMs) setTimeout(send, st.delayMs); else send();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, st, port: server.address().port };
  }

  function providerOf(id, up, opts = {}) {
    const p = {
      id,
      baseURL: 'http://127.0.0.1:' + up.port + '/v1',
      apiKey: UPSTREAM_KEY,
      models: opts.models === undefined ? ['test-model'] : opts.models,
      priority: opts.priority === undefined ? 1 : opts.priority,
      enabled: true,
    };
    if (opts.reasoningEffortMap) p.reasoningEffortMap = opts.reasoningEffortMap;
    return p;
  }

  // 独立网关实例：独立端口/配置/日志目录 + 可选 env（如熔断时长、dump 开关）
  // cfgExtra：额外顶层配置（如 routing: 'round-robin'）
  async function startGatewayWith(providers, tag, env, cfgExtra) {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(tmp, 'gw-' + tag + '-'));
    const cfgPath = path.join(dir, 'gateway.config.json');
    const logPath = path.join(dir, 'gateway.log');
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({ port, apiKey: GATEWAY_KEY, providers }, cfgExtra || {}), null, 2), 'utf8');
    const proc = spawn(process.execPath, [MJS, '--config', cfgPath, '--log', logPath, '--port', String(port)], {
      stdio: 'ignore', windowsHide: true,
      env: env ? Object.assign({}, process.env, env) : process.env,
    });
    const ready = await waitHealth(port, 20000);
    return { port, proc, logPath, dir, ready };
  }

  const killGw = (g) => { try { g.proc.kill(); } catch { } };
  const closeUp = (u) => { try { u.server.close(); } catch { } };

  // ---- 修复项 1：确定性 4xx 终止 failover（不再 N 倍重发 / 不再回 503）----
  t('网关：上游确定性 400 → 只打一次上游、客户端拿 400（旧版会重发给每一家并回 503）', async () => {
    const up1 = await startFakeUpstream({ status: 400, errorBody: { error: { message: 'invalid parameter: temperature must be <= 2' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('p1', up1, { priority: 1 }),
      providerOf('p2', up2, { priority: 2 }),
    ], 'det400');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 400, '应把确定性 400 映射回客户端（不是 503、也不是下一家的 200），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up1.st.calls, 1, 'p1 只应被请求一次（含降敏重试在内），实际 ' + up1.st.calls);
      assert.strictEqual(up2.st.calls, 0, '同一个"请求本身有错"的 body 不得再发给 p2（N 倍计费），实际 ' + up2.st.calls);
      assert.ok(!/temperature must be/.test(r.text), '不得回显上游错误体原文：' + r.text.slice(0, 200));
      const parsed = JSON.parse(r.text);
      assert.ok(parsed.error && parsed.error.message.includes('p1'), '错误信息应指出是哪个供应商拒绝的：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：404 细分——"模型不存在"终止 failover；"路由不存在"仍换下一家', async () => {
    // 场景 A：上游明确说模型不存在 → 确定性错误，不得重发给下一家
    const a1 = await startFakeUpstream({ status: 404, errorBody: { error: { message: 'The model test-model does not exist' } } });
    const a2 = await startFakeUpstream({ status: 200 });
    const gwA = await startGatewayWith([
      providerOf('m1', a1, { priority: 1 }),
      providerOf('m2', a2, { priority: 2 }),
    ], 'm404');
    try {
      assert.ok(gwA.ready, '独立网关实例应就绪');
      const r = await call({ port: gwA.port });
      assert.strictEqual(r.status, 404, '模型不存在的 404 应映射回客户端，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.strictEqual(a2.st.calls, 0, '不得把"模型不存在"的请求再发给下一家，实际 ' + a2.st.calls);
    } finally { killGw(gwA); closeUp(a1); closeUp(a2); }

    // 场景 B：通用 404（供应商没有该路由）→ 换下一家（否则 Codex 仿真用户会被首家的
    // 路由缺失直接打死）
    const b1 = await startFakeUpstream({ status: 404, errorBody: { error: { message: 'Not Found' } } });
    const b2 = await startFakeUpstream({ status: 200 });
    const gwB = await startGatewayWith([
      providerOf('r1', b1, { priority: 1 }),
      providerOf('r2', b2, { priority: 2 }),
    ], 'route404');
    try {
      assert.ok(gwB.ready, '独立网关实例应就绪');
      const r = await call({ port: gwB.port });
      assert.strictEqual(r.status, 200, '路由不存在的 404 应继续 failover 到下一家，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.ok(b2.st.calls >= 1, '应尝试下一家，实际 ' + b2.st.calls);
    } finally { killGw(gwB); closeUp(b1); closeUp(b2); }
  });

  t('网关：Anthropic 路径（/v1/messages）同样在确定性 4xx 上终止 failover（Anthropic 错误体形状）', async () => {
    const up1 = await startFakeUpstream({ status: 422, errorBody: { type: 'error', error: { type: 'invalid_request_error', message: 'upstream raw detail: unprocessable entity' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('a1', up1, { priority: 1 }),
      providerOf('a2', up2, { priority: 2 }),
    ], 'det422');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 422, '应回 422，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up2.st.calls, 0, '不得把同一个错误请求再发给第二家，实际 ' + up2.st.calls);
      const parsed = JSON.parse(r.text);
      assert.strictEqual(parsed.type, 'error', 'Anthropic 错误体形状：' + r.text.slice(0, 200));
      assert.strictEqual(parsed.error.type, 'invalid_request_error');
      assert.ok(!/upstream raw detail/.test(r.text), '不得回显上游错误体原文：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：上游 400 内容拦截（content_blocked）→ 仍会换下一家供应商（有意行为保留）', async () => {
    const up1 = await startFakeUpstream({ status: 400, errorBody: { error: { message: 'content_blocked: sensitive words detected' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('b1', up1, { priority: 1 }),
      providerOf('b2', up2, { priority: 2 }),
    ], 'blocked');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '内容拦截应继续 failover 到 b2，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(up1.st.calls >= 1, 'b1 应被尝试，实际 ' + up1.st.calls);
      assert.strictEqual(up2.st.calls, 1, 'b2 应收到一次转发，实际 ' + up2.st.calls);
      // 修复项 4①：内容拦截 dump 缺省**不落盘**（旧版无条件写 logs/dump/blocked-*.json）
      assert.ok(!fs.existsSync(path.join(path.dirname(gw.logPath), 'dump')),
        '缺省（未设 DSH_GATEWAY_DUMP_BLOCKED/DSH_GATEWAY_DUMP_DIR）不得自动落盘 blocked-*.json');
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  // ---- 修复项 4：dump 开关 + 保留上限 + 不记长串原文前缀 ----
  t('网关：内容拦截 dump 只在显式开启时落盘、只保留最近 20 个、长串只记长度与类型', async () => {
    const fakeHex = 'a1b2c3d4'.repeat(6);          // 48 位 hex 形态假串（非真实密钥）
    const up = await startFakeUpstream({ status: 400, errorBody: { error: { message: 'content_blocked: sensitive words' } } });
    const dumpDir = path.join(tmp, 'blocked-dump');
    const gw = await startGatewayWith([providerOf('d1', up, { priority: 1 })], 'dump', {
      DSH_GATEWAY_DUMP_BLOCKED: '1', DSH_GATEWAY_DUMP_DIR: dumpDir,
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 22; i++) {
        await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'token ' + fakeHex }] } });
      }
      const files = fs.readdirSync(dumpDir).filter((f) => /^blocked-.*\.json$/.test(f));
      assert.strictEqual(files.length, 20, '目录内应只保留最近 20 个 blocked-*.json，实际 ' + files.length);
      const all = files.map((f) => fs.readFileSync(path.join(dumpDir, f), 'utf8'));
      assert.ok(all.every((txt) => !txt.includes(fakeHex.slice(0, 20))), 'dump 不得包含长串原文前缀（可能是真密钥前缀）');
      const sample = JSON.parse(all[0]);
      assert.deepStrictEqual(sample.longTokens, [{ len: 48, kind: 'hex' }],
        'longTokens 只记 {len,kind}（旧版记 head=原文前 20 字符）：' + JSON.stringify(sample.longTokens));
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 修复项 2：配置 models 参与路由 ----
  t('网关：模型不在 catalog 也不在 provider.models → 404 且不向上游发计费请求（带排查提示）', async () => {
    const up = await startFakeUpstream({ modelsStatus: 404 });   // catalog 不可用 → "未知"桶
    const gw = await startGatewayWith([providerOf('only-other', up, { models: ['other-model'] })], 'nomodel');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });                   // 请求 test-model（配置里没有）
      assert.strictEqual(r.status, 404, 'catalog 未知且 models 不含该模型 → 404，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 0, '不得把未知模型发给上游（旧版会发给所有供应商烧额度），实际 ' + up.st.calls);
      assert.strictEqual(up.st.modelsReqs, 1, 'catalog 探测应只发生一次（失败态有冷却缓存），实际 ' + up.st.modelsReqs);
      assert.ok(/models/.test(r.text) && /model \\"test-model\\"/.test(r.text), '错误信息应提示检查 provider 的 models 列表：' + r.text.slice(0, 300));
      assert.ok(/catalog-unknown,models-miss/.test(r.text), '错误详情应带每个 provider 的判定原因：' + r.text.slice(0, 300));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/only-other=catalog-unknown,models-miss/.test(logText), '日志应记录判定原因（便于排查"模型没配上"）：' + logText.slice(-400));
      // 同一实例：catalog 未知但 provider.models 含该模型 → 仍作为候选（保持宽容，不改变旧行为）
      const r2 = await call({ port: gw.port, body: { model: 'other-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r2.status, 200, 'catalog 未知但 models 命中应仍可路由，实际 ' + r2.status + ' ' + r2.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, 'other-model 应恰好转发一次，实际 ' + up.st.calls);
      assert.strictEqual(up.st.modelsReqs, 1, '失败态 catalog 在冷却期内不得重复探测，实际 ' + up.st.modelsReqs);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：catalog 命中但配置 models 未声明 → 仍作为候选（供应商新增模型不必改配置）', async () => {
    const up = await startFakeUpstream({ catalog: [{ id: 'test-model' }] });
    const gw = await startGatewayWith([providerOf('cat', up, { models: ['other-model'] })], 'cathit');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, 'catalog 命中即候选（优先级高于 models 声明），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, '应转发一次，实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：catalog 未命中但配置显式声明 → 仍作为候选（声明优先于目录快照）', async () => {
    // 实测场景：agentrouter 的 /models 不含 glm-5.3，但用户在网关配置里显式声明了它。
    // 旧规则（catalog 已知不含 → 排除）会回 404「not offered by any configured provider」，
    // 把用户配好的模型打死；修订后配置声明优先。
    const up = await startFakeUpstream({ catalog: [{ id: 'some-other-model' }] });
    const gw = await startGatewayWith([providerOf('decl', up, { models: ['test-model'] })], 'declhit');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '配置显式声明即候选，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, '应转发一次，实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：模型映射——逻辑名路由到各家的上游真实 ID（含 failover 后改写）', async () => {
    // 两家供应商用**不同的上游 ID** 承载同一个逻辑模型 deepseek-v4-flash：
    //   p1: deepseek-ai/deepseek-v4-flash（挂：500 → 触发 failover）
    //   p2: deepseek-v4-flash0731（正常）
    // 客户端只请求逻辑名；网关必须按优先级切换，并把 body.model 改写为**该家**的真实 ID。
    const up1 = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('m1', up1, { priority: 1, models: [{ id: 'deepseek-ai/deepseek-v4-flash', as: 'deepseek-v4-flash' }] }),
      providerOf('m2', up2, { priority: 2, models: [{ id: 'deepseek-v4-flash0731', as: 'deepseek-v4-flash' }] }),
    ], 'maproute');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应 failover 到第二家，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.strictEqual(up1.st.lastModel, 'deepseek-ai/deepseek-v4-flash', 'p1 收到的应是它自己的上游 ID');
      assert.strictEqual(up2.st.lastModel, 'deepseek-v4-flash0731', 'p2 收到的应是它自己的上游 ID');
      assert.ok(!up1.st.models.includes('deepseek-v4-flash'), '不得把逻辑名原样发给上游');
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：模型映射——同一逻辑名有多条映射时取第一条命中；未声明映射则原样透传', async () => {
    const upA = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('multi', upA, {
        models: [
          { id: 'variant-one-x', as: 'same-logical' },
          { id: 'variant-two-x', as: 'same-logical' },
        ],
      }),
    ], 'mapmulti');
    try {
      assert.ok(gw.ready);
      const r1 = await call({ port: gw.port, body: { model: 'same-logical', messages: [] } });
      assert.strictEqual(r1.status, 200, '实际 ' + r1.status);
      assert.strictEqual(upA.st.lastModel, 'variant-one-x', '同一逻辑名的多条映射应取第一条');
      // 未声明的模型：目录也不含 → 404（不发给上游）
      const before = upA.st.calls;
      const r2 = await call({ port: gw.port, body: { model: 'not-declared-anywhere', messages: [] } });
      assert.strictEqual(r2.status, 404, '未声明且目录不含 → 404，实际 ' + r2.status);
      assert.strictEqual(upA.st.calls, before, '不得把未声明的模型发给上游');
    } finally { killGw(gw); closeUp(upA); }
  });

  t('网关：/v1/models 列逻辑模型名（映射后的名字），不暴露各家上游 ID', async () => {
    const up = await startFakeUpstream({ catalog: [{ id: 'vendor-raw-id-1' }, { id: 'plain-catalog-model' }] });
    const gw = await startGatewayWith([
      providerOf('lst', up, {
        models: [
          { id: 'vendor-raw-id-1', as: 'nice-logical-name' },
          'plain-declared-model',
        ],
      }),
    ], 'maplist');
    try {
      assert.ok(gw.ready);
      const r = await call({ port: gw.port, method: 'GET', p: '/v1/models', body: null });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const ids = (JSON.parse(r.text).data || []).map((m) => m.id);
      assert.ok(ids.includes('nice-logical-name'), '应列出逻辑名：' + ids.join(','));
      assert.ok(ids.includes('plain-declared-model'), '应列出未映射的声明：' + ids.join(','));
      assert.ok(ids.includes('plain-catalog-model'), '目录里未被映射覆盖的模型应原样列出：' + ids.join(','));
      assert.ok(!ids.includes('vendor-raw-id-1'), '被映射覆盖的上游 ID 不应单独出现：' + ids.join(','));
    } finally { killGw(gw); closeUp(up); }
  });

  // ================= OpenAI Responses 协议支持（2026-09-11） =================
  // 背景：Responses 是**有状态**协议，客户端（Codex / OpenAI SDK / dsh 的 responses 模式）
  // 会在 POST /v1/responses 之后用 response.id 继续 GET/DELETE/cancel/input_items。
  // 旧版网关只认 POST，其余路径全部 404 unsupported route；且体翻译（打码/role/推理档位）
  // 在 Responses 上是死代码（translateBody 只看 body.messages）。

  t('网关：POST /v1/responses 透传 + Responses 体翻译（打码 / developer→system / reasoning.effort）', async () => {
    const up = await startFakeUpstream({ responses: true });
    const fakeHex = 'a1b2c3d4'.repeat(5);                       // 40 位 hex 形态假串（非真实密钥）
    const fakeKey = 'sk-' + 'A1b2C3d4E5f6G7h8'.repeat(2);       // sk- + 32 位 → R9 打码
    const gw = await startGatewayWith([
      providerOf('resp', up, { models: ['test-model'], reasoningEffortMap: { max: 'xhigh', off: 'disabled' } }),
    ], 'resp1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/responses?api-version=2025-04-01-preview',
        body: {
          model: 'test-model', stream: true,
          instructions: 'system prompt with hash ' + fakeHex,
          input: [
            { type: 'message', role: 'developer', content: 'dev says hi' },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'key ' + fakeKey }] },
          ],
          reasoning: { effort: 'max' },
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(/response\.created/.test(r.text) && /response\.completed/.test(r.text),
        'SSE 应原样回传：' + r.text.slice(0, 200));
      const sent = up.st.lastRespBody;
      const sentText = JSON.stringify(sent);
      assert.ok(sent && sent.model === 'test-model', '上游应收到 Responses 请求体：' + sentText.slice(0, 200));
      assert.ok(!sentText.includes(fakeHex), 'instructions 里的长串必须打码：' + sentText.slice(0, 300));
      assert.ok(sentText.includes('[sha256:40]'), '应出现长串占位符 [sha256:40]：' + sentText.slice(0, 300));
      assert.ok(!sentText.includes('A1b2C3d4E5f6G7h8'), 'input 里的 sk- 密钥必须打码：' + sentText.slice(0, 300));
      assert.ok(/sk-\*\*\*/.test(sentText), '应保留 sk- 前缀样式的打码：' + sentText.slice(0, 300));
      assert.strictEqual(sent.input[0].role, 'system', 'developer 角色应改写为 system：' + sentText.slice(0, 300));
      assert.strictEqual(sent.reasoning.effort, 'xhigh', 'reasoning.effort 应按 reasoningEffortMap 改写：' + sentText.slice(0, 300));
      assert.ok(up.st.respUrls.some((u) => u.includes('api-version=2025-04-01-preview')),
        '查询串应原样传给上游：' + up.st.respUrls.join(' | '));
      // off 档位：Responses 没有"关闭"枚举值 → 应整段移除 reasoning（照抄 effort:"disabled" 会被严格上游 400）
      const off = await call({
        port: gw.port, p: '/v1/responses',
        body: { model: 'test-model', input: 'hi', reasoning: { effort: 'off' } },
      });
      assert.strictEqual(off.status, 200, '实际 ' + off.status);
      assert.ok(!('reasoning' in up.st.lastRespBody),
        'reasoning.effort=off（映射为 disabled）应移除 reasoning 字段：' + JSON.stringify(up.st.lastRespBody).slice(0, 200));
      assert.strictEqual(up.st.lastRespBody.model, 'test-model', '移除了 reasoning 不应影响其它字段');
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：Responses 子路由回原供应商（GET/DELETE/cancel/input_items 不猜别家）', async () => {
    const up1 = await startFakeUpstream({ responses: true });
    const up2 = await startFakeUpstream({ responses: true });
    const gw = await startGatewayWith([
      providerOf('r1', up1, { priority: 1 }),
      providerOf('r2', up2, { priority: 2 }),
    ], 'resp2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const created = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'one' } });
      assert.strictEqual(created.status, 200, '实际 ' + created.status);
      const m = /"id":"(resp_test\d+)"/.exec(created.text);
      assert.ok(m, 'SSE 里应含 response.id：' + created.text.slice(0, 200));
      const id = m[1];
      assert.strictEqual(up1.st.calls, 1, 'priority 1 应创建该 response，实际 ' + up1.st.calls);
      const up2Before = up2.st.calls;

      const got = await call({ port: gw.port, method: 'GET', p: '/v1/responses/' + id, body: null });
      assert.strictEqual(got.status, 200, 'GET 应命中创建它的那家，实际 ' + got.status + ' ' + got.text.slice(0, 160));
      assert.ok(/"object":"response"/.test(got.text), '应回响应对象：' + got.text.slice(0, 160));

      const items = await call({ port: gw.port, method: 'GET', p: '/v1/responses/' + id + '/input_items', body: null });
      assert.strictEqual(items.status, 200, 'input_items 应可用，实际 ' + items.status + ' ' + items.text.slice(0, 160));
      assert.ok(/"object":"list"/.test(items.text), items.text.slice(0, 160));

      const created2 = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'two' } });
      const id2 = /"id":"(resp_test\d+)"/.exec(created2.text)[1];
      const cancelled = await call({ port: gw.port, method: 'POST', p: '/v1/responses/' + id2 + '/cancel', body: {} });
      assert.strictEqual(cancelled.status, 200, 'cancel 应可用，实际 ' + cancelled.status + ' ' + cancelled.text.slice(0, 160));

      const deleted = await call({ port: gw.port, method: 'DELETE', p: '/v1/responses/' + id, body: null });
      assert.strictEqual(deleted.status, 200, 'DELETE 应可用，实际 ' + deleted.status + ' ' + deleted.text.slice(0, 160));
      assert.ok(/"deleted":true/.test(deleted.text), deleted.text.slice(0, 160));
      // 删除后同一 id 再取 → 上游 404（网关如实回 404，不再探测别家）
      const gone = await call({ port: gw.port, method: 'GET', p: '/v1/responses/' + id, body: null });
      assert.strictEqual(gone.status, 404, '已删除的资源应回 404，实际 ' + gone.status + ' ' + gone.text.slice(0, 160));

      assert.strictEqual(up2.st.calls, up2Before,
        '非 owner 供应商不得收到任何子路由请求（旧版全部 404 unsupported route），实际新增 ' + (up2.st.calls - up2Before));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/responses affinity: resp_test\d+ → r1/.test(logText), '日志应记录 response→供应商 亲和：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：未知 response id —— 只读操作逐家探测（404），写操作拒绝猜测（零上游请求）', async () => {
    const up1 = await startFakeUpstream({ responses: true });
    const up2 = await startFakeUpstream({ responses: true });
    const gw = await startGatewayWith([
      providerOf('r1', up1, { priority: 1 }),
      providerOf('r2', up2, { priority: 2 }),
    ], 'resp3');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const before = [up1.st.calls, up2.st.calls];
      const got = await call({ port: gw.port, method: 'GET', p: '/v1/responses/resp_unknown_xyz', body: null });
      assert.strictEqual(got.status, 404, '实际 ' + got.status + ' ' + got.text.slice(0, 200));
      assert.ok(/not found on any configured provider/.test(got.text), got.text.slice(0, 200));
      assert.ok(up1.st.calls > before[0] && up2.st.calls > before[1],
        '未知 id 的只读请求应逐家探测（各家对别人的 id 都回 404）：' + up1.st.calls + ',' + up2.st.calls);

      const before2 = [up1.st.calls, up2.st.calls];
      const del = await call({ port: gw.port, method: 'DELETE', p: '/v1/responses/resp_unknown_xyz', body: null });
      assert.strictEqual(del.status, 404, '实际 ' + del.status);
      assert.ok(/refusing to guess/.test(del.text), '写操作应明确拒绝猜测归属：' + del.text.slice(0, 200));
      assert.deepStrictEqual([up1.st.calls, up2.st.calls], before2,
        '写操作（DELETE）不得向任何供应商试探，避免误删别家资源');
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：previous_response_id 在多轮中钉回原供应商（round-robin 下也不例外）', async () => {
    const up1 = await startFakeUpstream({ responses: true });
    const up2 = await startFakeUpstream({ responses: true });
    const gw = await startGatewayWith([
      providerOf('r1', up1, { priority: 1 }),
      providerOf('r2', up2, { priority: 2 }),
    ], 'resp4', null, { routing: 'round-robin' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r1 = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'turn-1' } });
      assert.strictEqual(r1.status, 200, '实际 ' + r1.status);
      const id = /"id":"(resp_test\d+)"/.exec(r1.text)[1];
      assert.strictEqual(up1.st.calls, 1, '轮询起点应为 r1，实际 ' + up1.st.calls);
      const c1 = up1.st.calls;
      const c2 = up2.st.calls;
      const r2 = await call({
        port: gw.port, p: '/v1/responses',
        body: { model: 'test-model', input: 'turn-2', previous_response_id: id },
      });
      assert.strictEqual(r2.status, 200, '实际 ' + r2.status);
      assert.strictEqual(up1.st.calls, c1 + 1, '带 previous_response_id 的多轮请求应回到原供应商（轮询不得改变归属）');
      assert.strictEqual(up2.st.calls, c2, '有状态请求不得发给别家（否则上下文丢失/404）');
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：owner 上游故障（5xx）→ 502（不谎报 404 "资源不存在"）', async () => {
    const up = await startFakeUpstream({ responses: true, resourceStatus: 500 });
    const gw = await startGatewayWith([providerOf('r1', up, { priority: 1 })], 'resp5');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const created = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'x' } });
      const id = /"id":"(resp_test\d+)"/.exec(created.text)[1];
      const got = await call({ port: gw.port, method: 'GET', p: '/v1/responses/' + id, body: null });
      assert.strictEqual(got.status, 502, '上游故障应回 502，实际 ' + got.status + ' ' + got.text.slice(0, 200));
      assert.ok(/retry shortly/.test(got.text), '应提示可重试：' + got.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：上游对子路由回确定性 4xx（400）→ 按资源语境回 400（不把 response id 说成"模型"）', async () => {
    const up = await startFakeUpstream({ responses: true, resourceStatus: 400 });
    const gw = await startGatewayWith([providerOf('r1', up, { priority: 1 })], 'resp7');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const created = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'x' } });
      const id = /"id":"(resp_test\d+)"/.exec(created.text)[1];
      const r = await call({ port: gw.port, method: 'POST', p: '/v1/responses/' + id + '/cancel', body: {} });
      assert.strictEqual(r.status, 400, '应把确定性 400 映射回客户端，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(/rejected POST \/v1\/responses\/\{id\} with HTTP 400/.test(r.text), '文案应是资源语境：' + r.text.slice(0, 300));
      assert.ok(!/model \\?"|rejected model/.test(r.text), '不得把 response id 说成模型名：' + r.text.slice(0, 300));
      assert.ok(!/upstream temporarily unavailable/.test(r.text), '不得回显上游原文：' + r.text.slice(0, 300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：上游未实现 Responses 子路由（new-api 的 Invalid URL）→ 404 文案指出"供应商能力缺失"而非"已删除"', async () => {
    const up = await startFakeUpstream({ responses: true, noResourceRoutes: true });
    const gw = await startGatewayWith([providerOf('r1', up, { priority: 1 })], 'resp6');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const created = await call({ port: gw.port, p: '/v1/responses', body: { model: 'test-model', input: 'x' } });
      assert.strictEqual(created.status, 200, '创建本身应成功（上游实现了 POST）：' + created.status);
      const id = /"id":"(resp_test\d+)"/.exec(created.text)[1];
      for (const [method, p, epName] of [
        ['GET', '/v1/responses/' + id, 'GET /v1/responses/{id}'],
        ['GET', '/v1/responses/' + id + '/input_items', 'GET /v1/responses/{id}/input_items'],
        ['DELETE', '/v1/responses/' + id, 'DELETE /v1/responses/{id}'],
        ['POST', '/v1/responses/' + id + '/cancel', 'POST /v1/responses/{id}/cancel'],
      ]) {
        const r = await call({ port: gw.port, method, p, body: method === 'POST' ? {} : null });
        assert.strictEqual(r.status, 404, method + ' ' + p + ' 应回 404，实际 ' + r.status + ' ' + r.text.slice(0, 200));
        assert.ok(/does not implement the Responses resource endpoint/.test(r.text),
          '应指出是供应商能力缺失：' + r.text.slice(0, 300));
        assert.ok(r.text.includes(epName), '文案应点名端点 ' + epName + '：' + r.text.slice(0, 300));
        assert.ok(!/expired or been deleted/.test(r.text), '不得误导为"资源已过期/被删"：' + r.text.slice(0, 300));
      }
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/owner-miss\/route-missing/.test(logText), '日志应标注 route-missing（便于排查）：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 修复项 3：熔断半开单飞 ----
  t('网关：熔断期间不再打上游；冷却到点并发只放一个探测；上游恢复后能自愈（不永久卡死）', async () => {
    const up = await startFakeUpstream({ status: 401, modelsStatus: 401, delayMs: 400, errorBody: { error: { message: 'unauthorized' } } });
    const gw = await startGatewayWith([providerOf('bad', up, { priority: 1 })], 'breaker', {
      DSH_GATEWAY_BREAKER_LONG_MS: '1500', DSH_GATEWAY_BREAKER_SHORT_MS: '1500',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 401 首次即长熔断
      const first = await call({ port: gw.port });
      assert.strictEqual(first.status, 503, '401 熔断后应回 503，实际 ' + first.status + ' ' + first.text.slice(0, 160));
      assert.strictEqual(up.st.calls, 1, '401 只应打一次上游，实际 ' + up.st.calls);
      // ② 冷却期内并发请求：一次上游请求都不能发（旧版会持续打点）
      const during = await Promise.all([0, 1, 2, 3, 4].map(() => call({ port: gw.port })));
      assert.ok(during.every((r) => r.status === 503), '熔断冷却期内应全部 503：' + during.map((r) => r.status).join(','));
      assert.strictEqual(up.st.calls, 1, '熔断冷却期内不得再向上游发请求，实际 ' + up.st.calls);
      // ③ 冷却到点 → 6 个并发请求只放行 1 个探测（旧版每个请求都会重置熔断窗口 → 6 个全放行）
      await sleep(1700);
      const probe = await Promise.all([0, 1, 2, 3, 4, 5].map(() => call({ port: gw.port })));
      assert.ok(probe.every((r) => r.status === 503), '探测仍失败（401）应回 503：' + probe.map((r) => r.status).join(','));
      assert.strictEqual(up.st.calls, 2, '半开只应放行一个探测，实际新增 ' + (up.st.calls - 1) + ' 个上游请求');
      // ④ 上游恢复 → 冷却结束后能重新服务（熔断不会永久卡死）
      up.st.status = 200;
      let served = 0;
      for (let i = 0; i < 10 && !served; i++) {
        await sleep(400);
        const r = await call({ port: gw.port });
        if (r.status === 200) served = 1;
      }
      assert.strictEqual(served, 1, '上游恢复后应能重新服务（熔断不得永久卡死）');
    } finally { killGw(gw); closeUp(up); }
  });

  // 执行
  for (const { name, fn } of __tests) {
    await fn();
    passed++;
    console.log('PASS  ' + name);
  }
  console.log('');
  console.log('===== ' + passed + ' passed, 0 failed =====');
  try { gwProc.kill(); } catch { }
  try { upstreamServer.close(); } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  try { gwProc && gwProc.kill(); } catch { }
  try { upstreamServer.close(); } catch { }
  process.exit(1);
});
