// scripts/probe-workbuddy-net.mjs — 代理/直连连通性探针（排障用，2026-09-16 事故）
//
// 事故背景：网关进程带着 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY=http://127.0.0.1:7890 运行时，
// Node 会把**所有**请求（含连 127.0.0.1 的自检）交给 EnvHttpProxyAgent；clash 端口一没监听，
// 全部请求 8–30ms 内 ECONNREFUSED，日志只有 "fetch failed" → 看上去像上游挂了。
//
// 用法（环境变量必须在**进程启动前**设好：EnvHttpProxyAgent 只在启动时读一次 env）：
//   走代理：  NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 NO_PROXY= node scripts/probe-workbuddy-net.mjs
//   直连：    NO_PROXY=copilot.tencent.com node scripts/probe-workbuddy-net.mjs
//   换目标：  PROBE_HOST=token.sensenova.cn PROBE_PATH=/ node scripts/probe-workbuddy-net.mjs
// 判读：HTTP 4xx（401/404）也算**连通**（只有 body 层面的拒绝）；ECONNREFUSED = 代理/端口没通。
const HOST = process.env.PROBE_HOST || 'copilot.tencent.com';
const PATHNAME = process.env.PROBE_PATH || '/v2/chat/completions';
const TARGET = `https://${HOST}${PATHNAME}`;
const LOOPBACK = `http://127.0.0.1:${process.env.PROBE_GW_PORT || 3091}/health`;

const show = (e) => (e && e.cause ? (e.cause.code || e.cause.message) : (e && e.message));

async function probe(label, url, init) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text().catch(() => '');
    console.log(`${label} HTTP ${res.status} (${Date.now() - t0}ms) ${text.slice(0, 100).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`${label} FAIL ${show(e)} (${Date.now() - t0}ms)`);
  }
}

console.log(`env: NODE_USE_ENV_PROXY=${process.env.NODE_USE_ENV_PROXY || '(unset)'} `
  + `HTTPS_PROXY=${process.env.HTTPS_PROXY || '(unset)'} NO_PROXY=${process.env.NO_PROXY || '(unset)'}`);
// ① 上游（连通即算成功：401/404 也是上游在应答）
await probe(`[upstream ${HOST}]`, TARGET, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: process.env.PROBE_MODEL || 'hy3', stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
});
// ② 本机回环（网关自检路径）：这一条若失败而网关进程还活着 → 就是"回环被塞进代理"那类事故
await probe('[loopback /health]', LOOPBACK, { method: 'GET' });
