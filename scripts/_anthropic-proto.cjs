// 决定性：Anthropic /v1/messages 协议 + 长会话内容 → agentrouter（模拟 Claude Code 形态）
'use strict';
const cfg = JSON.parse(require('fs').readFileSync('D:/IDE/dsh/dsh-app/out/DSH-App/data/gateway.config.json', 'utf8'));
const p = cfg.providers.find((x) => x.id === 'agentrouter');
const UA = 'claude-cli/2.0.0 (external, cli)';

function longContent(n) {
  let s = 'You are an AI agent. 会话历史：\n';
  for (let i = 0; i < n; i++) {
    s += `第${i}轮：工具返回 sha256 322e26f76e35839b8ca20e95090802d26f0a1da304de5bc55e3be7e8c16eb4d7，文件 dsh-app，路径 D:\\IDE\\dsh。`;
  }
  return s;
}

async function anthropic(content, label) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 120000);
  try {
    const res = await fetch('https://agentrouter.org/v1/messages', {
      method: 'POST',
      headers: { 'user-agent': UA, 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 2048, messages: [{ role: 'user', content }] }),
      signal: c.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    const m = text.match(/"code":"([a-z_]+)"/i) || text.match(/sensitive|content-blocked/i);
    console.log(`${label.padEnd(30)} -> HTTP ${res.status} ${m ? '→ ' + (m[1] || m[0]) : 'OK ' + text.slice(0, 50).replace(/\s+/g, ' ')}`);
  } catch (e) { clearTimeout(t); console.log(`${label.padEnd(30)} -> FAILED ${e.message}`); }
}

(async () => {
  await anthropic(longContent(5), 'Anthropic 短(5轮+sha256)');
  await anthropic(longContent(600), 'Anthropic 长(600轮+sha256, 90KB)');
  await anthropic(longContent(2000), 'Anthropic 超长(2000轮, 300KB)');
  process.exit(0);
})();