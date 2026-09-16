// 临时：补充参数矩阵（temperature / 并行工具调用 / is_error / 长历史 / 大上下文）（用后即删）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(root, 'out', '_wb-matrix2-'));
const cfgPath = path.join(tmpDir, 'gateway.config.json');
const logPath = path.join(tmpDir, 'gateway.log');
const PORT = 3092;

const main = JSON.parse(fs.readFileSync('out/DSH-App/data/gateway.config.json', 'utf8'));
const wb = JSON.parse(JSON.stringify(main.providers.find((p) => p.id === 'workbuddy')));
delete wb.headers['User-Agent'];
fs.writeFileSync(cfgPath, JSON.stringify({ port: PORT, apiKey: main.apiKey, clientProfile: 'claude', providers: [wb] }, null, 2), 'utf8');

const gw = spawn(process.execPath, ['src/gateway/model-gateway.mjs', '--config', cfgPath, '--log', logPath], { cwd: root, stdio: 'ignore', windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
for (let i = 0; i < 40; i++) { await sleep(500); if (/listening on/.test(readLog())) break; }

const call = async (label, body) => {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': main.apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let note;
  if (res.ok) {
    try { const o = JSON.parse(text); note = '块=' + o.content.map((b) => b.type).join(',') + ' stop=' + o.stop_reason + ' usage=' + JSON.stringify(o.usage); }
    catch { note = 'SSE ' + text.slice(0, 50).replace(/\s+/g, ' '); }
  } else {
    const c = /"code":(\d+)/.exec(text); const m = /"msg":"([^"]{0,80})/.exec(text);
    note = 'code=' + (c ? c[1] : '?') + ' ' + (m ? m[1] : text.slice(0, 80));
  }
  console.log(`  ${res.ok ? 'OK  ' : 'FAIL'} ${label.padEnd(30)} HTTP ${res.status} ${String(Date.now() - started).padStart(6)}ms ${note}`);
};

const TOOLS = [
  { name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  { name: 'get_time', description: '查时间', input_schema: { type: 'object', properties: { tz: { type: 'string' } } } },
];
const base = (extra) => ({ model: 'deepseek-v4.1-flash', max_tokens: 512, stream: false, messages: [{ role: 'user', content: '只回复：ok' }], ...extra });

console.log('=== 补充矩阵（模型 deepseek-v4.1-flash，桌面身份）===');
await call('H + temperature=1', base({ temperature: 1 }));
await call('I + 并行工具调用历史', base({
  tools: TOOLS,
  messages: [
    { role: 'user', content: '北京天气和时间' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: '北京' } },
      { type: 'tool_use', id: 't2', name: 'get_time', input: { tz: 'Asia/Shanghai' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: '晴 25℃' },
      { type: 'tool_result', tool_use_id: 't2', content: '14:45' },
    ] },
    { role: 'user', content: '总结一句' },
  ],
}));
await call('J + tool_result is_error=true', base({
  tools: TOOLS,
  messages: [
    { role: 'user', content: '查天气' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: '火星' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '城市不存在', is_error: true }] },
    { role: 'user', content: '那就说不知道' },
  ],
}));
await call('K 长历史（40 轮）', base({
  messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i}轮：这是一段用于测试的历史内容。` })).concat([{ role: 'user', content: '只回复：ok' }]),
}));
await call('L + thinking(max) + tools + system', base({
  system: '你是助手', thinking: { type: 'enabled', budget_tokens: 32768 }, tools: TOOLS, tool_choice: { type: 'auto' },
}));

console.log('\n=== 网关日志（400）===');
const bad = readLog().split('\n').filter((l) => /HTTP 4|确定性|failover stopped/.test(l));
console.log(bad.length ? bad.join('\n') : '（无 4xx）');

gw.kill();
await sleep(400);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
