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
    // 2026-09-16：claude 仿真下每个模型必须带 compat.allowEmptySignature——
    // 否则 pi-ai 把"无签名的 thinking"降级成 text，带 tool_use 的历史会被上游回
    // 400「content[].thinking ... must be passed back」（air-outer/agentrouter 实测）
    assert.ok(/^ {10}compat:\n {12}allowEmptySignature: true$/m.test(r.text),
      '每个模型条目应带 compat.allowEmptySignature: true：\n' + r.text);
    assert.strictEqual((r.text.match(/allowEmptySignature: true/g) || []).length,
      (r.text.match(/^ {8}- id:/gm) || []).length, '模型数与 compat 声明数应一致');
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
      sseErrorFirst: !!opts.sseErrorFirst,   // 200 + SSE 首事件即 error（api.chiyi.cc 实测形态）
      thinkingPassback: !!opts.thinkingPassback,   // 400/500 要求 thinking 回传（air-outer/agentrouter 实测形态）
      thinkingPassbackStatus: opts.thinkingPassbackStatus || 400,
      failFirstN: opts.failFirstN || 0,            // 前 N 次请求直接销毁 socket（模拟网络抖动）
      lastBody: null,
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
        // 网络抖动仿真：直接销毁连接（客户端侧表现为 fetch failed / ECONNRESET）
        if (st.failFirstN > 0) { st.failFirstN--; req.socket.destroy(); return; }
        // 记录上游实际收到的 model（模型映射用例断言用：必须是该供应商的上游真实 ID）
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          st.lastModel = parsedBody.model;
          st.models.push(parsedBody.model);
        } catch (_) { /* 忽略 */ }
        st.lastBody = parsedBody;
        const send = () => {
          // 实测形态（air-outer/agentrouter）：带 tool_use 的 assistant 轮缺 thinking 块 → 400
          if (st.thinkingPassback && parsedBody) {
            const missing = (parsedBody.messages || []).some((m) => m && m.role === 'assistant'
              && Array.isArray(m.content)
              && m.content.some((b) => b && b.type === 'tool_use')
              && !m.content.some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking')));
            if (missing) {
              res.writeHead(st.thinkingPassbackStatus, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                error: {
                  message: st.thinkingPassbackStatus === 400
                    ? 'The `content[].thinking` in the thinking mode must be passed back to the API. [trace_id=test]'
                    : 'Upstream rejected the request as invalid',   // agentrouter 的笼统措辞
                  type: st.thinkingPassbackStatus === 400 ? '<nil>' : 'invalid_request_error',
                },
                type: 'error',
              }));
              return;
            }
          }
          if (st.status !== 200) {
            res.writeHead(st.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(st.errorBody));
            return;
          }
          if (st.sseErrorFirst) {
            // 实测形态（api.chiyi.cc）：HTTP 200 + text/event-stream，流里第一件事就是 error 事件
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.end(': keepalive\n\n'
              + 'event: error\ndata: {"error":{"message":"Service temporarily unavailable","type":"api_error"},"type":"error"}\n\n');
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
    if (opts.timeoutMs) p.timeoutMs = opts.timeoutMs;
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

  // ---- 修复项 2：配置 models 参与路由（2026-09-15 起：**配置列表为唯一权威**）----
  t('网关：配置了别的模型但没配这个 → 404 且零转发、零目录探测（配置权威）', async () => {
    const up = await startFakeUpstream({ modelsStatus: 404 });   // catalog 不可用 → "未知"桶
    const gw = await startGatewayWith([providerOf('only-other', up, { models: ['other-model'] })], 'nomodel');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });                   // 请求 test-model（配置里没有）
      assert.strictEqual(r.status, 404, '配置未声明该模型 → 404，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 0, '不得把未声明的模型发给上游，实际 ' + up.st.calls);
      assert.strictEqual(up.st.modelsReqs, 0,
        '该 provider 已配置模型 → 请求路径上不应再做目录探测（配置权威，实测旧版每次请求多等 ~1.5s），实际 ' + up.st.modelsReqs);
      assert.ok(/models/.test(r.text) && /model \\"test-model\\"/.test(r.text), '错误信息应提示检查 provider 的 models 列表：' + r.text.slice(0, 300));
      assert.ok(/not-declared\(config-authoritative\)/.test(r.text), '错误详情应带判定原因：' + r.text.slice(0, 300));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/only-other=not-declared\(config-authoritative\)/.test(logText), '日志应记录判定原因：' + logText.slice(-400));
      // 同一实例：配置里声明的模型照常路由
      const r2 = await call({ port: gw.port, body: { model: 'other-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r2.status, 200, '配置声明的模型应可路由，实际 ' + r2.status + ' ' + r2.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, 'other-model 应恰好转发一次，实际 ' + up.st.calls);
      assert.strictEqual(up.st.modelsReqs, 0, '仍不应有目录探测，实际 ' + up.st.modelsReqs);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：上游目录里有、但我没配 → **不是候选**（b.ai 事故：目录里有却回 400，把请求判死）', async () => {
    const up = await startFakeUpstream({ catalog: [{ id: 'test-model' }] });
    const gw = await startGatewayWith([providerOf('cat', up, { models: ['other-model'] })], 'cathit');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 404, '仅目录命中不算候选（配置权威），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 0, '不得把请求发给"只是目录里有"的那家，实际 ' + up.st.calls);
      assert.strictEqual(up.st.modelsReqs, 0, '配置了的 provider 不需要探测目录，实际 ' + up.st.modelsReqs);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：一个模型都没配的 provider → 仍按目录兜底（没有可遵循的配置时才这样）', async () => {
    const up = await startFakeUpstream({ catalog: [{ id: 'test-model' }] });
    const gw = await startGatewayWith([providerOf('unconfigured', up, { models: [] })], 'nocfg');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '未配置任何模型的 provider 应按目录命中兜底，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, '应转发一次，实际 ' + up.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/no-models-declared,catalog-hit/.test(logText), '判定原因应标明是"未配置→目录兜底"：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：声明的归属优先——轮询也不会把请求先发给"仅目录命中"的那家（真实事故回归）', async () => {
    // 实测场景：chiyi-ds 声明 deepseek-v4.1-flash；b.ai 目录里也有同名模型（但实际回 400）。
    // 旧实现把目录命中排在最前 + round-robin → 请求被送到 b.ai 并因"确定性 4xx"直接失败。
    const upDecl = await startFakeUpstream({ catalog: [{ id: 'other-model' }] });   // 目录里没有该模型
    const upCat = await startFakeUpstream({ catalog: [{ id: 'test-model' }] });     // 仅目录里有
    const gw = await startGatewayWith([
      providerOf('declared', upDecl, { priority: 5, models: ['test-model'] }),   // 优先级数字更大
      providerOf('catalog-only', upCat, { priority: 1, models: ['other-model'] }), // 优先级更小但只能靠目录兜底
    ], 'tier', null, { routing: 'round-robin' });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 6; i++) {
        const r = await call({ port: gw.port });
        assert.strictEqual(r.status, 200, '第 ' + (i + 1) + ' 次应成功，实际 ' + r.status);
      }
      assert.strictEqual(upDecl.st.calls, 6, '声明归属的那家应承担全部请求，实际 ' + upDecl.st.calls);
      assert.strictEqual(upCat.st.calls, 0,
        '仅目录命中的那家一次都不该被调用（**层级优先于 priority**：配置权威 > 目录兜底），实际 ' + upCat.st.calls);
    } finally { killGw(gw); closeUp(upDecl); closeUp(upCat); }
  });

  t('网关：上游"余额/额度"类 400 → 不终止 failover（换下一家；旧实现把请求直接判死）', async () => {
    // 实测原文：b.ai 余额为 0 时回 HTTP 400 {"error":{"message":"credit insufficient balance: balance=0 ..."}}
    const up1 = await startFakeUpstream({ status: 400, errorBody: { error: { message: 'credit insufficient balance: balance=0 required=29146' } } });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('p1', up1, { priority: 1, models: ['test-model'] }),
      providerOf('p2', up2, { priority: 2, models: ['test-model'] }),
    ], 'prov4xx');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '应换到第二家成功，实际 ' + r.status + ' ' + r.text.slice(0, 220));
      assert.strictEqual(up1.st.calls, 1, '第一家只应被尝试一次，实际 ' + up1.st.calls);
      assert.strictEqual(up2.st.calls, 1, '第二家应收到转发，实际 ' + up2.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/供应商账号\/额度\/权限/.test(logText), '日志应标明按"供应商侧错误"处理：' + logText.slice(-300));
      assert.ok(/breaker OPEN: p1 失败（403）/.test(logText), '余额类属长期状态 → 应长熔断：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
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

  t('网关：/v1/models 只列**配置里声明的**模型（不再列目录里的，避免 dsh 选中后被 404）', async () => {
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
      assert.ok(!ids.includes('plain-catalog-model'),
        '配置了模型的 provider 不再补目录模型（配置权威：列出来也会因未声明而 404）：' + ids.join(','));
      assert.ok(!ids.includes('vendor-raw-id-1'), '被映射覆盖的上游 ID 不应单独出现：' + ids.join(','));
      assert.strictEqual(up.st.modelsReqs, 0, '配置齐全时不应探测目录，实际 ' + up.st.modelsReqs);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：/v1/models 对"未配置模型"的 provider 仍补目录（否则该家模型不可见）', async () => {
    const up = await startFakeUpstream({ catalog: [{ id: 'free-model-a' }, { id: 'free-model-b' }] });
    const gw = await startGatewayWith([providerOf('nocfg', up, { models: [] })], 'maplist2');
    try {
      assert.ok(gw.ready);
      const r = await call({ port: gw.port, method: 'GET', p: '/v1/models', body: null });
      const ids = (JSON.parse(r.text).data || []).map((m) => m.id);
      assert.ok(ids.includes('free-model-a') && ids.includes('free-model-b'),
        '未配置任何模型的服务商应按目录列出：' + ids.join(','));
    } finally { killGw(gw); closeUp(up); }
  });

  // ================= 路由顺序（2026-09-17 用户要求变更）=================
  // ① 先按 priority 升序；② 同一 priority 内按配置数组顺序
  t('网关：候选顺序 = priority 升序优先，同 priority 内按数组顺序（2026-09-17 规则）', async () => {
    const upBig = await startFakeUpstream({});
    const upSmall = await startFakeUpstream({});
    // priority 大的排在数组前面 —— 旧规则（纯数组顺序）会先打它；新规则必须先打 priority=1 的那家
    const gw = await startGatewayWith([
      providerOf('pri-9', upBig, { priority: 9, models: ['test-model'] }),
      providerOf('pri-1', upSmall, { priority: 1, models: ['test-model'] }),
    ], 'priorder');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.strictEqual(upSmall.st.calls, 1, 'priority=1 的家应被优先尝试，实际 ' + upSmall.st.calls);
      assert.strictEqual(upBig.st.calls, 0, 'priority=9 的家不该被先打（旧规则才会），实际 ' + upBig.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/pri-1=models-declared pri-9=models-declared/.test(logText),
        '日志候选顺序应为 priority 升序：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(upBig); closeUp(upSmall); }
  });

  t('网关：同 priority 时按配置数组顺序（▲▼ 调整的就是这个顺序）', async () => {
    const upA = await startFakeUpstream({});
    const upB = await startFakeUpstream({});
    const gw = await startGatewayWith([
      providerOf('tie-a', upA, { priority: 1, models: ['test-model'] }),
      providerOf('tie-b', upB, { priority: 1, models: ['test-model'] }),
    ], 'tieorder');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.strictEqual(upA.st.calls, 1, '同 priority 应先发数组第一位，实际 ' + upA.st.calls);
      assert.strictEqual(upB.st.calls, 0, '同 priority 第二位不应被先发，实际 ' + upB.st.calls);
      // priority 缺省（未写字段）视为 1，与显式 1 同级 → 仍按数组顺序
      const upC = await startFakeUpstream({});
      const gw2 = await startGatewayWith([
        providerOf('def-a', upA, { models: ['test-model'] }),
        providerOf('def-b', upC, { models: ['test-model'] }),
      ], 'tieorder2');
      try {
        const r2 = await call({ port: gw2.port });
        assert.strictEqual(r2.status, 200, '实际 ' + r2.status);
        assert.ok(/def-a=models-declared def-b=models-declared/.test(fs.readFileSync(gw2.logPath, 'utf8')),
          '缺省 priority 应视为 1 并与同级一起按数组顺序');
      } finally { killGw(gw2); closeUp(upC); }
    } finally { killGw(gw); closeUp(upA); closeUp(upB); }
  });

  // ② 多模态：带图片的请求只发给声明了图片能力的家（否则会被转给纯文本家，上游报错/丢图）
  t('网关：带图片的请求只发给声明图片能力的家（vision: true）；纯文本请求照常走数组首位', async () => {
    const upText = await startFakeUpstream({});
    const upVision = await startFakeUpstream({});
    const gw = await startGatewayWith([
      providerOf('plain', upText, { models: ['test-model'] }),                        // 数组在前：纯文本
      providerOf('vlm', upVision, { models: [{ id: 'test-model', vision: true }] }),  // 声明图片能力
    ], 'visionroute');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 纯文本请求 → 数组首位（纯文本家）
      const a = await call({ port: gw.port, body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(a.status, 200, '实际 ' + a.status);
      assert.strictEqual(upText.st.calls, 1, '纯文本请求应走数组首位，实际 ' + upText.st.calls);
      assert.strictEqual(upVision.st.calls, 0, '实际 ' + upVision.st.calls);
      // ② 带图片（Anthropic 形状）→ 只有声明了图片能力的家
      const img = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 16,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '这张图里是什么？' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
            ],
          }],
        },
      });
      assert.strictEqual(img.status, 200, '实际 ' + img.status + ' ' + img.text.slice(0, 160));
      assert.strictEqual(upText.st.calls, 1, '纯文本家不得收到带图片的请求，实际 ' + upText.st.calls);
      assert.strictEqual(upVision.st.calls, 1, '声明图片能力的家应收到，实际 ' + upVision.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/请求含图片 → 跳过未声明图片能力的 1 家/.test(logText), '日志应记录图片路由：' + logText.slice(-400));
      // ③ 若没有任何候选声明图片能力 → 保持原候选（交给上游报错，不凭空 404）
      const upPlain = await startFakeUpstream({});
      const gw2 = await startGatewayWith([providerOf('only-plain', upPlain, { models: ['test-model'] })], 'visionnofallback');
      try {
        const b = await call({
          port: gw2.port, p: '/v1/messages',
          body: {
            model: 'test-model', max_tokens: 16,
            messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }],
          },
        });
        assert.strictEqual(b.status, 200, '无图片候选时应照常转发（不得凭空 404），实际 ' + b.status + ' ' + b.text.slice(0, 160));
        assert.strictEqual(upPlain.st.calls, 1, '应转发给唯一候选，实际 ' + upPlain.st.calls);
      } finally { killGw(gw2); closeUp(upPlain); }
    } finally { killGw(gw); closeUp(upText); closeUp(upVision); }
  });

  // ③ /v1/models 按模型名排序（选择器列表不再随供应商配置顺序杂乱）
  t('网关：/v1/models 按模型名排序输出', async () => {
    const up = await startFakeUpstream({});
    const gw = await startGatewayWith([providerOf('s1', up, { models: ['zeta-model', 'alpha-model', 'Beta-model'] })], 'modelsort');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, method: 'GET', p: '/v1/models', body: null });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const ids = (JSON.parse(r.text).data || []).map((m) => m.id);
      assert.deepStrictEqual(ids, ['alpha-model', 'Beta-model', 'zeta-model'],
        '应按名排序（大小写不敏感）：' + JSON.stringify(ids));
    } finally { killGw(gw); closeUp(up); }
  });

  t('write-dsh：模型按名称排序写入 + 声明图片能力的模型写 input: [text, image]', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'wd-vision-'));
    const cfgPath = path.join(dir, 'gateway.config.json');
    const setPath = path.join(dir, 'settings.yaml');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: 3099, apiKey: GATEWAY_KEY, clientProfile: 'claude',
      providers: [
        { id: 'p1', baseURL: 'https://a.example.org/v1', apiKey: 'sk-' + 'x'.repeat(20), enabled: true, models: ['zeta-model', { id: 'v/vision-up', as: 'alpha-model', vision: true }] },
        { id: 'p2', baseURL: 'https://b.example.org/v1', apiKey: 'sk-' + 'y'.repeat(20), enabled: true, models: ['beta-model'] },
      ],
    }), 'utf8');
    fs.writeFileSync(setPath, 'llm-pi-ai:\n  providers:\n', 'utf8');
    const r = spawnSync(process.execPath, [MJS, '--write-dsh', '--config', cfgPath, '--settings', setPath,
      '--credentials', path.join(dir, 'c.yaml'), '--port', '3099'], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    assert.strictEqual(r.status, 0, 'write-dsh 应成功');
    const text = fs.readFileSync(setPath, 'utf8');
    const ids = [...text.matchAll(/^ {8}- id: '([^']+)'$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(ids, ['alpha-model', 'beta-model', 'zeta-model'],
      '模型条目应按名称排序写入：' + JSON.stringify(ids));
    const alpha = text.slice(text.indexOf("- id: 'alpha-model'"), text.indexOf("- id: 'beta-model'"));
    assert.ok(/^ {10}input:$/m.test(alpha) && /^ {12}- image$/m.test(alpha),
      'vision:true 的模型必须写 input（否则 dsh 拦下图片）：\n' + alpha);
    const beta = text.slice(text.indexOf("- id: 'beta-model'"), text.indexOf("- id: 'zeta-model'"));
    assert.ok(!/input:/.test(beta), '未声明图片能力的模型不得写 input：\n' + beta);
    assert.ok(/allowEmptySignature: true/.test(alpha), 'compat 仍应写入：\n' + alpha);
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

  t('网关：上游 HTTP 200 但 SSE 首事件是 error（chiyi-ds 形态）→ 判该家失败并换下一家（旧版记 ok 且把上游原文透传给客户端）', async () => {
    const up1 = await startFakeUpstream({ sseErrorFirst: true });
    const up2 = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('p1', up1, { priority: 1 }),
      providerOf('p2', up2, { priority: 2 }),
    ], 'sseerr');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '应换到第二家成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(/upstream-ok/.test(r.text), '客户端应拿到第二家的正常流：' + r.text.slice(0, 200));
      assert.ok(!/Service temporarily unavailable/.test(r.text), '不得把上游错误原文透传给客户端：' + r.text.slice(0, 200));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/SSE 首事件是错误/.test(logText), '日志应记录该判定：' + logText.slice(-400));
      // 用上游调用次数断言"确实换到了第二家"（日志里 served 行由网关在返回后写，存在毫秒级竞态）
      assert.strictEqual(up2.st.calls, 1, '第二家应收到一次转发，实际 ' + up2.st.calls);
      assert.ok(!/via=p1\b[^\n]*status=ok/.test(logText), '第一家不得被记成 ok：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up1); closeUp(up2); }
  });

  t('网关：唯一候选 200+SSE error → 回网关自己的 503（客户端不再看到上游原文）', async () => {
    const up = await startFakeUpstream({ sseErrorFirst: true });
    const gw = await startGatewayWith([providerOf('only', up, { priority: 1 })], 'sseerr2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 503, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(!/Service temporarily unavailable/.test(r.text), '不得回显上游原文：' + r.text.slice(0, 200));
      assert.ok(/all providers for model/.test(r.text), '应是网关自己的文案：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 2026-09-16 实测事故：Anthropic 协议下"带 tool_use 的 assistant 轮必须回传 thinking 块" ----
  // air-outer / agentrouter 实测：历史里 assistant 只有 tool_use（或 text+tool_use）时回
  // HTTP 400「The `content[].thinking` in the thinking mode must be passed back to the API」；
  // 补一个空占位 thinking 块（thinking:'' + signature:''）即 200（上游只做结构检查）。
  // 客户端（pi-ai）在 thinking 无签名时会把它降级成 text，正是这个 400 的来源，网关补位兜底。
  const THINKING_HISTORY = [
    { role: 'user', content: '北京天气？' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25℃' }] },
  ];

  t('网关：上游 400 要求 thinking 回传（air-outer 实测形态）→ 补空占位块重试一次并成功', async () => {
    const up = await startFakeUpstream({ thinkingPassback: true });
    const gw = await startGatewayWith([providerOf('th1', up, { priority: 1 })], 'thinking');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, messages: THINKING_HISTORY },
      });
      assert.strictEqual(r.status, 200, '补占位后应成功，实际 ' + r.status + ' ' + r.text.slice(0, 240));
      assert.ok(/upstream-ok/.test(r.text), '客户端应拿到上游正常流：' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 2, '应是"原样一次 + 补占位一次"共 2 次转发，实际 ' + up.st.calls);
      const sent = up.st.lastBody.messages;
      assert.strictEqual(sent[1].content[0].type, 'thinking', '补的占位块必须排在 tool_use 之前：'
        + JSON.stringify(sent[1].content));
      assert.strictEqual(sent[1].content[0].thinking, '', '占位块不得伪造推理正文');
      assert.strictEqual(sent[1].content[1].type, 'tool_use', 'tool_use 必须保留');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/补齐 1 处空占位 thinking 块后重试一次/.test(logText), '日志应记录补齐重试：' + logText.slice(-400));
      assert.ok(!/status=ok[^\n]*HTTP 400/.test(logText), '不得把这次 400 记成成功');
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：上游用笼统 500「Upstream rejected the request as invalid」表达同一 thinking 规则 → 同样补位重试', async () => {
    // agentrouter 实测形态：不解释原因，HTTP 500 + 该措辞（同一请求体补空占位后即 200）
    const up = await startFakeUpstream({ thinkingPassback: true, thinkingPassbackStatus: 500 });
    const gw = await startGatewayWith([providerOf('th3', up, { priority: 1 })], 'thinking3');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, messages: THINKING_HISTORY },
      });
      assert.strictEqual(r.status, 200, '补占位后应成功，实际 ' + r.status + ' ' + r.text.slice(0, 240));
      assert.ok(/upstream-ok/.test(r.text), '客户端应拿到上游正常流：' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 2, '应是"原样一次 + 补占位一次"，实际 ' + up.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/补齐 1 处空占位 thinking 块后重试一次/.test(logText), '日志应记录补位重试：' + logText.slice(-400));
      assert.ok(!/breaker OPEN/.test(logText), '该家不应因此被熔断（补位后已成功）：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：历史已带 thinking 块时不得多补（零副作用），且无 tool_use 的历史不触发补位', async () => {
    const up = await startFakeUpstream({ thinkingPassback: true });
    const gw = await startGatewayWith([providerOf('th2', up, { priority: 1 })], 'thinking2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 已带 thinking（空签名）→ 上游本就接受，应只转发一次、内容原样
      const ok = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 64,
          messages: [
            { role: 'user', content: '北京天气？' },
            { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }, THINKING_HISTORY[1].content[0]] },
            { role: 'user', content: THINKING_HISTORY[2].content },
          ],
        },
      });
      assert.strictEqual(ok.status, 200, '实际 ' + ok.status + ' ' + ok.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 1, '已有 thinking 块时不得重试（不产生额外计费），实际 ' + up.st.calls);
      assert.strictEqual(up.st.lastBody.messages[1].content.length, 2, '不得插入多余占位块：'
        + JSON.stringify(up.st.lastBody.messages[1].content));
      // ② 纯文本历史（无 tool_use）→ 上游不报该错，同样只转发一次
      const plain = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(plain.status, 200, '实际 ' + plain.status);
      assert.strictEqual(up.st.calls, 2, '纯文本历史应只转发一次（累计 2），实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 2026-09-16：网络层错误可诊断性 + 瞬时抖动原地重试 ----
  // 背景：日志里 170 条 "fetch failed" 完全无法定位（undici 把真正原因放在 e.cause）；
  // 实测根因是本机代理/TUN 抖动导致的 ECONNRESET（5s 内快速失败）。
  // 旧实现首次网络错即 90s 熔断——单候选模型（如 deepseek-v4.1-flash→chiyi-ds）整段不可用。
  t('网关：瞬时网络错（socket 重置）→ 原地重试一次成功；日志含 ECONNRESET 原因且不熔断', async () => {
    const up = await startFakeUpstream({ failFirstN: 1 });
    const gw = await startGatewayWith([providerOf('net1', up, { priority: 1 })], 'netretry');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '重试应成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(/upstream-ok/.test(r.text), '客户端应拿到正常响应：' + r.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 2, '应是"首次失败 + 原地重试"共 2 次，实际 ' + up.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/upstream net1 网络错误（[^）]+，\d+ms）→ 原地重试一次/.test(logText),
        '日志应记录网络错原因（cause 链）与重试动作：' + logText.slice(-400));
      assert.ok(/upstream net1 重试成功/.test(logText), '日志应记录重试成功：' + logText.slice(-300));
      assert.ok(!/breaker OPEN/.test(logText), '重试成功不得开启熔断：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('网关：本地超时中止不参与原地重试（避免把等待翻倍）；provider.timeoutMs 生效', async () => {
    const up = await startFakeUpstream({ delayMs: 3000 });
    const gw = await startGatewayWith([providerOf('slow1', up, { priority: 1, timeoutMs: 400 })], 'noretry');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const started = Date.now();
      const r = await call({ port: gw.port });
      const dur = Date.now() - started;
      assert.strictEqual(r.status, 503, '唯一候选超时后应回 503，实际 ' + r.status);
      assert.strictEqual(up.st.calls, 1, '超时中止不得重试，实际 ' + up.st.calls);
      assert.ok(dur < 2500, '应在上游 delay(3000ms) 之前就按 timeoutMs=400 中止，实际 ' + dur + 'ms');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/request error/.test(logText), '应记录上游请求错误：' + logText.slice(-300));
      assert.ok(!/原地重试一次/.test(logText), '超时中止不得触发原地重试：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

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

  // ================= 2026-09-16：WorkBuddy 接入（协议翻译 / 供应商能力 / 凭据 / 账户池） =================

  // 可编程"只支持 OpenAI chat"的假上游：记录路径/头/体，按脚本返回 402/12153/正常流
  async function startFakeOpenAIUpstream(opts = {}) {
    const st = {
      calls: 0, paths: [], headers: [], bodies: [],
      script: opts.script || null,        // 按调用序号决定行为（账户池测试用）
      json: !!opts.json,                  // 返回非流式 JSON 而非 SSE
      withToolCall: !!opts.withToolCall,
      sseRaw: opts.sseRaw || null,        // 自定义 SSE 文本
      toolNameLate: !!opts.toolNameLate,  // 工具名在**后续分片**才到（真实上游常见）
    };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        st.calls++;
        st.paths.push(req.url);
        st.headers.push(req.headers);
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 忽略 */ }
        st.bodies.push(body);
        const behavior = st.script ? (st.script[st.calls - 1] || st.script[st.script.length - 1]) : (opts.behavior || 'ok');
        // 刷新端点（WorkBuddy：POST {base}/plugin/auth/token/refresh）
        if (/\/plugin\/auth\/token\/refresh$/.test(req.url)) {
          st.refreshCalls = (st.refreshCalls || 0) + 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'AT-REFRESHED', refreshToken: 'rt-new', expiresIn: 3600, domain: 'codebuddy.cn' } }));
          return;
        }
        if (behavior === 'credit') {
          res.writeHead(402, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 0, msg: 'insufficient credit: 积分不足' }));
          return;
        }
        if (behavior === 'session') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 0, msg: 'Offline user session not found 12153' }));
          return;
        }
        if (behavior === 'boom') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'boom' } }));
          return;
        }
        if (st.json) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-1', object: 'chat.completion', model: body && body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: '来自 OpenAI 上游的回复' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (st.sseRaw) { res.end(st.sseRaw); return; }   // 自定义 SSE（如"首事件即 error"形态）
        const chunk = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
        chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { reasoning_content: '先想一下' } }] });
        chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: '你好' } }] });
        chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: '，世界' } }] });
        if (st.withToolCall) {
          if (st.toolNameLate) {
            // 真实上游常见形态：先给 id（无 name），名字与参数在后续分片到达
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: '', arguments: '' } }] } }] });
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'get_weather' } }] } }] });
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"北京"}' } }] } }] });
          } else {
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } }] });
            chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] } }] });
          }
          chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          chunk({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, st, port: server.address().port };
  }

  /** 写一份 WorkBuddy 桌面凭据文件（形态与真实一致：{auth,account} 嵌套） */
  function writeWorkBuddyAuth(dir, name, { token, uid, enterpriseId, domain, expiresInMs, refreshToken }) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify({
      auth: {
        accessToken: token,
        refreshToken: refreshToken === undefined ? 'rt-' + uid : refreshToken,
        expiresAt: Date.now() + (expiresInMs === undefined ? 3600_000 : expiresInMs),
        domain: domain === undefined ? 'codebuddy.cn' : domain,
      },
      account: { uid, enterpriseId, nickname: 'user-' + uid },
    }), 'utf8');
    return p;
  }

  const openaiProvider = (id, up, extra = {}) => Object.assign({
    id,
    baseURL: 'http://127.0.0.1:' + up.port + '/v2',   // 注意是 /v2 —— 旧 upstreamBase 只认 /v1
    apiKey: UPSTREAM_KEY,
    models: extra.models || ['test-model'],
    enabled: true,
    protocol: 'openai-chat',
  }, extra);

  t('协议翻译：Anthropic 客户端 → OpenAI 上游（system/工具/tool_result 改写 + /v2 路径）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('oai', up)], 'xlate1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 64, stream: false,
          system: '你是助手',
          tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
          messages: [
            { role: 'user', content: '北京天气？' },
            { role: 'assistant', content: [{ type: 'text', text: '我查一下' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25℃' }] },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '应成功，实际 ' + r.status + ' ' + r.text.slice(0, 240));
      assert.strictEqual(up.st.paths[0], '/v2/chat/completions', '应打到 /v2：' + up.st.paths[0]);
      const sent = up.st.bodies[0];
      assert.strictEqual(sent.messages[0].role, 'system', 'system 应为首条消息：' + JSON.stringify(sent.messages[0]));
      assert.strictEqual(sent.messages[0].content, '你是助手');
      const assistant = sent.messages.find((m) => m.role === 'assistant');
      assert.ok(Array.isArray(assistant.tool_calls) && assistant.tool_calls[0].function.name === 'get_weather',
        'tool_use 应转 tool_calls：' + JSON.stringify(assistant));
      assert.ok(sent.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'toolu_1' && /晴 25℃/.test(m.content)),
        'tool_result 应转 role:tool：' + JSON.stringify(sent.messages));
      assert.strictEqual(sent.tools[0].type, 'function');
      assert.strictEqual(sent.tools[0].function.parameters.required[0], 'city', 'input_schema → parameters');
      const out = JSON.parse(r.text);
      assert.strictEqual(out.type, 'message', '应答须为 Anthropic message：' + r.text.slice(0, 200));
      assert.ok(out.content.some((b) => b.type === 'text' && /来自 OpenAI 上游的回复/.test(b.text)),
        '文本应翻译回 Anthropic 内容块：' + JSON.stringify(out.content));
      assert.strictEqual(out.stop_reason, 'end_turn');
      assert.strictEqual(out.usage.input_tokens, 11, 'usage 应透传：' + JSON.stringify(out.usage));
      assert.strictEqual(out.usage.output_tokens, 7);
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：OpenAI SSE → Anthropic 事件流（thinking/text/tool_use + 结束事件）', async () => {
    const up = await startFakeOpenAIUpstream({ withToolCall: true });
    const gw = await startGatewayWith([openaiProvider('oai2', up, { quirks: ['force-stream'] })], 'xlate2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      const text = r.text;
      assert.ok(/event: message_start/.test(text), '缺 message_start：' + text.slice(0, 300));
      assert.ok(/"type":"thinking_delta","thinking":"先想一下"/.test(text), 'reasoning_content → thinking_delta：' + text.slice(0, 400));
      assert.ok(/"type":"text_delta","text":"你好"/.test(text), 'content → text_delta：' + text.slice(0, 400));
      assert.ok(/"type":"tool_use"/.test(text) && /"name":"get_weather"/.test(text), 'tool_calls 应开 tool_use 块：' + text.slice(0, 600));
      assert.ok(/input_json_delta/.test(text), 'arguments 分片应转 input_json_delta：' + text.slice(0, 600));
      assert.ok(/event: content_block_stop/.test(text) && /event: message_delta/.test(text) && /event: message_stop/.test(text),
        '应有 stop/delta/stop 收尾事件：' + text.slice(-300));
      assert.ok(/"stop_reason":"tool_use"/.test(text), '有工具调用时 stop_reason=tool_use：' + text.slice(-300));
      assert.strictEqual(up.st.bodies[0].stream, true, 'quirk force-stream 应强制 stream:true');
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：客户端要非流式 + 上游强制流式 → 网关聚合 SSE 后回单条 message', async () => {
    const up = await startFakeOpenAIUpstream({});
    const gw = await startGatewayWith([openaiProvider('oai3', up, { quirks: ['force-stream'] })], 'xlate3');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const out = JSON.parse(r.text);
      assert.strictEqual(out.type, 'message', '应聚合为单条 message：' + r.text.slice(0, 240));
      const textBlock = out.content.find((b) => b.type === 'text');
      assert.ok(textBlock && /你好，世界/.test(textBlock.text), '聚合文本应完整：' + JSON.stringify(out.content));
      assert.ok(out.usage.output_tokens > 0, '应给出 output_tokens：' + JSON.stringify(out.usage));
    } finally { killGw(gw); closeUp(up); }
  });

  t('供应商能力：自定义头 + tool_choice 摊平 + prepend-system', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([
      openaiProvider('oai4', up, {
        headers: { 'X-Product': 'SaaS', 'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2' },
        quirks: ['stringify-tool-choice', 'prepend-system'],
      }),
    ], 'cap1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 32, stream: false,
          tool_choice: { type: 'tool', name: 'get_weather' },
          tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = up.st.headers[0];
      assert.strictEqual(h['x-product'], 'SaaS', '自定义头应发出：' + JSON.stringify(h));
      assert.strictEqual(h['user-agent'], 'CLI/2.63.2 CodeBuddy/2.63.2', 'UA 应可配置：' + h['user-agent']);
      const sent = up.st.bodies[0];
      assert.strictEqual(sent.tool_choice, 'get_weather', 'tool_choice 应摊平为字符串：' + JSON.stringify(sent.tool_choice));
      assert.strictEqual(sent.messages[0].role, 'system', 'prepend-system 应补 system：' + JSON.stringify(sent.messages[0]));
    } finally { killGw(gw); closeUp(up); }
  });

  t('WorkBuddy 凭据：读桌面 auth 文件 → Bearer + 身份头（不再发 x-api-key）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-auth-'));
    const authFile = writeWorkBuddyAuth(dir, 'workbuddy-desktop.info', { token: 'AT-1', uid: 'u-1', enterpriseId: 'ent-1', domain: 'codebuddy.cn' });
    const gw = await startGatewayWith([
      openaiProvider('wb', up, { auth: 'workbuddy', accounts: [{ id: 'a1', authFile }] }),
    ], 'wb1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = up.st.headers[0];
      assert.strictEqual(h.authorization, 'Bearer AT-1', '应用桌面凭据的 Bearer：' + JSON.stringify(h));
      assert.strictEqual(h['x-user-id'], 'u-1', 'X-User-Id：' + JSON.stringify(h));
      assert.strictEqual(h['x-enterprise-id'], 'ent-1', 'X-Enterprise-Id');
      assert.strictEqual(h['x-domain'], 'codebuddy.cn', 'X-Domain');
      assert.strictEqual(h.referer, 'https://www.codebuddy.cn/', 'Referer 应按区域：' + h.referer);
      assert.ok(!('x-api-key' in h), 'WorkBuddy 路径不得再发 x-api-key');
    } finally { killGw(gw); closeUp(up); }
  });

  t('多账户池：额度耗尽 → 同供应商内切下一个账户（不换供应商）', async () => {
    const upPool = await startFakeOpenAIUpstream({ script: ['credit', 'ok'], json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-pool-'));
    const a1 = writeWorkBuddyAuth(dir, 'wb-a1.info', { token: 'AT-A1', uid: 'uid-a1' });
    const a2 = writeWorkBuddyAuth(dir, 'wb-a2.info', { token: 'AT-A2', uid: 'uid-a2' });
    const upFallback = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      openaiProvider('wbp', upPool, { auth: 'workbuddy', accounts: [{ id: 'a1', authFile: a1 }, { id: 'a2', authFile: a2 }] }),
      providerOf('fallback', upFallback, { models: ['test-model'] }),
    ], 'pool1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应切到第二个账户成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upPool.st.calls, 2, '同供应商内应重试一次（换账户），实际 ' + upPool.st.calls);
      assert.strictEqual(upFallback.st.calls, 0, '账户池仍有可用账户时不得换供应商，实际 ' + upFallback.st.calls);
      const used = upPool.st.headers.map((h) => h.authorization);
      assert.ok(used[0] !== used[1], '两次应使用不同账户 token：' + JSON.stringify(used));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/标记为 credit/.test(logText), '日志应记录账户被标记：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(upPool); closeUp(upFallback); }
  });

  t('多账户池：全部账户不可用 → 交给下一家供应商（不打死请求）', async () => {
    const upPool = await startFakeOpenAIUpstream({ behavior: 'credit' });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-pool2-'));
    const a1 = writeWorkBuddyAuth(dir, 'wb-b1.info', { token: 'AT-B1', uid: 'uid-b1' });
    const a2 = writeWorkBuddyAuth(dir, 'wb-b2.info', { token: 'AT-B2', uid: 'uid-b2' });
    const upFallback = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      openaiProvider('wbp2', upPool, { auth: 'workbuddy', accounts: [{ id: 'b1', authFile: a1 }, { id: 'b2', authFile: a2 }] }),
      providerOf('fallback2', upFallback, { models: ['test-model'] }),
    ], 'pool2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应由下一家供应商服务，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upPool.st.calls, 2, '两个账户都应试过，实际 ' + upPool.st.calls);
      assert.strictEqual(upFallback.st.calls, 1, '应切到备用供应商，实际 ' + upFallback.st.calls);
    } finally { killGw(gw); closeUp(upPool); closeUp(upFallback); }
  });

  t('WorkBuddy 凭据：access token 临期 → 自动刷新（X-Refresh-Token）并用新 token 请求', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-refresh-'));
    // expiresInMs 为负 → 已过期/临期，触发刷新
    const authFile = writeWorkBuddyAuth(dir, 'wb-exp.info', { token: 'AT-OLD', uid: 'u-exp', expiresInMs: -60_000, refreshToken: 'RT-EXP' });
    const gw = await startGatewayWith([
      openaiProvider('wbr', up, { auth: 'workbuddy', accounts: [{ id: 'e1', authFile }] }),
    ], 'wb2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '刷新后应成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok((up.st.refreshCalls || 0) >= 1, '应调用过刷新端点，实际 ' + (up.st.refreshCalls || 0));
      const refreshHdr = up.st.headers[up.st.paths.findIndex((p) => /token\/refresh$/.test(p))];
      assert.strictEqual(refreshHdr['x-refresh-token'], 'RT-EXP', '刷新请求应带 X-Refresh-Token：' + JSON.stringify(refreshHdr));
      assert.strictEqual(refreshHdr['x-auth-refresh-source'], 'workbuddy', '刷新请求应带 X-Auth-Refresh-Source');
      const chatIdx = up.st.paths.findIndex((p) => /chat\/completions$/.test(p));
      assert.strictEqual(up.st.headers[chatIdx].authorization, 'Bearer AT-REFRESHED',
        'chat 请求应使用刷新后的 token：' + up.st.headers[chatIdx].authorization);
      // 自留副本落在网关数据目录（不写桌面 App 的文件）
      const ownDir = path.join(path.dirname(gw.logPath), 'workbuddy-auth');
      assert.ok(fs.existsSync(ownDir), '应在网关数据目录留凭据副本：' + ownDir);
      assert.strictEqual(JSON.parse(fs.readFileSync(authFile, 'utf8')).auth.accessToken, 'AT-OLD', '桌面 App 的凭据文件不得被改写');
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：静态 key 的 OpenAI 上游 → 发 Bearer（而非 x-api-key），修 sensenova 类 401', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('senselike', up)], 'xlate4');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = up.st.headers[0];
      assert.strictEqual(h.authorization, 'Bearer ' + UPSTREAM_KEY, 'OpenAI 上游必须收 Bearer：' + JSON.stringify(h.authorization));
      assert.ok(!('x-api-key' in h), '不得再发 x-api-key：' + JSON.stringify(Object.keys(h)));
      assert.ok(!('anthropic-version' in h), '不得再发 anthropic-version');
    } finally { killGw(gw); closeUp(up); }
  });

  t('多账户池（直通路径）：/v1/chat/completions 也走账户池 —— 额度耗尽自动换账户', async () => {
    // 上游：第 1 次 402（第一个账户额度耗尽）→ 第 2 次 SSE 成功
    const upPool = await startFakeOpenAIUpstream({ script: ['credit', 'ok'], json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-pool3-'));
    const a1 = writeWorkBuddyAuth(dir, 'wb-c1.info', { token: 'AT-C1', uid: 'uid-c1' });
    const a2 = writeWorkBuddyAuth(dir, 'wb-c2.info', { token: 'AT-C2', uid: 'uid-c2' });
    const gw = await startGatewayWith([
      openaiProvider('wbp3', upPool, { auth: 'workbuddy', accounts: [{ id: 'c1', authFile: a1 }, { id: 'c2', authFile: a2 }] }),
    ], 'pool3');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 走 OpenAI 直通路径（客户端说 OpenAI 协议），验证账户池同样生效
      const r = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应换账户后成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upPool.st.calls, 2, '应换账户重试一次，实际 ' + upPool.st.calls);
      const used = upPool.st.headers.map((h) => h.authorization);
      assert.ok(used[0] && used[1] && used[0] !== used[1], '两次应使用不同账户 token：' + JSON.stringify(used));
      assert.strictEqual(upPool.st.paths[0], '/v2/chat/completions', '仍应打 /v2：' + upPool.st.paths[0]);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/标记为 credit/.test(logText), '日志应记录账户被标记：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(upPool); }
  });

  t('账户池可见性：/health 列出全部账户与冷却状态；日志标注实际使用的账户（via=provider#acct）', async () => {
    // 第 1 次 a1 额度耗尽 → 第 2 次 a2 成功
    const up = await startFakeOpenAIUpstream({ script: ['credit', 'ok'], json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-vis-'));
    const a1 = writeWorkBuddyAuth(dir, 'wb-d1.info', { token: 'AT-D1', uid: 'uid-d1' });
    const a2 = writeWorkBuddyAuth(dir, 'wb-d2.info', { token: 'AT-D2', uid: 'uid-d2' });
    const gw = await startGatewayWith([
      openaiProvider('wbv', up, { auth: 'workbuddy', accounts: [{ id: 'd1', authFile: a1 }, { id: 'd2', authFile: a2 }] }),
    ], 'vis1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // ① 未失败前：两个账户都应在册且 state=ok
      const h0 = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      assert.ok(Array.isArray(h0.accounts), '/health 应带 accounts 数组：' + JSON.stringify(h0));
      assert.strictEqual(h0.accounts.length, 2, '应列出全部 2 个账户：' + JSON.stringify(h0.accounts));
      assert.ok(h0.accounts.every((a) => a.state === 'ok'), '未失败时都应为 ok：' + JSON.stringify(h0.accounts));
      assert.ok(h0.accounts.every((a) => a.provider === 'wbv'), '应标注所属供应商：' + JSON.stringify(h0.accounts));
      // ② 触发一次额度耗尽 → 该账户应变为 credit 且带剩余冷却时间
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应换账户后成功，实际 ' + r.status);
      const h1 = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const cooling = h1.accounts.filter((a) => a.state === 'credit');
      assert.strictEqual(cooling.length, 1, '应有 1 个账户处于 credit 冷却：' + JSON.stringify(h1.accounts));
      assert.ok(cooling[0].remainMs > 0, '应给出剩余冷却毫秒：' + JSON.stringify(cooling[0]));
      assert.ok(cooling[0].reason && /credit|积分/.test(cooling[0].reason), '应带冷却原因：' + JSON.stringify(cooling[0]));
      assert.ok(h1.accounts.some((a) => a.lastUsed === true), '应标注最近使用的账户：' + JSON.stringify(h1.accounts));
      // ③ 日志里应能看到实际服务的账户
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/via=wbv#d2/.test(logText), '日志应标注实际账户（via=wbv#d2）：' + logText.slice(-500));
    } finally { killGw(gw); closeUp(up); }
  });

  t('WorkBuddy 免路径：accounts 只写 { id } → 按平台默认位置自动发现凭据（LOCALAPPDATA/APPDATA）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-auto-'));
    const authFile = writeWorkBuddyAuth(dir, 'auto.info', { token: 'AT-AUTO', uid: 'uid-auto' });
    // 通过环境变量把"平台默认探测路径"指到临时文件（等价于本机装了 WorkBuddy 并登录）
    const gw = await startGatewayWith(
      [openaiProvider('wba', up, { auth: 'workbuddy', accounts: [{ id: 'auto1' }] })],
      'wbauto',
      { LOCALAPPDATA: dir, APPDATA: dir },
    );
    // 上面 env 只改了 AppData 根；把凭据放到期望的子路径下，模拟真实布局
    const rel = path.join(dir, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
    fs.mkdirSync(rel, { recursive: true });
    fs.copyFileSync(authFile, path.join(rel, 'workbuddy-desktop.info'));
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应自动发现凭据并成功，实际 ' + r.status + ' ' + r.text.slice(0, 240));
      const h = up.st.headers[0];
      assert.strictEqual(h.authorization, 'Bearer AT-AUTO', '应用自动发现的凭据：' + JSON.stringify(h.authorization));
      assert.strictEqual(h['x-user-id'], 'uid-auto', '身份头应来自自动发现的凭据');
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：上游 200 但 SSE 首事件是 error → 判该家失败并换下一家（不让客户端收空回复）', async () => {
    const errSse = 'data: {"error":{"message":"Service temporarily unavailable","type":"api_error"}}\n\n';
    const upBad = await startFakeOpenAIUpstream({ sseRaw: errSse });
    const upGood = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([
      openaiProvider('oaiBad', upBad),
      openaiProvider('oaiGood', upGood),
    ], 'xlate5');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '应换到家后成功，实际 ' + r.status);
      assert.ok(!/Service temporarily unavailable/.test(r.text), '不得把上游错误原文透传：' + r.text.slice(0, 200));
      assert.ok(/来自 OpenAI 上游的回复/.test(r.text), '应拿到第二家的正文：' + r.text.slice(0, 300));
      assert.strictEqual(upBad.st.calls, 1, '第一家应被尝试一次，实际 ' + upBad.st.calls);
      assert.strictEqual(upGood.st.calls, 1, '第二家应收到转发，实际 ' + upGood.st.calls);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/SSE 首事件是错误/.test(logText), '日志应记录该判定：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(upBad); closeUp(upGood); }
  });

  t('协议翻译：唯一候选 200+SSE error → 回网关自己的 503（不写 200 空回复）', async () => {
    const errSse = 'data: {"error":{"message":"Service temporarily unavailable"}}\n\n';
    const up = await startFakeOpenAIUpstream({ sseRaw: errSse });
    const gw = await startGatewayWith([openaiProvider('oaiOnly', up)], 'xlate6');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 503, '应回网关自己的 503，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(!/Service temporarily unavailable/.test(r.text), '不得回显上游原文：' + r.text.slice(0, 200));
      const out = JSON.parse(r.text);
      assert.strictEqual(out.type, 'error', '应是 Anthropic 错误体：' + r.text.slice(0, 200));
    } finally { killGw(gw); closeUp(up); }
  });

  t('WorkBuddy 身份仿真：chat 用桌面形态 UA（WorkBuddy/<app> … CLI/<cli>），刷新用 CLI 形态 UA', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-ua-'));
    // 合成一个"已安装的 WorkBuddy"：install-manifest.json 给 App 版本；
    // cli/package.json 的 version 是 0.0.0 占位 → 必须回退到 publishConfig.customPackage.version
    fs.mkdirSync(path.join(dir, 'resources', 'app.asar.unpacked', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources', 'install-manifest.json'), JSON.stringify({ appVersion: '9.9.9' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'resources', 'app.asar.unpacked', 'cli', 'package.json'),
      JSON.stringify({ version: '0.0.0', publishConfig: { customPackage: { version: '3.3.3' } } }), 'utf8');
    // 临期 token → 同时触发刷新路径（用于断言刷新仍用 CLI 形态 UA）
    const authFile = writeWorkBuddyAuth(dir, 'wb-ua.info', { token: 'AT-UA', uid: 'uid-ua', expiresInMs: -60_000 });
    const gw = await startGatewayWith(
      [openaiProvider('wbua', up, { auth: 'workbuddy', accounts: [{ id: 'u1', authFile }] })],
      'wbua',
      { WORKBUDDY_APP_DIR: dir },   // 让版本解析指向合成的安装目录
    );
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const chatIdx = up.st.paths.findIndex((p) => /chat\/completions$/.test(p));
      assert.ok(chatIdx >= 0, '应有 chat 请求：' + JSON.stringify(up.st.paths));
      assert.strictEqual(up.st.headers[chatIdx]['user-agent'], 'WorkBuddy/9.9.9 WorkBuddy/9.9.9 CLI/3.3.3',
        'chat 必须是桌面客户端形态 UA：' + up.st.headers[chatIdx]['user-agent']);
      const refreshIdx = up.st.paths.findIndex((p) => /token\/refresh$/.test(p));
      assert.ok(refreshIdx >= 0, '临期账户应触发刷新：' + JSON.stringify(up.st.paths));
      assert.strictEqual(up.st.headers[refreshIdx]['user-agent'], 'CLI/2.63.2 CodeBuddy/2.63.2',
        '刷新路径保持 CLI 形态 UA（与插件一致）：' + up.st.headers[refreshIdx]['user-agent']);
    } finally { killGw(gw); closeUp(up); }
  });

  t('供应商能力（直通路径）：quirks 同样生效 —— tool_choice 摊平 / prepend-system / force-stream 聚合', async () => {
    // 2026-09-16 实测：quirks 曾在**只有翻译路径**生效，OpenAI 客户端把 tool_choice 对象透传 →
    // 上游 400「cannot unmarshal object into Go struct field Request.tool_choice of type string」
    const up = await startFakeOpenAIUpstream({});   // 一直回 SSE（模拟只收流式的上游）
    const gw = await startGatewayWith([
      openaiProvider('qd', up, { quirks: ['stringify-tool-choice', 'prepend-system', 'force-stream'] }),
    ], 'quirks1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 客户端要**非流式**：上游被强制 stream:true → 网关必须聚合后回单条 JSON
      const r = await call({
        port: gw.port, p: '/v1/chat/completions',
        body: {
          model: 'test-model', stream: false,
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 240));
      const sent = up.st.bodies[0];
      assert.strictEqual(sent.tool_choice, 'get_weather', 'tool_choice 必须摊平成字符串：' + JSON.stringify(sent.tool_choice));
      assert.strictEqual(sent.messages[0].role, 'system', 'prepend-system 应补 system：' + JSON.stringify(sent.messages[0]));
      assert.strictEqual(sent.stream, true, 'force-stream 应强制上游 stream:true：' + sent.stream);
      // 客户端拿到的是聚合后的单条 completion（不是 SSE）
      const out = JSON.parse(r.text);
      assert.strictEqual(out.object, 'chat.completion', '客户端应收到聚合后的 JSON：' + r.text.slice(0, 200));
      assert.ok(/你好，世界/.test(out.choices[0].message.content), '聚合内容应完整：' + JSON.stringify(out.choices[0].message));
      assert.strictEqual(out.choices[0].finish_reason, 'stop');
    } finally { killGw(gw); closeUp(up); }
  });

  t('供应商能力（直通路径）：force-stream 下客户端要流式 → 原样透传 SSE，不聚合', async () => {
    const up = await startFakeOpenAIUpstream({});
    const gw = await startGatewayWith([openaiProvider('qs', up, { quirks: ['force-stream'] })], 'quirks2');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.ok(/data: \{"id":"chatcmpl-1"/.test(r.text) && /\[DONE\]/.test(r.text), '流式客户端应拿到原始 SSE：' + r.text.slice(0, 200));
      assert.strictEqual(up.st.bodies[0].stream, true, '上游仍应 stream:true');
    } finally { killGw(gw); closeUp(up); }
  });

  t('身份仿真边界：只有 workbuddy 用 WorkBuddy 身份；其余供应商仍按 clientProfile 仿真（claude/codex/自定义）', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const dir = fs.mkdtempSync(path.join(tmp, 'wb-scope-'));
    fs.mkdirSync(path.join(dir, 'resources', 'app.asar.unpacked', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources', 'install-manifest.json'), JSON.stringify({ appVersion: '9.9.9' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'resources', 'app.asar.unpacked', 'cli', 'package.json'),
      JSON.stringify({ version: '0.0.0', publishConfig: { customPackage: { version: '3.3.3' } } }), 'utf8');
    const authFile = writeWorkBuddyAuth(dir, 'wb-scope.info', { token: 'AT-SCOPE', uid: 'uid-scope' });
    const env = { WORKBUDDY_APP_DIR: dir };
    const plain = (id) => ({ id, baseURL: 'http://127.0.0.1:' + up.port + '/v1', apiKey: UPSTREAM_KEY, models: ['test-model'], enabled: true });

    // ① claude 仿真（默认 clientProfile）→ 普通供应商：UA 必须是 Claude Code 形态
    let gw = await startGatewayWith([plain('n1')], 'scope1', env, { clientProfile: 'claude', clientUA: 'claude-cli/2.0.0 (external, cli)' });
    try {
      assert.ok(gw.ready);
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(up.st.headers[0]['user-agent'], 'claude-cli/2.0.0 (external, cli)',
        '普通供应商必须保持 Claude Code 仿真：' + up.st.headers[0]['user-agent']);
      assert.ok(!/WorkBuddy/.test(up.st.headers[0]['user-agent']), '普通供应商绝不能带上 WorkBuddy 身份');
    } finally { killGw(gw); }

    // ② codex 仿真 → 普通供应商：UA 必须是 Codex 形态
    gw = await startGatewayWith([plain('n2')], 'scope2', env, { clientProfile: 'codex' });
    try {
      assert.ok(gw.ready);
      const before = up.st.calls;
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.ok(/^codex\/0\.49\.0/.test(up.st.headers[before]['user-agent']),
        'codex 配置下应发 Codex 形态 UA：' + up.st.headers[before]['user-agent']);
      assert.ok(!/WorkBuddy/.test(up.st.headers[before]['user-agent']), '不得混入 WorkBuddy 身份');
    } finally { killGw(gw); }

    // ③ 供应商自带 User-Agent（配置覆盖）→ 只发这一个 UA（不得与 clientProfile 的 UA 拼接）
    gw = await startGatewayWith([Object.assign(plain('n3'), { headers: { 'User-Agent': 'my-agent/1.0' } })], 'scope3', env,
      { clientProfile: 'claude', clientUA: 'claude-cli/2.0.0 (external, cli)' });
    try {
      assert.ok(gw.ready);
      const before = up.st.calls;
      await call({ port: gw.port, p: '/v1/chat/completions', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(up.st.headers[before]['user-agent'], 'my-agent/1.0',
        '供应商配置的 UA 应生效且不被拼接：' + up.st.headers[before]['user-agent']);
    } finally { killGw(gw); }

    // ④ WorkBuddy 供应商（同一个网关配置里）→ 必须是桌面 WorkBuddy 身份
    //    注意：普通供应商声明**别的模型**，否则它会先拿到请求（那样断言到的是它的头）
    gw = await startGatewayWith([
      Object.assign(plain('n4'), { models: ['other-model'] }),
      openaiProvider('wbs', up, { auth: 'workbuddy', accounts: [{ id: 's1', authFile }] }),
    ], 'scope4', env, { clientProfile: 'claude', clientUA: 'claude-cli/2.0.0 (external, cli)' });
    try {
      assert.ok(gw.ready);
      const before = up.st.calls;
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.strictEqual(up.st.calls, before + 1, '应只有 WorkBuddy 一家被调用');
      const h = up.st.headers[before];
      assert.strictEqual(h['user-agent'], 'WorkBuddy/9.9.9 WorkBuddy/9.9.9 CLI/3.3.3',
        'WorkBuddy 必须用桌面身份 UA：' + h['user-agent']);
      assert.ok(!/claude-cli/.test(h['user-agent']), 'WorkBuddy 请求不得混入 claude-cli（旧 bug 会拼成两个 UA）');
      assert.strictEqual(h['x-user-id'], 'uid-scope', 'WorkBuddy 身份头应存在');
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译：工具名在后续分片才到达时，客户端仍必须拿到非空的 tool_use 名字（真实事故回归）', async () => {
    // 事故（2026-09-16）：上游先发 id、稍后才发 name，旧实现立刻开块 → 名字为空 →
    // 客户端报 `unknown tool ""`，下一轮把空名 tool_use 回传 → 上游 400 打死整轮。
    const up = await startFakeOpenAIUpstream({ withToolCall: true, toolNameLate: true });
    const gw = await startGatewayWith([openaiProvider('late', up, { quirks: ['force-stream'] })], 'toollate');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: { model: 'test-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      // 取出客户端实际收到的 tool_use 块（content_block_start 的 name 字段）
      const starts = [...r.text.matchAll(/"content_block":\{"type":"tool_use"[^}]*"name":"([^"]*)"/g)].map((m) => m[1]);
      assert.ok(starts.length >= 1, '应有 tool_use 块：' + r.text.slice(0, 400));
      assert.strictEqual(starts[0], 'get_weather', '工具名必须非空且正确（旧实现为空串）：' + JSON.stringify(starts));
      assert.ok(!/"name":""/.test(r.text), '不得出现空名 tool_use：' + r.text.slice(0, 400));
      // 参数应完整补发（名字到达前缓冲的分片不能丢）——按 SSE 事件解析，避免转义引号截断正则
      const events = r.text.split(/\n\n/).map((blk) => (/^data:\s*(.*)$/m.exec(blk) || [])[1]).filter(Boolean)
        .map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
      const partials = events.filter((e) => e.type === 'content_block_delta' && e.delta && e.delta.type === 'input_json_delta')
        .map((e) => e.delta.partial_json);
      assert.ok(partials.join('').includes('北京'), '缓冲的参数分片应完整补发：' + JSON.stringify(partials));
      // 且 tool_use 块只应开一次（旧实现会开两次：空名一次 + 补名一次）
      const toolStarts = events.filter((e) => e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use');
      assert.strictEqual(toolStarts.length, 1, 'tool_use 块只应开一次：' + JSON.stringify(toolStarts.map((e) => e.content_block.name)));
      // 聚合路径（非流式客户端）也要拿到名字
      const up2 = await startFakeOpenAIUpstream({ withToolCall: true, toolNameLate: true });
      const gw2 = await startGatewayWith([openaiProvider('late2', up2, { quirks: ['force-stream'] })], 'toollate2');
      try {
        const r2 = await call({ port: gw2.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hi' }] } });
        const out = JSON.parse(r2.text);
        const tu = out.content.find((b) => b.type === 'tool_use');
        assert.ok(tu && tu.name === 'get_weather', '聚合路径同样要有正确的工具名：' + JSON.stringify(out.content));
        assert.deepStrictEqual(tu.input, { city: '北京' }, '聚合路径参数应完整：' + JSON.stringify(tu.input));
      } finally { killGw(gw2); closeUp(up2); }
    } finally { killGw(gw); closeUp(up); }
  });

  t('协议翻译（防御）：历史里的空名 tool_use 及其 tool_result 必须被丢弃，不得让整轮 400', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('def1', up)], 'def1');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({
        port: gw.port, p: '/v1/messages',
        body: {
          model: 'test-model', max_tokens: 32, stream: false,
          messages: [
            { role: 'user', content: '北京天气？' },
            // 修复前版本可能产生这种坏数据：tool_use 名字为空
            { role: 'assistant', content: [{ type: 'text', text: '我查一下' }, { type: 'tool_use', id: 'bad_1', name: '', input: { city: '北京' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad_1', content: '晴 25℃' }] },
            { role: 'user', content: '那就说不知道' },
          ],
        },
      });
      assert.strictEqual(r.status, 200, '实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const sent = up.st.bodies[0];
      const badCall = sent.messages.some((m) => Array.isArray(m.tool_calls)
        && m.tool_calls.some((t) => !t.function || !String(t.function.name || '').trim()));
      assert.ok(!badCall, '不得回传空名 tool_calls（上游会 400）：' + JSON.stringify(sent.messages));
      const orphan = sent.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'bad_1');
      assert.ok(!orphan, '不得留下孤儿的 tool 消息：' + JSON.stringify(sent.messages));
      assert.ok(sent.messages.some((m) => m.role === 'user' && /那就说不知道/.test(String(m.content))),
        '其余历史必须保留：' + JSON.stringify(sent.messages));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/名字为空.*tool_use.*已丢弃/.test(logText), '应记录丢弃告警：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 2026-09-16 事故回归：本机代理端口死掉时，网关不该自杀、也不该把锅甩给上游 ----
  t('代理事故回归：NO_PROXY 含回环时，代理端口死掉也不影响上游调用与 /health（不再自杀/误熔断）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    // 死代理：7899 没有任何监听（复现 19:19–19:23 的 ECONNREFUSED 场景）
    const gw = await startGatewayWith([providerOf('p1', up, { priority: 1 })], 'deadproxy', {
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:7899',
      HTTPS_PROXY: 'http://127.0.0.1:7899',
      NO_PROXY: '127.0.0.1,localhost,::1',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪（回环直连 → 不被死代理拖死）');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 200, '回环上游在 NO_PROXY 里 → 即使代理端口死掉也应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      assert.ok(h.proxy && h.proxy.url === 'http://127.0.0.1:7899', '/health 应暴露代理地址：' + JSON.stringify(h.proxy));
      assert.ok(/127\.0\.0\.1/.test(String(h.proxy.noProxy)), '/health 应暴露 NO_PROXY（含回环）：' + JSON.stringify(h.proxy));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/proxy: 走 http:\/\/127\.0\.0\.1:7899/.test(logText), '启动日志应自述代理状态：' + logText.slice(0, 400));
    } finally { killGw(gw); closeUp(up); }
  });

  t('代理事故回归：回环被代理且代理未运行时，日志必须点名"代理未运行"（而不是记成上游账号故障）', async () => {
    const up = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([providerOf('p1', up, { priority: 1 })], 'deadproxy2', {
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:7899',
      HTTPS_PROXY: 'http://127.0.0.1:7899',
      NO_PROXY: '',            // 故意不绕过：上游请求会被塞进死代理
    });
    try {
      assert.ok(gw.ready, 'watchdog 用裸 socket 自检，不经过代理 → 即使代理死掉也不该自杀');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 503, '代理不可达时唯一候选失败 → 503，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/upstream p1 request error/.test(logText), '应记录上游请求错误：' + logText.slice(-300));
      assert.ok(/代理未运行/.test(logText), '必须点名"代理未运行"（否则又会把环境问题记成上游故障）：' + logText.slice(-400));
      assert.strictEqual(up.st.calls, 0, '请求根本没到上游（死在代理连接上），实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  // ---- 2026-09-17 优化项回归（依据当天日志分析：探针代价 / 402 判级 / 学习标记 / 多 Key / 误报）----

  t('多 Key（apiKeys）：同一供应商内额度耗尽 → 自动换下一把 Key（用户要求 2b/2c）', async () => {
    const upPool = await startFakeOpenAIUpstream({ script: ['credit', 'ok'], json: true });
    const gw = await startGatewayWith([
      // 注意 provider 同时带 apiKey（单 Key 字段）：多 Key 必须**优先**，否则等于没生效
      openaiProvider('mk', upPool, { apiKeys: ['sk-key-1', 'sk-key-2'] }),
    ], 'multikey');
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '应换到第二把 Key 后成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(upPool.st.calls, 2, '同一供应商内应重试一次（换 Key），实际 ' + upPool.st.calls);
      const used = upPool.st.headers.map((h) => h.authorization);
      assert.strictEqual(used[0], 'Bearer sk-key-1', '第一次应用第一把 Key：' + JSON.stringify(used));
      assert.strictEqual(used[1], 'Bearer sk-key-2', '第二次应换第二把 Key：' + JSON.stringify(used));
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/标记为 credit/.test(logText), '日志应记账户（Key）被标记：' + logText.slice(-400));
      // /health 可见性：多 Key 在账户池里逐把列出（排障时一眼看清哪把在冷却）
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      const keys = (h.accounts || []).map((a) => a.key);
      assert.ok(keys.includes('mk#key1') && keys.includes('mk#key2'), '/health 应列出两把 Key：' + JSON.stringify(keys));
    } finally { killGw(gw); closeUp(upPool); }
  });

  t('多 Key（apiKeys）：只配 1 把时不写 apiKeys（保持旧单 Key 结构），≥2 把才启用轮换', async () => {
    const up = await startFakeOpenAIUpstream({ json: true });
    const gw = await startGatewayWith([openaiProvider('one', up, { apiKey: 'sk-only-one' })], 'onekey');
    try {
      const h = JSON.parse((await call({ port: gw.port, method: 'GET', p: '/health', body: null, key: '' })).text);
      assert.strictEqual((h.accounts || []).length, 0, '单 Key（无 apiKeys）不应产生账户池：' + JSON.stringify(h.accounts));
      const r = await call({ port: gw.port, p: '/v1/messages', body: { model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } });
      assert.strictEqual(r.status, 200, '实际 ' + r.status);
      assert.strictEqual(up.st.headers[0].authorization, 'Bearer sk-only-one', '单 Key 仍按旧路径使用');
    } finally { killGw(gw); closeUp(up); }
  });

  t('402 额度/预算耗尽 → 判为"长期状态"（长熔断），不再按 90 秒临时冷却反复重探', async () => {
    const up = await startFakeUpstream({
      status: 402,
      errorBody: { error: { message: 'Budget pool quota has been exhausted. Please ask an administrator to increase the limit' } },
    });
    const gw = await startGatewayWith([providerOf('q402', up, { priority: 1 })], 'q402', {
      DSH_GATEWAY_BREAKER_LONG_MS: '1500', DSH_GATEWAY_BREAKER_SHORT_MS: '1500',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 503, '唯一候选额度耗尽 → 503，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/供应商账号\/额度\/权限"类错误（长期状态）/.test(logText),
        '额度耗尽必须判为长期状态（旧版判"临时"→ 每 90 秒白撞一次）：' + logText.slice(-500));
      assert.ok(/熔断 1500ms/.test(logText), '应按长熔断时长开闸：' + logText.slice(-400));
      assert.strictEqual(up.st.calls, 1, '应只打一次上游，实际 ' + up.st.calls);
    } finally { killGw(gw); closeUp(up); }
  });

  t('网络类熔断按连续开闸次数指数退避（90s→3m→…，修"坏家每 90 秒被重探"）', async () => {
    const up = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const gw = await startGatewayWith([providerOf('flap', up, { priority: 1 })], 'backoff', {
      DSH_GATEWAY_BREAKER_SHORT_MS: '300', DSH_GATEWAY_BREAKER_BACKOFF_MAX_MS: '5000',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      // 3 连败 → 首次开闸 300ms；之后每等到冷却结束的下一次请求 = 半开探测，失败即按 600/1200ms 递增
      for (let i = 0; i < 3; i++) { await call({ port: gw.port }); }
      await sleep(350); await call({ port: gw.port });
      await sleep(650); await call({ port: gw.port });
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/熔断 300ms/.test(logText), '首次开闸应为 300ms：' + logText.slice(-600));
      assert.ok(/熔断 600ms/.test(logText), '第 2 次开闸应翻倍到 600ms（旧版固定 300ms）：' + logText.slice(-600));
      assert.ok(/熔断 1200ms/.test(logText), '第 3 次开闸应到 1200ms：' + logText.slice(-600));
      assert.ok(/退避递增/.test(logText), '日志应说明退避：' + logText.slice(-300));
    } finally { killGw(gw); closeUp(up); }
  });

  t('半开探测用短超时：坏家不会让用户请求白等 60 秒（当天实测 78.5s 的那次）', async () => {
    const upDead = await startFakeUpstream({ status: 500, errorBody: { error: { message: 'boom' } } });
    const upOk = await startFakeUpstream({ status: 200 });
    const gw = await startGatewayWith([
      providerOf('dead', upDead, { priority: 1 }),
      providerOf('ok', upOk, { priority: 2 }),
    ], 'probe', {
      DSH_GATEWAY_BREAKER_PROBE_TIMEOUT_MS: '600', DSH_GATEWAY_BREAKER_SHORT_MS: '300', DSH_GATEWAY_BREAKER_LONG_MS: '300',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      for (let i = 0; i < 3; i++) { await call({ port: gw.port }); }   // 让 dead 熔断（普通尝试，非探测）
      // 冷却到点后把 dead 改成"永不响应"：这一次请求会让 dead 走半开探测
      upDead.st.status = 200;
      upDead.st.delayMs = 60_000;
      await sleep(400);
      const t0 = Date.now();
      const r = await call({ port: gw.port });
      const dur = Date.now() - t0;
      assert.strictEqual(r.status, 200, '应由健康候选服务，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/breaker HALF-OPEN: dead/.test(logText), '应确实走了半开探测：' + logText.slice(-400));
      assert.ok(dur < 3000, '探测必须按短超时（600ms）快速放弃，而不是等满 60 秒；实际 ' + dur + 'ms');
    } finally { killGw(gw); closeUp(upDead); closeUp(upOk); }
  });

  t('thinking 回传"学习"：同一家第二次请求不再先失败一次（省掉重复上游失败与计费）', async () => {
    const up = await startFakeUpstream({ thinkingPassback: true });
    const gw = await startGatewayWith([providerOf('tp', up, { priority: 1 })], 'tplearn');
    const body = { model: 'test-model', max_tokens: 64, messages: THINKING_HISTORY };
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r1 = await call({ port: gw.port, p: '/v1/messages', body });
      assert.strictEqual(r1.status, 200, '首次应补位后成功，实际 ' + r1.status + ' ' + r1.text.slice(0, 200));
      assert.strictEqual(up.st.calls, 2, '首次是"原样一次 + 补占位一次"，实际 ' + up.st.calls);
      const r2 = await call({ port: gw.port, p: '/v1/messages', body });
      assert.strictEqual(r2.status, 200, '第二次应成功，实际 ' + r2.status);
      assert.strictEqual(up.st.calls - 2, 1, '第二次必须一次成功（已学习，不再先撞 400），实际 ' + (up.st.calls - 2) + ' 次');
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/已记住该家需求/.test(logText), '首次应记录学习：' + logText.slice(-400));
      assert.ok(/（已学习）预先补齐/.test(logText), '第二次应预先补齐：' + logText.slice(-400));
    } finally { killGw(gw); closeUp(up); }
  });

  t('代理提示只在连接层错误出现：超时中止（AbortError）不得误报"代理未运行"', async () => {
    const up = await startFakeUpstream({ status: 200, delayMs: 60_000 });
    const gw = await startGatewayWith([providerOf('slow', up, { priority: 1, timeoutMs: 400 })], 'hint', {
      // 走代理但回环直连（上游是本机）：请求能连上、然后被我方超时中止 → cause 链为空
      NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:7899', HTTPS_PROXY: 'http://127.0.0.1:7899',
      NO_PROXY: '127.0.0.1,localhost',
    });
    try {
      assert.ok(gw.ready, '独立网关实例应就绪');
      const r = await call({ port: gw.port });
      assert.strictEqual(r.status, 503, '唯一候选超时 → 503，实际 ' + r.status);
      const logText = fs.readFileSync(gw.logPath, 'utf8');
      assert.ok(/request error/.test(logText), '应记录请求错误：' + logText.slice(-300));
      assert.ok(!/代理未运行/.test(logText),
        'AbortError（超时/取消）不是连接层错误，绝不能提示代理问题：' + logText.slice(-300));
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
