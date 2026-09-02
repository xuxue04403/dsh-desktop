// gzip 返回的 mock 上游，用于验证网关透传压缩链路
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_PORT || 3195);
http.createServer((req, res) => {
  if (req.url.startsWith('/v1/chat/completions')) {
    // 响应 gzip 压缩的 JSON（配合客户端 accept-encoding: gzip）
    const payload = JSON.stringify({
      id: 'mock-gzip', object: 'chat.completion', model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'gzip-response-ok' }, finish_reason: 'stop' }],
    });
    if ((req.headers['accept-encoding'] || '').includes('gzip')) {
      const gz = zlib.gzipSync(payload);
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length });
      res.end(gz);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    }
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`gzip-mock on ${PORT}`));