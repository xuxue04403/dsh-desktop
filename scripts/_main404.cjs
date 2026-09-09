// 主目录网关当前状态实测（404 是否已随熔断过期恢复）
'use strict';
const http = require('http');
function call(pathname, body, headers) {
  return new Promise((resolve) => {
    const h = Object.assign({ 'content-type': 'application/json' }, headers || { authorization: 'Bearer dsh-gw-test-123' });
    const req = http.request({ host: '127.0.0.1', port: 3091, path: pathname, method: body ? 'POST' : 'GET', headers: h, timeout: 60000 }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', body: '' }); });
    req.on('error', (e) => resolve({ status: 'err:' + e.code, body: '' }));
    if (body) req.write(JSON.stringify(body)); req.end();
  });
}
const antH = { 'x-api-key': 'dsh-gw-test-123', 'anthropic-version': '2023-06-01' };
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