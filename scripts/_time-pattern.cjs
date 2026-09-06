// 时间模式实验：连续多条消息，观察 200/500 随时间的分布（区分连接池 vs 内容）
'use strict';
const http = require('http');
function call(body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 3091, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dsh-gw-test-123' }, timeout: 90000 }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', body: '' }); });
    req.on('error', (e) => resolve({ status: 'err:' + e.code, body: '' }));
    req.write(JSON.stringify(body)); req.end();
  });
}
(async () => {
  const SHORT = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '回复OK' }], stream: false };
  console.log('时间           结果');
  for (let i = 1; i <= 6; i++) {
    const t0 = new Date();
    const r = await call(SHORT);
    const m = r.body.match(/"code":"([a-z_]+)"/i);
    console.log(`${t0.toTimeString().slice(0, 8)} #${i}: ${r.status} ${m ? m[1] : 'OK'}`);
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  process.exit(0);
})();