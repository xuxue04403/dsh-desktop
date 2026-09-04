// T5：Anthropic 协议 mock 上游（/v1/messages 端点，JSON + SSE）
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 3190);

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => raw += c);
  req.on('end', () => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ type: 'model', id: 'glm-5.3', display_name: 'glm-5.3' }] }));
      return;
    }
    if (req.url.startsWith('/v1/messages')) {
      // 记录收到的鉴权头（验证 x-api-key 与 anthropic-version）
      const authMode = req.headers['x-api-key'] ? 'x-api-key' : (req.headers['authorization'] ? 'bearer' : 'none');
      const ver = req.headers['anthropic-version'] || null;
      const body = JSON.parse(raw || '{}');
      const model = body.model || 'unknown';
      if (authMode !== 'x-api-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'mock expects x-api-key' } }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_mock', model, role: 'assistant', content: [] } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: `Hi from ${model} ` } })}\n\n`);
        res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_mock', type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: `Hi from ${model} (ver=${ver})` }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      }
      return;
    }
    res.writeHead(404); res.end();
  });
}).listen(PORT, '127.0.0.1');