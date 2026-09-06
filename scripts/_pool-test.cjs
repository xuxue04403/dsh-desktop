// 连接池老化假设验证：当前网关（运行 40min）长短消息行为
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
// 构造长会话（90KB，含工具调用多轮——接近但小于真实）
function longReq() {
  const msgs = [{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' }];
  for (let i = 0; i < 200; i++) {
    msgs.push({ role: 'user', content: '第' + i + '轮：查看文件 ' + (i % 10) + ' 并总结' });
    msgs.push({ role: 'assistant', content: '第' + i + '轮：已查看并总结完成，文件结构正常，未发现异常。' });
  }
  return { model: 'deepseek-v4-flash', messages: msgs, stream: false, tools: [{ type: 'function', function: { name: 'bash', description: '运行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }] };
}
(async () => {
  const s = await call({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '回复OK' }], stream: false });
  console.log('短消息:', s.status);
  const l = await call(longReq());
  const m = l.body.match(/"code":"([a-z_]+)"/i) || l.body.match(/"message":"([^"]{0,60})/);
  console.log('长会话(200轮):', l.status, m ? m[1] || m[0] : 'OK');
  const s2 = await call({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '回复OK' }], stream: false });
  console.log('短消息(再):', s2.status);
  process.exit(0);
})();