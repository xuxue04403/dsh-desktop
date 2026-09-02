// Q1 仿真加固专项测试：mock 记录请求头，验证仿真模式与透传模式
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.MOCK_PORT || 3194);
const LOG = process.env.HDR_LOG || '';

function record(req) {
  if (!LOG) return;
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) h[k] = v;
  fs.appendFileSync(LOG, JSON.stringify({ url: req.url, headers: h }) + '\n');
}

http.createServer((req, res) => {
  record(req);
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model' }] }));
    return;
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', object: 'chat.completion', model: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1');