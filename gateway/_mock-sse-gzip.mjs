// SSE 返回的 mock：仅当 accept-encoding 为 gzip 时压缩，identity 时明文——模拟真实上游行为
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_PORT || 3196);
http.createServer((req, res) => {
  if (!req.url.startsWith('/v1/chat/completions')) { res.writeHead(404); res.end(); return; }
  const wantGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (chunk, cb) => {
    if (wantGzip) {
      res.write(zlib.gzipSync(chunk), cb);
    } else {
      res.write(chunk, cb);
    }
  };
  send('data: {"id":"1","choices":[{"delta":{"content":"chunk1 "}}]}\n\n', () => {
    setTimeout(() => {
      send('data: {"id":"2","choices":[{"delta":{"content":"chunk2"}}]}\n\n', () => {
        send('data: [DONE]\n\n', () => res.end());
      });
    }, 100);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`sse-mock on ${PORT}`));