#!/usr/bin/env node
/**
 * 把主目录（权威）的 data\ 同步到 UAT。
 *
 * 背景（乒乓构建规则）：两个绿目录各有自己的 data\，构建时原样保留。
 * 「数据以主目录为准」——主目录里改过的网关配置/设置/插件/历史要带到 UAT。
 *
 * 三类必须**排除**的东西（否则 UAT 会坏）：
 *   1) 路径绑定文件：内容里写死了各自绿目录的绝对路径（broker\launch-dsh.cmd、
 *      market\pnpm.cmd、market\bin\pnpm.cmd）——从主目录复制过去，UAT 会用
 *      主目录的 exe 和 node-global 启动，等于把 UAT 变成主目录的傀儡。
 *   2) logs\：各自运行日志（且启动基线按字节偏移算，混入对方日志会让看门狗误判）。
 *   3) node-global\：25k 文件 218MB 的 dsh 安装副本，两边本就同源，同步纯属浪费。
 *
 * 默认 dry-run，加 --apply 才真正写入。写入前对被覆盖的每个文件做 .bak 备份。
 *
 * 用法：
 *   node scripts/sync-data-to-uat.mjs                # 预演
 *   node scripts/sync-data-to-uat.mjs --apply        # 执行
 *   node scripts/sync-data-to-uat.mjs --apply --include-logs   # 连日志一起（一般不必要）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const INCLUDE_LOGS = args.includes('--include-logs');

const SRC = path.resolve(ROOT, 'out/DSH-App/data');
const DST = path.resolve(ROOT, 'out/DSH-App-UAT/data');

// 路径绑定文件（内容含各自绿目录绝对路径）——永不复制
const PATH_BOUND = new Set([
  'broker/launch-dsh.cmd',
  'market/pnpm.cmd',
  'market/bin/pnpm.cmd',
]);

// 各目录**自己的运行参数**——永不复制。
// settings.json 里含 `port`：实测 UAT 用 3081、主目录用 3080（用户有意区分），
// 整份同步会把 UAT 的端口静默改回 3080（下次启动 dsh web 就换了端口，界面 URL/书签全变），
// 而这不是"用户数据以主目录为准"的范畴——端口属于"这个实例怎么跑"。
const NEVER_SYNC = new Set(['settings.json']);

// 永不复制的前缀
// `gateway/` 是**派生的运行时副本**：data\gateway\model-gateway.mjs 每次应用启动都会由
// gateway-manager.ensureRuntimeExtracted 从 asar 重新解包覆盖；workbuddy-auth\ 是刷新出的令牌副本。
// 实测教训（2026-09-27）：把它一起同步后，UAT 的运行时副本被换成**主目录那份旧构建**的内容，
// 与 UAT 自己的 asar 不一致 —— 校验直接报不一致，且要等下次启动才自愈。
const EXCLUDE_PREFIX = ['node-global/', 'gateway/'];
if (!INCLUDE_LOGS) EXCLUDE_PREFIX.push('logs/');

if (!fs.existsSync(SRC)) { console.error('[FAIL] 源目录不存在: ' + SRC); process.exit(1); }
if (!fs.existsSync(DST)) { console.error('[FAIL] 目标目录不存在: ' + DST); process.exit(1); }

function walk(root) {
  const out = new Map();
  const stack = [['', root]];
  while (stack.length) {
    const [rel, abs] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (EXCLUDE_PREFIX.some((p) => r.startsWith(p))) continue;
      if (PATH_BOUND.has(r)) continue;
      if (NEVER_SYNC.has(r)) continue;
      const a = path.join(abs, e.name);
      if (e.isDirectory()) stack.push([r, a]);
      else if (e.isFile()) {
        let st; try { st = fs.statSync(a); } catch { continue; }
        out.set(r, { size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  return out;
}

const sha = (f) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; }
};

console.log(`源（权威）: ${SRC}`);
console.log(`目标      : ${DST}`);
console.log(`模式      : ${APPLY ? '**执行写入**' : '预演（dry-run，加 --apply 才写入）'}`);
console.log(`排除      : ${[...EXCLUDE_PREFIX, ...PATH_BOUND].join(', ')}`);
console.log('');

const A = walk(SRC);
const B = walk(DST);

const toCopy = [];   // 内容不同 → 覆盖
const toAdd = [];    // 目标没有 → 新增
for (const [rel, va] of A) {
  const vb = B.get(rel);
  if (!vb) { toAdd.push(rel); continue; }
  if (va.size !== vb.size) { toCopy.push(rel); continue; }
  if (Math.abs(va.mtime - vb.mtime) < 1500) continue;
  if (sha(path.join(SRC, rel)) !== sha(path.join(DST, rel))) toCopy.push(rel);
}

console.log(`扫描：源 ${A.size} 个文件 / 目标 ${B.size} 个文件`);
console.log(`需覆盖: ${toCopy.length} 个`);
for (const r of toCopy) console.log(`    ~ ${r}`);
console.log(`需新增: ${toAdd.length} 个`);
for (const r of toAdd) console.log(`    + ${r}`);

// 目标独有的文件：不删（保守），只报告
const onlyB = [...B.keys()].filter((r) => !A.has(r));
console.log(`目标独有（保留不动）: ${onlyB.length} 个`);
for (const r of onlyB.slice(0, 20)) console.log(`    - ${r}`);
if (onlyB.length > 20) console.log(`    … 另有 ${onlyB.length - 20} 个`);
console.log('');

if (!APPLY) {
  console.log('[预演结束] 未写入任何文件。确认无误后加 --apply 执行。');
  process.exit(0);
}

// 备份目录（含时间戳），被覆盖的旧文件先备份
// 时间戳：去掉尾部的点号——`toISOString()` 形如 2026-09-22T06:15:31.831Z，
// 去掉 -:T 后是 20260922061531.831Z，slice(0,15) 会**以点号结尾** → Windows 目录名
// 结尾的点会被规范化掉，导致"报备了备份路径、按该路径却列不出内容"（排查时极易误判成没备份）。
const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\./g, '').slice(0, 14);
const bakDir = path.join(ROOT, 'out', `_uat-data-bak-${stamp}`);
let copied = 0;
let backed = 0;
for (const rel of [...toCopy, ...toAdd]) {
  const s = path.join(SRC, rel);
  const d = path.join(DST, rel);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  if (fs.existsSync(d)) {
    const b = path.join(bakDir, rel);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.copyFileSync(d, b);
    backed++;
  }
  fs.copyFileSync(s, d);
  copied++;
}
console.log(`[完成] 已同步 ${copied} 个文件（其中备份旧文件 ${backed} 个 → ${bakDir}）`);

// 校验
let bad = 0;
for (const rel of [...toCopy, ...toAdd]) {
  if (sha(path.join(SRC, rel)) !== sha(path.join(DST, rel))) { console.log(`  [校验失败] ${rel}`); bad++; }
}
console.log(bad ? `[FAIL] ${bad} 个文件校验不一致` : '[OK] 同步后逐文件哈希一致');
process.exit(bad ? 1 : 0);
