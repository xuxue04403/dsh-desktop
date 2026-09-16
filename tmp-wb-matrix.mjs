// 临时：定位 workbuddy HTTP 400 model_param_invalid 的触发参数（用后即删）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(root, 'out', '_wb-matrix-'));
const cfgPath = path.join(tmpDir, 'gateway.config.json');
const logPath = path.join(tmpDir, 'gateway.log');
const PORT = 3092;

// 复刻网关的身份解析，打印我们实际会发的 UA
const manifest = JSON.parse(fs.readFileSync('C:/Program Files/WorkBuddy/resources/install-manifest.json', 'utf8'));
const cliPkg = JSON.parse(fs.readFileSync('C:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/package.json', 'utf8'));
const cliVer = (cliPkg.version && cliPkg.version !== '0.0.0') ? cliPkg.version : cliPkg.publishConfig?.customPackage?.version;
const ua = `WorkBuddy/${manifest.appVersion} WorkBuddy/${manifest.appVersion} CLI/${cliVer}`;
console.log('本机解析出的桌面身份 UA: ' + ua + '\n');

const main = JSON.parse(fs.readFileSync('out/DSH-App/data/gateway.config.json', 'utf8'));
let wb = main.providers.find((p) => p.id === 'workbuddy');
wb = JSON.parse(JSON.stringify(wb));
delete wb.headers['User-Agent'];   // chat 不再吃配置 UA（用仿真身份）
fs.writeFileSync(cfgPath, JSON.stringify({ port: PORT, apiKey: main.apiKey, clientProfile: 'claude', providers: [wb] }, null, 2), 'utf8');

const gw = spawn(process.execPath, ['src/gateway/model-gateway.mjs', '--config', cfgPath, '--log', logPath], { cwd: root, stdio: 'ignore', windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
for (let i = 0; i < 40; i++) { await sleep(500); if (/listening on/.test(readLog())) break; }
console.log('临时网关(' + PORT + ') 就绪（仅 workbuddy，桌面身份仿真）\n');

const call = async (label, body) => {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': main.apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let note = '';
  if (res.ok) {
    try { const o = JSON.parse(text); note = '块=' + o.content.map((b) => b.type).join(',') + ' stop=' + o.stop_reason; }
    catch { note = 'SSE ' + text.slice(0, 60).replace(/\s+/g, ' '); }
  } else {
    const m = /"code":(\d+)/.exec(text); const msg = /"msg":"([^"]{0,90})/.exec(text);
    const p = /"param":"([^"]*)"/.exec(text);
    note = 'code=' + (m ? m[1] : '?') + ' ' + (msg ? msg[1] : text.slice(0, 80)) + (p ? ' param=' + p[1] : '');
  }
  console.log(`  ${res.ok ? 'OK  ' : 'FAIL'} ${label.padEnd(34)} HTTP ${res.status} ${String(Date.now() - started).padStart(6)}ms ${note}`);
};

const TOOLS = [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
const M = (extra = {}) => ({ model: 'deepseek-v4.1-flash', max_tokens: 256, stream: true, messages: [{ role: 'user', content: '只回复：ok' }], ...extra });

console.log('=== 参数矩阵（模型 deepseek-v4.1-flash）===');
await call('A 基线（无工具/小 max_tokens）', M());
await call('B + tools + tool_choice auto', M({ tools: TOOLS, tool_choice: { type: 'auto' } }));
await call('C + max_tokens=128000', M({ max_tokens: 128000 }));
await call('D + thinking(budget 16384→max)', M({ thinking: { type: 'enabled', budget_tokens: 16384 } }));
await call('E 多轮工具历史', M({
  tools: TOOLS,
  messages: [
    { role: 'user', content: '北京天气？' },
    { role: 'assistant', content: [{ type: 'text', text: '我查一下' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25℃' }] },
    { role: 'user', content: '用一句话总结' },
  ],
}));
await call('F system + tools（harness 形态）', M({
  system: '你是助手', tools: TOOLS, tool_choice: { type: 'auto' },
  messages: [{ role: 'user', content: '只回复：ok' }],
}));
await call('G tools + thinking 同时开', M({ tools: TOOLS, tool_choice: { type: 'auto' }, thinking: { type: 'enabled', budget_tokens: 4096 } }));

console.log('\n=== 网关日志（400 详情）===');
console.log(readLog().split('\n').filter((l) => /HTTP 4|HTTP 5|确定性|served|\[call\]/.test(l)).join('\n'));

gw.kill();
await sleep(400);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
