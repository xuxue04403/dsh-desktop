#!/usr/bin/env node
/**
 * scripts/mock-workbuddy.mjs — WorkBuddy（腾讯 CodeBuddy）客户端接口的**本地模拟器**。
 *
 * 用途：在没安装/没登录 WorkBuddy 桌面 App 的机器上，端到端验证网关的 WorkBuddy 接入链路
 *（Anthropic↔OpenAI 翻译、强制流式、tool_choice 摊平、OAuth 凭据刷新、多账户池切换）。
 * 协议细节取自 dsh-workbuddy-connect 的实现（README 所述上游行为的忠实复刻，非官方 API）。
 *
 * 用法：
 *   node scripts/mock-workbuddy.mjs --port 3199 [--log <jsonl 路径>] [--json]
 * 行为约定（便于构造测试场景）：
 *   · Authorization token 含 "EXHAUSTED" → 402 额度耗尽（触发账户池切换）
 *   · Authorization token 含 "DEAD"      → 401 + 12153 会话失效（触发换账户/重新登录提示）
 *   · body.stream !== true               → 400（真实上游拒绝非流式）
 *   · 首条消息不是 system 且带 --require-system → 400/11128
 *   · tool_choice 是对象                 → 400（真实上游只接受字符串）
 *   · 带 tools 时返回 tool_calls 分片    → 验证工具调用翻译
 */
import http from 'node:http';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const PORT = Number(arg('--port', '3199'));
const LOG = arg('--log', '');
const JSON_MODE = argv.includes('--json');
const REQUIRE_SYSTEM = argv.includes('--require-system');

const CN_DOMAIN = 'codebuddy.cn';

function logLine(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  console.log(line);
  if (LOG) { try { fs.appendFileSync(LOG, line + '\n'); } catch { /* 忽略 */ } }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw || '{}'); } catch { /* 非 JSON */ }
    const auth = String(req.headers.authorization || '');
    const token = auth.replace(/^Bearer\s+/i, '');
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // —— OAuth 刷新端点 ——
    if (/\/plugin\/auth\/token\/refresh$/.test(req.url)) {
      logLine({ kind: 'refresh', refreshToken: req.headers['x-refresh-token'] || null, source: req.headers['x-auth-refresh-source'] || null, ua: req.headers['user-agent'] || null });
      if (!req.headers['x-refresh-token']) return json(400, { code: 1, msg: 'missing X-Refresh-Token' });
      return json(200, { code: 0, msg: 'ok', data: { accessToken: 'AT-REFRESHED', refreshToken: 'RT-NEW', expiresIn: 3600, domain: CN_DOMAIN } });
    }

    // —— 模型目录（网关不会调用：模型已显式声明；列出以备手工验证）——
    if (/\/console\/enterprises\/personal\/models$/.test(req.url)) {
      return json(200, { code: 0, msg: 'ok', data: {
        agents: [{ name: 'cli', models: ['glm-5.3', 'deepseek-v4-flash'] }],
        models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 200000, maxOutputTokens: 8192, credits: 'x0.00', supportsImages: true },
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', maxInputTokens: 128000, maxOutputTokens: 8192, credits: 'x0.79' }],
      } });
    }

    if (!/\/chat\/completions$/.test(req.url)) return json(404, { code: 1, msg: 'Invalid URL (' + req.url + ')' });

    const first = body && Array.isArray(body.messages) ? body.messages[0] : null;
    logLine({
      kind: 'chat', url: req.url, token, uid: req.headers['x-user-id'] || null,
      noUid: req.headers['x-no-user-id'] || null, enterprise: req.headers['x-enterprise-id'] || null,
      domain: req.headers['x-domain'] || null, product: req.headers['x-product'] || null,
      ua: req.headers['user-agent'] || null, origin: req.headers.origin || null,
      model: body && body.model, stream: body && body.stream,
      firstRole: first && first.role, toolChoice: body && (typeof body.tool_choice === 'object' ? 'object' : body.tool_choice),
      hasTools: !!(body && Array.isArray(body.tools) && body.tools.length),
      msgCount: body && Array.isArray(body.messages) ? body.messages.length : 0,
    });

    if (token.includes('EXHAUSTED')) return json(402, { code: 0, msg: 'insufficient credit: 积分不足' });
    if (token.includes('DEAD')) return json(401, { code: 0, msg: 'Offline user session not found 12153' });
    if (body && body.stream !== true) return json(400, { code: 11133, msg: 'stream must be true' });
    if (REQUIRE_SYSTEM && first && first.role !== 'system') return json(400, { code: 11128, msg: 'first message is not system prompt' });
    if (body && body.tool_choice && typeof body.tool_choice === 'object') return json(400, { code: 11130, msg: 'tool_choice must be a string' });

    const model = (body && body.model) || 'glm-5.3';
    const wantsTool = !!(body && Array.isArray(body.tools) && body.tools.length)
      && (body.tool_choice === 'required' || (typeof body.tool_choice === 'string' && body.tool_choice !== 'auto' && body.tool_choice !== 'none'));

    if (JSON_MODE) {
      return json(200, {
        id: 'chatcmpl-mock', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: '来自模拟 WorkBuddy 的回复（' + model + '）' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 21, completion_tokens: 9 },
      });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { reasoning_content: '（模拟思考）先看用户要什么' } }] });
    chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: '来自模拟 WorkBuddy 的回复' } }] });
    chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: '（' + model + '）' } }] });
    if (wantsTool) {
      chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock1', function: { name: 'get_weather', arguments: '{"city":' } }] } }] });
      chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] } }] });
      chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-workbuddy] listening on http://127.0.0.1:${PORT}`);
  console.log('[mock-workbuddy] 端点: POST /v2/chat/completions · POST /v2/plugin/auth/token/refresh · GET /console/enterprises/personal/models');
  console.log('[mock-workbuddy] 约定: token 含 EXHAUSTED → 402；含 DEAD → 401/12153；非流式 → 400');
});
