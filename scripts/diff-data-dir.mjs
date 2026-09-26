#!/usr/bin/env node
/**
 * 比较两个绿目录的 data\ 树：按顶层条目汇总，逐文件找出「仅 A 有 / 仅 B 有 / 内容不同」。
 * 先比 size+mtime 快速定位，再对候选算 SHA256 确认（避免 25k 文件全量哈希）。
 *
 * 用法：node scripts/diff-data-dir.mjs out/DSH-App out/DSH-App-UAT
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirA = path.resolve(ROOT, process.argv[2] || 'out/DSH-App', 'data');
const dirB = path.resolve(ROOT, process.argv[3] || 'out/DSH-App-UAT', 'data');

function walk(root) {
  const out = new Map();
  const stack = [['', root]];
  while (stack.length) {
    const [rel, abs] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      const a = path.join(abs, e.name);
      if (e.isDirectory()) stack.push([r, a]);
      else if (e.isFile()) {
        let st;
        try { st = fs.statSync(a); } catch { continue; }
        out.set(r, { size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  return out;
}

function sha(f) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; }
}

console.log(`A = ${dirA}`);
console.log(`B = ${dirB}`);
console.log('');

const A = walk(dirA);
const B = walk(dirB);

// 顶层汇总
function topSummary(m) {
  const s = new Map();
  for (const [rel, v] of m) {
    const top = rel.includes('/') ? rel.split('/')[0] : '(根文件)';
    const cur = s.get(top) || { n: 0, bytes: 0, maxMtime: 0 };
    cur.n++; cur.bytes += v.size; cur.maxMtime = Math.max(cur.maxMtime, v.mtime);
    s.set(top, cur);
  }
  return s;
}
const sa = topSummary(A), sb = topSummary(B);
console.log('顶层条目对比（A=主目录, B=UAT）:');
console.log('  ' + 'entry'.padEnd(22) + 'A文件'.padStart(8) + 'A大小'.padStart(12) + '  ' + 'B文件'.padStart(8) + 'B大小'.padStart(12) + '  最新修改(B)');
for (const k of new Set([...sa.keys(), ...sb.keys()].sort())) {
  const a = sa.get(k) || { n: 0, bytes: 0, maxMtime: 0 };
  const b = sb.get(k) || { n: 0, bytes: 0, maxMtime: 0 };
  const t = b.maxMtime ? new Date(b.maxMtime).toLocaleString('zh-CN') : '-';
  console.log('  ' + k.padEnd(22) + String(a.n).padStart(8) + (a.bytes / 1024).toFixed(0).padStart(11) + 'K'
    + '  ' + String(b.n).padStart(8) + (b.bytes / 1024).toFixed(0).padStart(11) + 'K   ' + t);
}
console.log('');

const onlyA = [];
const onlyB = [];
const cand = [];
for (const [rel, va] of A) {
  const vb = B.get(rel);
  if (!vb) { onlyA.push(rel); continue; }
  if (va.size !== vb.size || Math.abs(va.mtime - vb.mtime) > 1500) cand.push(rel);
}
for (const rel of B.keys()) if (!A.has(rel)) onlyB.push(rel);

console.log(`仅 A 有: ${onlyA.length} 个`);
for (const r of onlyA.slice(0, 40)) console.log(`    + ${r}`);
if (onlyA.length > 40) console.log(`    … 另有 ${onlyA.length - 40} 个`);
console.log(`仅 B 有: ${onlyB.length} 个`);
for (const r of onlyB.slice(0, 40)) console.log(`    - ${r}`);
if (onlyB.length > 40) console.log(`    … 另有 ${onlyB.length - 40} 个`);
console.log('');

console.log(`大小/时间可疑（待哈希确认）: ${cand.length} 个`);
const realDiff = [];
for (const rel of cand) {
  const ha = sha(path.join(dirA, rel));
  const hb = sha(path.join(dirB, rel));
  if (ha !== hb) realDiff.push(rel);
}
console.log(`哈希确认后真正内容不同: ${realDiff.length} 个`);
for (const r of realDiff.slice(0, 60)) {
  const a = A.get(r), b = B.get(r);
  console.log(`    ~ ${r}  A=${a.size}B/${new Date(a.mtime).toLocaleString('zh-CN')}  B=${b.size}B/${new Date(b.mtime).toLocaleString('zh-CN')}`);
}
if (realDiff.length > 60) console.log(`    … 另有 ${realDiff.length - 60} 个`);
