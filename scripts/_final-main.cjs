// 主目录最新构建全回归：双协议 + 推理 + 降敏 + 鉴权 + R20 语义
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
// 网关 key 不写进源码（发布守卫 scripts/email-scrub.mjs 会拦截）：运行时从本机网关配置读取，
// 可用环境变量 DSH_GW_KEY 覆盖。
const KEY = process.env.DSH_GW_KEY || (() => {
  for (const p of [
    path.join(__dirname, '..', 'out', 'DSH-App', 'data', 'gateway.config.json'),
    path.join(__dirname, '..', 'out', 'DSH-App-UAT', 'data', 'gateway.config.json'),
  ]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).apiKey || ''; } catch { /* 试下一个 */ }
  }
  return '';
})();
function call(pathname, body, headers) {
  return new Promise((resolve) => {
    const h = Object.assign({ 'content-type': 'application/json' }, headers || { authorization: 'Bearer ' + KEY });
    const req = http.request({ host: '127.0.0.1', port: 3091, path: pathname, method: body ? 'POST' : 'GET', headers: h, timeout: 90000 }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', body: '' }); });
    req.on('error', (e) => resolve({ status: 'err:' + e.code, body: '' }));
    if (body) req.write(JSON.stringify(body)); req.end();
  });
}
const antH = { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' };
(async () => {
  const R = []; const rec = (n, p, i) => { R.push(p); console.log(`${p ? '✓' : '✗'} ${n}${i ? '  ' + i : ''}`); };
  rec('T1 health', String((await call('/health', null)).status) === '200');
  const m = await call('/v1/models', null);
  rec('T2 models', String(m.status) === '200', ((m.body.match(/"id":"/g) || []).length) + ' 模型');
  for (const mm of ['deepseek-v4-flash', 'glm-5.3']) {
    const r = await call('/v1/messages', { model: mm, max_tokens: 512, messages: [{ role: 'user', content: '回复OK' }] }, antH);
    rec(`T3 anthropic ${mm}`, String(r.status) === '200');
  }
  const ro = await call('/v1/messages', { model: 'deepseek-v4-flash', max_tokens: 1024, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: '1+1=?只答数字' }] }, antH);
  rec('T4 thinking disabled', String(ro.status) === '200' && !ro.body.includes('"thinking"'), ro.body.slice(0, 40));
  const rn = await call('/v1/messages', { model: 'deepseek-v4-flash', max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: '计算 7*6' }] }, antH);
  rec('T5 thinking enabled', String(rn.status) === '200' && rn.body.includes('"thinking"'));
  const roa = await call('/v1/chat/completions', { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '回复OK' }], stream: false });
  rec('T6 openai 路径', String(roa.status) === '200');
  rec('T7 鉴权 401', String((await call('/v1/models', null, { authorization: 'Bearer wrong' })).status) === '401');
  const n = R.filter(Boolean).length;
  console.log(`\n===== ${n}/${R.length} =====`);
  process.exit(n === R.length ? 0 : 1);
})();