// 关键判定：Cline 推理端点是否**强制校验** Cline 官方客户端身份头？
// 方法：带一把无效 Key，分别测「裸头」与「完整 Cline 仿真头」。
//   - 两种都回 "Unauthorized ... re-authenticate" → 说明校验的是 Key，头不重要
//   - 裸头被拒、仿真头给出不同的错（如模型/额度错误）→ 说明强制校验身份头
// 带重试以对抗代理抖动。

const BASE = 'https://api.cline.bot/api/v1';
const MODEL = 'deepseek/deepseek-v4-flash';
const DUMMY = 'DUMMY-PLACEHOLDER-NOT-A-KEY';

const CLINE_HEADERS = {
  'User-Agent': 'Cline/3.0.47',
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk',
  'X-CLIENT-VERSION': '3.0.47',
  'X-PLATFORM': 'terminal',
  'X-PLATFORM-VERSION': '3.0.47',
  'X-CORE-VERSION': '0.0.66',
};

const body = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: 'say ok' }],
  max_tokens: 8,
  stream: false,
});

async function post(label, headers, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      console.log(`\n[${label}] try${i} → HTTP ${res.status} (${Date.now() - t0}ms)`);
      console.log(text.slice(0, 300).replace(/\s+/g, ' '));
      return res.status;
    } catch (e) {
      console.log(`[${label}] try${i} → FAIL ${e.name}: ${e.message} (${Date.now() - t0}ms)`);
    }
  }
  return 0;
}

console.log('--- 对照组：无效 Key ---');
await post('裸头 + 无效Key', { authorization: `Bearer ${DUMMY}` });
await post('Cline仿真头 + 无效Key', { ...CLINE_HEADERS, authorization: `Bearer ${DUMMY}` });

console.log('\n--- 无 Key ---');
await post('裸头 无Key', {});
await post('Cline仿真头 无Key', { ...CLINE_HEADERS });

console.log('\n--- GET /models 对照（目录是否受 Key 影响）---');
for (const [label, h] of [['裸头', {}], ['无效Key', { authorization: `Bearer ${DUMMY}` }]]) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(`${BASE}/models`, { headers: h, signal: AbortSignal.timeout(60_000) });
      const t = await r.text();
      console.log(`[GET /models ${label}] try${i} → HTTP ${r.status} ${t.slice(0, 80).replace(/\s+/g, ' ')}`);
      break;
    } catch (e) {
      console.log(`[GET /models ${label}] try${i} → FAIL ${e.name}`);
    }
  }
}
