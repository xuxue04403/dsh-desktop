// 一次性探测脚本：验证 Cline（api.cline.bot）能否作为普通 OpenAI 兼容供应商接入网关。
// 用法：node scripts/probe-cline-api.mjs [apiKey]
// 不带 apiKey 时只测「无鉴权」行为——观察 401 的具体形状本身也是证据。

const BASE = 'https://api.cline.bot/api/v1';
const apiKey = process.argv[2] || '';

// 仿真 Cline 官方客户端身份头（来自 jiesou/dsh-cline-free-provider 的实现）
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

const log = (...a) => console.log(...a);

async function tryFetch(label, url, init = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
    const text = await res.text();
    const ms = Date.now() - t0;
    log(`\n=== ${label} ===`);
    log(`HTTP ${res.status}  (${ms} ms)  content-type=${res.headers.get('content-type') || '-'}`);
    log(text.slice(0, 900));
    return { status: res.status, text, ms };
  } catch (e) {
    log(`\n=== ${label} ===`);
    log(`FAILED after ${Date.now() - t0} ms: ${e.name}: ${e.message}`);
    return { status: 0, text: '', ms: Date.now() - t0 };
  }
}

// 1) 模型目录（OpenAI 形状 vs OpenRouter 富元数据形状）
await tryFetch('GET /models (OpenAI 形状, 无鉴权)', `${BASE}/models`);
await tryFetch('GET /ai/cline/models (富元数据, 无鉴权)', `${BASE}/ai/cline/models`);

// 2) 推理端点：分别测「裸请求」「带 Cline 身份头」「带身份头+Key」
const body = (model) => JSON.stringify({
  model,
  messages: [{ role: 'user', content: 'say ok' }],
  max_tokens: 16,
  stream: false,
});

const MODEL = 'deepseek/deepseek-v4-flash';

await tryFetch(`POST /chat/completions  model=${MODEL}  (裸, 无鉴权)`, `${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body(MODEL),
});

await tryFetch(`POST /chat/completions  model=${MODEL}  (Cline 身份头, 无鉴权)`, `${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...CLINE_HEADERS },
  body: body(MODEL),
});

if (apiKey) {
  await tryFetch(`POST /chat/completions  model=${MODEL}  (Cline 身份头 + Bearer)`, `${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLINE_HEADERS, authorization: `Bearer ${apiKey}` },
    body: body(MODEL),
  });
  // 免费模型 + Key：验证「:free 模型是否需要 Key」
  const FREE = 'z-ai/glm-5.2:free';
  await tryFetch(`POST /chat/completions  model=${FREE}  (Cline 身份头 + Bearer)`, `${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLINE_HEADERS, authorization: `Bearer ${apiKey}` },
    body: body(FREE),
  });
} else {
  log('\n[提示] 未提供 apiKey —— 跳过带鉴权的推理测试。');
}

// 3) 流式（网关 quirks 可能需要 force-stream）
if (apiKey) {
  const MODEL2 = 'deepseek/deepseek-v4-flash';
  await tryFetch(`POST /chat/completions  stream=true (带 Key)`, `${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLINE_HEADERS, authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL2, messages: [{ role: 'user', content: 'say ok' }], max_tokens: 16, stream: true }),
  });
}
