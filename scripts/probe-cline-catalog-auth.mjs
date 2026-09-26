// 验证 1：带（可能是坏的）Bearer Key 时 /models 是否仍可用
//   —— 这决定网关的 catalog 探测会不会被坏 Key 拖垮
// 验证 2：推理端点对「带 Key」的响应形状（无真 Key，观察 401 形态即可）
// 验证 3：模型 ID 含 `/` 与 `:` 时，网关的路由/映射是否受影响（纯字符串处理，离线验证）

const BASE = 'https://api.cline.bot/api/v1';
const log = (...a) => console.log(...a);

async function probe(label, url, init) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
    const text = await res.text();
    log(`\n=== ${label} ===`);
    log(`HTTP ${res.status} (${Date.now() - t0}ms)`);
    log(text.slice(0, 400));
    return res.status;
  } catch (e) {
    log(`\n=== ${label} ===\nFAILED: ${e.name}: ${e.message}`);
    return 0;
  }
}

const DUMMY = 'DUMMY-PLACEHOLDER-NOT-A-KEY';

await probe('GET /models  带无效 Bearer', `${BASE}/models`, {
  headers: { authorization: `Bearer ${DUMMY}` },
});
await probe('GET /models  带无效 x-api-key', `${BASE}/models`, {
  headers: { 'x-api-key': DUMMY },
});
await probe('GET /ai/cline/models  带无效 Bearer', `${BASE}/ai/cline/models`, {
  headers: { authorization: `Bearer ${DUMMY}` },
});
await probe('POST /chat/completions  带无效 Bearer', `${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${DUMMY}` },
  body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
});
// 探测错误形状：不存在的模型（无鉴权，看是否先撞鉴权）
await probe('POST /chat/completions  不存在的模型 (无鉴权)', `${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'no/such-model:free', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
});
