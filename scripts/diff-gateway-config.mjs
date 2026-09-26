#!/usr/bin/env node
/**
 * 比较两个绿目录的 gateway.config.json（结构级，不是逐行文本 diff）。
 *
 * 为什么需要：乒乓构建时 data\ 是「各自保留、原样还原」的，两个目录的网关配置
 * 会因为「在哪个目录里点过保存」而各自演化 —— 主目录是权威，UAT 应当跟随。
 * 逐行 diff 会被 JSON 键顺序/缩进干扰，这里按供应商深比较，一眼看出谁缺谁多。
 *
 * 用法：
 *   node scripts/diff-gateway-config.mjs out/DSH-App out/DSH-App-UAT
 *   node scripts/diff-gateway-config.mjs out/DSH-App out/DSH-App-UAT gateway.config.intl.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dirA = process.argv[2] || 'out/DSH-App';
const dirB = process.argv[3] || 'out/DSH-App-UAT';
const fileName = process.argv[4] || 'gateway.config.json';

const fileA = path.resolve(ROOT, dirA, 'data', fileName);
const fileB = path.resolve(ROOT, dirB, 'data', fileName);

for (const f of [fileA, fileB]) {
  if (!fs.existsSync(f)) {
    console.error(`[FAIL] 找不到 ${f}`);
    process.exit(1);
  }
}

const a = JSON.parse(fs.readFileSync(fileA, 'utf8'));
const b = JSON.parse(fs.readFileSync(fileB, 'utf8'));

const statA = fs.statSync(fileA);
const statB = fs.statSync(fileB);

console.log(`A = ${fileA}`);
console.log(`    ${statA.size} B  mtime=${statA.mtime.toLocaleString('zh-CN')}`);
console.log(`B = ${fileB}`);
console.log(`    ${statB.size} B  mtime=${statB.mtime.toLocaleString('zh-CN')}`);
console.log('');

let diffs = 0;

const idsA = a.providers.map((p) => p.id);
const idsB = b.providers.map((p) => p.id);
console.log(`A 顺序: ${idsA.join(' > ')}`);
console.log(`B 顺序: ${idsB.join(' > ')}`);
if (JSON.stringify(idsA) === JSON.stringify(idsB)) {
  console.log('供应商顺序：相同');
} else {
  console.log('供应商顺序：**不同**（顺序影响同优先级供应商的候选次序）');
  diffs++;
}
console.log('');

for (const p of a.providers) {
  const q = b.providers.find((x) => x.id === p.id);
  if (!q) { console.log(`  [仅 A 有] ${p.id}`); diffs++; continue; }
  if (JSON.stringify(p) === JSON.stringify(q)) continue;
  diffs++;
  console.log(`  [内容不同] ${p.id}`);
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  for (const k of keys) {
    const va = JSON.stringify(p[k]);
    const vb = JSON.stringify(q[k]);
    if (va !== vb) console.log(`      ${k}:\n        A = ${va}\n        B = ${vb}`);
  }
}
for (const q of b.providers) {
  if (!a.providers.find((x) => x.id === q.id)) { console.log(`  [仅 B 有] ${q.id}`); diffs++; }
}

console.log('');
for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
  if (k === 'providers') continue;
  const va = JSON.stringify(a[k]);
  const vb = JSON.stringify(b[k]);
  if (va === vb) { console.log(`  [同] ${k}`); continue; }
  diffs++;
  console.log(`  [异] ${k}\n      A = ${va}\n      B = ${vb}`);
}

function visionList(cfg) {
  const out = [];
  for (const p of cfg.providers) {
    for (const m of p.models || []) if (m.vision) out.push(`${p.id}/${m.id}`);
  }
  return out;
}
const va = visionList(a);
const vb = visionList(b);
console.log('');
console.log(`vision=true 映射：A=${va.length}  B=${vb.length}`);
for (const x of va.filter((v) => !vb.includes(v))) { console.log(`  仅 A: ${x}`); diffs++; }
for (const x of vb.filter((v) => !va.includes(v))) { console.log(`  仅 B: ${x}`); diffs++; }

console.log('');
if (diffs) {
  console.log(`[差异] 共 ${diffs} 处。数据以主目录为准：确认主目录是对的之后，把主目录的文件复制到 UAT。`);
  process.exit(2);
}
console.log('[OK] 两个目录的该配置完全等价。');
