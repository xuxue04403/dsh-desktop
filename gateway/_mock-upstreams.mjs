#!/usr/bin/env node
/**
 * Local mock upstream for gateway E2E tests (localhost only).
 * Mock A: serves deepseek-v4-flash, healthy.
 * Mock B: serves deepseek-v4-flash, always 500 (simulates dead provider).
 * Mock C: serves glm-5.2 only, healthy.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 3190);

function catalog(models) {
  return { object: 'list', data: models.map((id) => ({ id, object: 'model' })) };
}

const servers = [
  { port: PORT, models: ['deepseek-v4-flash', 'glm-5.2'], fail: false, name: 'mock-A' },
  { port: PORT + 1, models: ['deepseek-v4-flash'], fail: true, name: 'mock-B' },
  { port: PORT + 2, models: ['glm-5.2'], fail: false, name: 'mock-C' },
];

for (const s of servers) {
  http.createServer(async (req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(catalog(s.models)));
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      if (s.fail) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `${s.name} is down` } }));
        return;
      }
      const model = body.model || 'unknown';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'mock1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: `Hi from ${s.name} ` }, finish_reason: null }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ id: 'mock2', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: `Hi from ${s.name}` }, finish_reason: 'stop' }] }));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  }).listen(s.port, '127.0.0.1', () => console.log(`${s.name} on ${s.port}`));
}

process.on('SIGINT', () => process.exit(0));