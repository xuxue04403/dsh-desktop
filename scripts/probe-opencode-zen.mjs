// scripts/probe-opencode-zen.mjs — opencode zen 端点/模型/账号体检（排障用，2026-09-16）
//
// 用途：dsh 调 opencode zen 报错时，一条命令分清是「路径配错」「线协议选错」「账号/计费被挡」还是「模型名不对」。
//
// 结论要点（本次实测）：
//   1) baseURL 必须只到 /zen（pi-ai/Anthropic SDK 会自己追加 /v1/messages）。
//      写成 https://opencode.ai/zen/v1/messages 会拼成 .../messages/messages → opencode **网站**的
//      HTML 404 页（不是 API 的 JSON 错误）——这正是"本轮运行失败404 <!DOCTYPE html>"的成因。
//   2) union-alpha 走 anthropic-messages（/v1/messages）；在 /v1/chat/completions 上是 500。
//   3) 免费额度账号调免费模型（union-alpha / big-pickle / mimo-v2.5-free）→ 403 FreeTierError
//      "OpenCode's free tier can only be used from within OpenCode"；付费模型 → 401 CreditsError。
//      这是 zen 账号侧政策，网关/任何中转都改不了。
//
// 用法：node scripts/probe-opencode-zen.mjs            （key 取自 dsh 凭据文件，不打印）
//       ZEN_KEY=sk-... node scripts/probe-opencode-zen.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function loadKey() {
  if (process.env.ZEN_KEY) return process.env.ZEN_KEY;
  // 默认读 dsh 凭据服务落盘的文件；不写死用户名/盘符（DSH_CREDENTIALS 可覆盖）
  const p = process.env.DSH_CREDENTIALS || path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const m = /OPENCODE_ZEN_API_KEY:\s*['"]?([^\s'"]+)/.exec(fs.readFileSync(p, 'utf8'));
    if (m) return m[1];
  } catch (_) { /* 忽略 */ }
  return '';
}
const KEY = loadKey();
console.log('key:', KEY ? '已载入 len=' + KEY.length : '（未找到，仅做无鉴权探测）');
console.log('');

const shape = (t) => (/<!DOCTYPE|<html/i.test(t) ? '*** HTML 网站 404 页（路径不存在）***' : t.replace(/\s+/g, ' ').slice(0, 170));
const hit = async (label, url, { model, wire } = {}) => {
  const headers = { 'content-type': 'application/json' };
  const body = { model, max_tokens: 16, messages: [{ role: 'user', content: 'say ok' }] };
  if (wire === 'anthropic') { headers['x-api-key'] = KEY || 'probe'; headers['anthropic-version'] = '2023-06-01'; }
  else headers.authorization = 'Bearer ' + (KEY || 'probe');
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    console.log(`${label.padEnd(46)} HTTP ${res.status} (${Date.now() - t0}ms)  ${shape(await res.text())}`);
  } catch (e) {
    console.log(`${label.padEnd(46)} FAIL ${e.cause ? e.cause.code : e.message}`);
  }
};

// ① 模型目录：union-alpha 是否存在
try {
  const list = await (await fetch('https://opencode.ai/zen/v1/models')).json();
  const ids = (list.data || []).map((m) => m.id);
  console.log(`GET  /zen/v1/models -> ${ids.length} 个模型；union-alpha 在列: ${ids.includes('union-alpha')}`);
} catch (e) { console.log('GET /zen/v1/models FAIL', e.message); }
console.log('');

// ② 路径正确性（关键：messages 而不是 messages/messages）
await hit('POST /zen/v1/messages  (正确路径)', 'https://opencode.ai/zen/v1/messages', { model: 'union-alpha', wire: 'anthropic' });
await hit('POST /zen/v1/messages/messages (用户现场)', 'https://opencode.ai/zen/v1/messages/messages', { model: 'union-alpha', wire: 'anthropic' });
console.log('');

// ③ 线协议与账号状态
await hit('POST /zen/v1/chat/completions (OpenAI 线)', 'https://opencode.ai/zen/v1/chat/completions', { model: 'union-alpha', wire: 'openai' });
await hit('POST /zen/v1/messages + 付费模型', 'https://opencode.ai/zen/v1/messages', { model: 'claude-haiku-4-5', wire: 'anthropic' });
await hit('POST /zen/v1/chat/completions + 免费模型', 'https://opencode.ai/zen/v1/chat/completions', { model: 'big-pickle', wire: 'openai' });
