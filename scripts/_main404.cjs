// 主目录网关当前状态实测（404 是否已随熔断过期恢复）
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
    const req = http.request({ host: '127.0.0.1', port: 3091, path: pathname, method: body ? 'POST' : 'GET', headers: h, timeout: 60000 }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', body: '' }); });
    req.on('error', (e) => resolve({ status: 'err:' + e.code, body: '' }));
    if (body) req.write(JSON.stringify(body)); req.end();
  });
}
const antH = { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' };
(async () => {
  console.log('health:', (await call('/health', null)).status);
  const m = await call('/v1/models', null);
  console.log('models:', m.status, ((m.body.match(/"id":"/g) || []).length), '模型');
  for (const mm of ['deepseek-v4-flash', 'glm-5.3']) {
    const r = await call('/v1/messages', { model: mm, max_tokens: 256, messages: [{ role: 'user', content: '回复OK' }] }, antH);
    const brief = r.status !== '200' ? r.body.slice(0, 100) : r.body.slice(0, 50).replace(/\s+/g, ' ');
    console.log(`${mm}: ${r.status} ${brief}`);
  }
  process.exit(0);
})();