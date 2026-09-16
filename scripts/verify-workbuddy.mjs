#!/usr/bin/env node
/**
 * scripts/verify-workbuddy.mjs — WorkBuddy 接入的**离线**回归验证（不需要安装/登录 WorkBuddy）。
 *
 * 原理：用 scripts/mock-workbuddy.mjs 复刻 WorkBuddy 客户端接口的关键行为（强制流式、
 * tool_choice 只能是字符串、402 额度耗尽、401+12153 会话失效、OAuth 刷新），再把网关指过去，
 * 跑通「Anthropic 客户端 → 网关协议翻译 → OpenAI 线上游」的完整链路并断言结果。
 *
 * 用法：node scripts/verify-workbuddy.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败（便于接进 CI/发布前自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tmpDir = fs.mkdtempSync(path.join(root, 'out', '_verify-wb-'));
const MOCK_PORT = 3198;
const GW_PORT = 3093;
const KEY = 'gateway-verify-key-0123456789';   // 网关要求 apiKey ≥16 字符
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? ' :: ' + extra : '')); }
};

const writeAuth = (name, { token, uid, expiresInMs = 3600_000, refreshToken = 'RT-' + uid }) => {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify({
    auth: { accessToken: token, refreshToken, expiresAt: Date.now() + expiresInMs, domain: 'codebuddy.cn' },
    account: { uid, enterpriseId: 'ent-1', nickname: 'mock-' + uid },
  }), 'utf8');
  return p;
};

const a1 = writeAuth('wb-1.info', { token: 'AT-EXHAUSTED-1', uid: 'uid-1' });     // 额度耗尽
const a2 = writeAuth('wb-2.info', { token: 'AT-OK-2', uid: 'uid-2' });            // 正常
const a3 = writeAuth('wb-3.info', { token: 'AT-OLD-3', uid: 'uid-3', expiresInMs: -60_000 });  // 临期 → 触发刷新

const cfgPath = path.join(tmpDir, 'gateway.config.json');
const gwLog = path.join(tmpDir, 'gateway.log');
fs.writeFileSync(cfgPath, JSON.stringify({
  port: GW_PORT, apiKey: KEY, clientProfile: 'claude',
  providers: [{
    id: 'workbuddy',
    baseURL: `http://127.0.0.1:${MOCK_PORT}/v2`,
    protocol: 'openai-chat',
    auth: 'workbuddy',
    quirks: ['force-stream', 'stringify-tool-choice'],
    headers: { 'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2', 'X-Product': 'SaaS' },
    accounts: [{ id: 'a1', authFile: a1 }, { id: 'a2', authFile: a2 }],
    models: ['glm-5.3'],
    enabled: true,
  }],
}, null, 2), 'utf8');

const mockLog = path.join(tmpDir, 'mock.jsonl');
// 合成"已安装的 WorkBuddy"目录 → 身份仿真的版本来源可预测（不依赖本机是否装了 App）
const appDir = path.join(tmpDir, 'WorkBuddy');
fs.mkdirSync(path.join(appDir, 'resources', 'app.asar.unpacked', 'cli'), { recursive: true });
fs.writeFileSync(path.join(appDir, 'resources', 'install-manifest.json'), JSON.stringify({ appVersion: '9.9.9' }), 'utf8');
fs.writeFileSync(path.join(appDir, 'resources', 'app.asar.unpacked', 'cli', 'package.json'),
  JSON.stringify({ version: '0.0.0', publishConfig: { customPackage: { version: '3.3.3' } } }), 'utf8');
const mock = spawn(process.execPath, [path.join(root, 'scripts', 'mock-workbuddy.mjs'), '--port', String(MOCK_PORT), '--log', mockLog], { cwd: root, stdio: 'ignore', windowsHide: true });
const gwEnv = { ...process.env, WORKBUDDY_APP_DIR: appDir };
const gw = spawn(process.execPath, [path.join(root, 'src', 'gateway', 'model-gateway.mjs'), '--config', cfgPath, '--log', gwLog], { cwd: root, stdio: 'ignore', windowsHide: true, env: gwEnv });
await sleep(2500);

const call = async (payload, stream) => {
  const res = await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'glm-5.3', max_tokens: 64, stream, ...payload }),
    signal: AbortSignal.timeout(60000),
  });
  return { status: res.status, text: await res.text() };
};

try {
  console.log('== 1. 流式翻译（Anthropic 事件序列）==');
  let r = await call({ messages: [{ role: 'user', content: '你好' }] }, true);
  const evs = [...new Set((r.text.match(/^event: (\w+)/gm) || []).map((s) => s.replace('event: ', '')))];
  check(r.status === 200, 'HTTP 200', 'status=' + r.status);
  check(evs.includes('message_start') && evs.includes('content_block_delta') && evs.includes('message_stop'),
    'Anthropic 事件序列完整', evs.join(','));
  check(/"type":"thinking_delta"/.test(r.text) && /"type":"text_delta"/.test(r.text), 'thinking/text 增量都翻译');
  // 身份仿真（2026-09-16 实测：CLI 形态 UA 打 chat 会被上游判 model_param_invalid）
  {
    const lines = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const chatUa = (lines.find((l) => l.kind === 'chat') || {}).ua;
    check(chatUa === 'WorkBuddy/9.9.9 WorkBuddy/9.9.9 CLI/3.3.3', 'chat 用桌面客户端形态 UA', String(chatUa));
  }

  console.log('== 2. 账户池：额度耗尽自动换账户 ==');
  const log1 = fs.readFileSync(gwLog, 'utf8');
  check(/标记为 credit/.test(log1), '日志记录账户被标记为额度耗尽');
  check(/via=workbuddy#a2/.test(log1), '第二次请求使用了第二个账户', (log1.match(/via=workbuddy#\w+/g) || []).join(','));

  console.log('== 3. 非流式 + 工具调用（tool_choice 摊平）==');
  r = await call({
    stream: false,
    tool_choice: { type: 'tool', name: 'get_weather' },
    tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    messages: [{ role: 'user', content: '北京天气' }],
  }, false);
  let out = null;
  try { out = JSON.parse(r.text); } catch { /* 非 JSON */ }
  check(r.status === 200 && !!out, 'HTTP 200 且为 JSON', 'status=' + r.status);
  check(!!out && out.content.some((b) => b.type === 'tool_use' && b.name === 'get_weather' && b.input.city === '北京'),
    'tool_calls → Anthropic tool_use', JSON.stringify(out && out.content));
  check(!!out && out.stop_reason === 'tool_use', 'stop_reason=tool_use', out && out.stop_reason);

  console.log('== 4. 凭据刷新（临期 token）==');
  // 把第三个（临期）账户换上：重启网关并只留它
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW_PORT, apiKey: KEY, clientProfile: 'claude',
    providers: [{
      id: 'workbuddy', baseURL: `http://127.0.0.1:${MOCK_PORT}/v2`, protocol: 'openai-chat', auth: 'workbuddy',
      quirks: ['force-stream', 'stringify-tool-choice'], accounts: [{ id: 'a3', authFile: a3 }],
      models: ['glm-5.3'], enabled: true,
    }],
  }, null, 2), 'utf8');
  try { gw.kill(); } catch { /* 忽略 */ }
  await sleep(600);
  const gw2 = spawn(process.execPath, [path.join(root, 'src', 'gateway', 'model-gateway.mjs'), '--config', cfgPath, '--log', gwLog], { cwd: root, stdio: 'ignore', windowsHide: true, env: gwEnv });
  await sleep(2500);
  r = await call({ messages: [{ role: 'user', content: '你好' }] }, false);
  check(r.status === 200, '临期账户自动刷新后仍可用', 'status=' + r.status + ' ' + r.text.slice(0, 120));
  // 刷新证据在上游侧：mock 记录到 refresh 调用，且随后的 chat 用的是刷新后的 token
  const mockLines = fs.existsSync(mockLog)
    ? fs.readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const refreshed = mockLines.filter((l) => l.kind === 'refresh');
  check(refreshed.length >= 1 && refreshed[0].refreshToken === 'RT-uid-3',
    '向上游发起过 token 刷新（带 X-Refresh-Token）', JSON.stringify(refreshed));
  check(refreshed.length >= 1 && refreshed[0].ua === 'CLI/2.63.2 CodeBuddy/2.63.2',
    '刷新路径保持 CLI 形态 UA（与插件一致）', String(refreshed[0] && refreshed[0].ua));
  check(mockLines.some((l) => l.kind === 'chat' && l.token === 'AT-REFRESHED'),
    '后续对话使用刷新后的 token', JSON.stringify(mockLines.filter((l) => l.kind === 'chat').map((l) => l.token)));
  check(fs.existsSync(path.join(path.dirname(cfgPath), 'workbuddy-auth')), '凭据副本写在网关数据目录');
  try { gw2.kill(); } catch { /* 忽略 */ }

  console.log(`\n${fail === 0 ? '[OK]' : '[FAIL]'} ${pass} passed, ${fail} failed`);
} catch (e) {
  console.log('验证异常：' + (e && e.stack ? e.stack : e));
  fail++;
} finally {
  try { gw.kill(); } catch { /* 忽略 */ }
  try { mock.kill(); } catch { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(fail === 0 ? 0 : 1);
}
