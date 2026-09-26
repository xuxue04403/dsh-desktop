// scripts/check-plugin-opencode-go-list.mjs — 重启后一条命令核对 dsh-opencode-go-model-list 是否真的生效
// 用法：node scripts/check-plugin-opencode-go-list.mjs [--log <dsh web 日志路径>]
// 判据（三者都通过才算生效）：
//   ① profile 侧：node_modules 有包 + package.json 的 dsh.profile.bundles 登记了它
//   ② 运行日志：出现 [opencode-go-model-list] mounted / contributed 行
//   ③ 缓存：$DSH_HOME/cache/opencode-go-model-list/catalog.json 存在（插件首次成功抓取后写）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = path.join(HOME, 'profiles', 'web');
const PKG = 'dsh-opencode-go-model-list';
const argv = process.argv.slice(2);
const logArg = argv.indexOf('--log');
const LOGS = logArg >= 0 && argv[logArg + 1]
  ? [argv[logArg + 1]]
  : ['out/DSH-App/data/logs/web.log', 'out/DSH-App-UAT/data/logs/web.log'].map((p) => path.resolve(p));

const ok = (b) => (b ? '✓' : '✗');
let pass = 0, total = 0;
const check = (label, cond, extra = '') => { total++; if (cond) pass++; console.log(`  ${ok(cond)} ${label}${extra ? '  ' + extra : ''}`); };

console.log('== ① profile 侧 ==');
const pkgDir = path.join(PROFILE, 'node_modules', PKG);
check('node_modules 里有插件', fs.existsSync(pkgDir), pkgDir);
if (fs.existsSync(pkgDir)) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
    console.log(`     版本 ${v}`);
  } catch { /* 忽略 */ }
}
let bundles = [];
try {
  const prof = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
  bundles = prof?.dsh?.profile?.bundles || [];
} catch { /* 忽略 */ }
check('已登记进 dsh.profile.bundles', bundles.includes(PKG), `bundles=[${bundles.join(', ')}]`);

console.log('\n== ② 运行日志 ==');
let mounted = false, contributedLine = '';
for (const f of LOGS) {
  if (!fs.existsSync(f)) { console.log(`  - ${f}（不存在）`); continue; }
  const txt = fs.readFileSync(f, 'utf8');
  const lines = txt.split('\n').filter((l) => l.includes('opencode-go'));
  const m = lines.filter((l) => /mounted|contributed|resolved against/.test(l));
  console.log(`  ${ok(m.length > 0)} ${f}  命中 ${lines.length} 行（关键 ${m.length} 行）`);
  m.slice(-4).forEach((l) => console.log('       ' + l.trim().slice(0, 170)));
  if (m.some((l) => /mounted/.test(l))) mounted = true;
  const c = m.find((l) => /contributed/.test(l));
  if (c) contributedLine = c.trim();
}
check('日志出现插件挂载行', mounted);

console.log('\n== ③ 缓存 ==');
// 缓存路径：优先取插件自己在挂载行里打印的 cache=（权威），否则退回默认约定
let cacheFile = '';
for (const f of LOGS) {
  if (!fs.existsSync(f)) continue;
  const m = /cache=([^\s)]+)/.exec(fs.readFileSync(f, 'utf8'));
  if (m) { cacheFile = m[1]; break; }
}
if (!cacheFile) cacheFile = path.join(HOME, 'cache', PKG, 'catalog.json');
const hasCache = fs.existsSync(cacheFile);
check('catalog.json 缓存已生成', hasCache, hasCache ? cacheFile : cacheFile + '（首次成功抓取后才会出现）');
if (hasCache) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const n = Array.isArray(j) ? j.length : (j.models ? Object.keys(j.models).length : Object.keys(j).length);
    console.log(`     缓存条目数: ${n}`);
  } catch { /* 忽略 */ }
}

console.log('\n== 结论 ==');
console.log(pass === total ? `  ✅ 全部通过（${pass}/${total}）：插件已生效，模型选择器里应能看到 opencode-go 的 38 个模型`
  : `  ⚠️ ${pass}/${total} 通过${contributedLine ? '' : '：若"日志出现插件挂载行"未通过 → dsh 还没重启，或重启早于插件安装'}`);
if (contributedLine) console.log('  贡献行: ' + contributedLine.slice(0, 170));
process.exit(pass === total ? 0 : 1);
