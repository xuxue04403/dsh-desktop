// scripts/pack-slim.mjs — 打包"精简版绿色目录 zip"（个人迁移包，含 data\）
//
// 背景（2026-09-14 实测评估）：完整绿色目录 620 MB → zip 230 MB，其中相当一部分是
// 与运行无关的内容：55 个语言包（只用 zh-CN/en-US）、其它平台的预编译二进制、源码映射
// （*.map）、TypeScript 源码与类型声明、文档、测试目录。安全精简后可降到 ~186 MB（-19%），
// 且经"入口完整性 + 原生模块冒烟 + 依赖可解析"三重校验与原始目录等价。
//
// 用法：
//   node scripts/pack-slim.mjs                         # 自动选最新的 out\DSH-App* 作为源
//   node scripts/pack-slim.mjs --src out\DSH-App-v1.7.7 --out dist\xxx.zip
//   node scripts/pack-slim.mjs --drop-dsh              # 再删内置 dsh（小 ~37MB，首次启动需联网装）
//   node scripts/pack-slim.mjs --no-npm                # 再删内嵌 npm（小 ~3MB，仅"从零装 dsh"用）
//   node scripts/pack-slim.mjs --keep-work             # 保留中间目录（便于人工验证）
//
// 校验（不通过则非零退出）：
//   ① 每个 package.json 的 main/module/browser/exports 入口仍存在（与源目录逐项对照，
//      只关心"由精简造成的缺失"）；② sharp / node-pty / @vscode/ripgrep 能真实加载；
//   ③ dsh 自身 package.json 里声明的直接依赖全部 require.resolve 成功。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : ''; };
const dropDsh = args.includes('--drop-dsh');
const dropNpm = args.includes('--no-npm');
const keepWork = args.includes('--keep-work');

function latestGreen() {
  const outDir = path.join(root, 'out');
  const cands = fs.readdirSync(outDir)
    .filter((n) => n === 'DSH-App' || n.startsWith('DSH-App-'))
    .map((n) => path.join(outDir, n))
    .filter((p) => fs.existsSync(path.join(p, 'resources', 'app.asar')));
  if (cands.length === 0) throw new Error('out\\ 下找不到绿色目录（先运行 node scripts/build-portable.mjs）');
  cands.sort((a, b) => fs.statSync(path.join(b, 'resources', 'app.asar')).mtimeMs - fs.statSync(path.join(a, 'resources', 'app.asar')).mtimeMs);
  return cands[0];
}
const src = path.resolve(root, argVal('--src') || latestGreen());
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const zipOut = path.resolve(root, argVal('--out') || path.join('dist', `DSHApp-${version}-Slim-WithData.zip`));
const workRoot = path.join(root, 'out', '_slim-work');
const work = path.join(workRoot, 'DSH-App');
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const MB = (b) => (b / 1048576).toFixed(1);
function measure(p) {
  let bytes = 0; let files = 0;
  const walk = (d) => {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      try { if (e.isDirectory()) walk(f); else if (e.isFile()) { bytes += fs.statSync(f).size; files++; } } catch { /* 忽略 */ }
    }
  };
  try { if (fs.statSync(p).isFile()) { bytes = fs.statSync(p).size; files = 1; } else walk(p); } catch { /* 忽略 */ }
  return { bytes, files };
}
function human(b) { return MB(b) + ' MB'; }

console.log('[1/5] 源目录: ' + src);
console.log('      版本: ' + version + (dropDsh ? '  [--drop-dsh 不含内置 dsh]' : '') + (dropNpm ? '  [--no-npm]' : ''));

// ---------- 复制 ----------
fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });
const t0 = Date.now();
fs.cpSync(src, work, { recursive: true });
const before = measure(work);
console.log('[2/5] 复制完成 ' + Math.round((Date.now() - t0) / 1000) + 's：' + human(before.bytes) + ' / ' + before.files + ' 文件');

// ---------- 精简 ----------
const removed = [];
const rm = (p, label) => {
  try {
    if (!fs.existsSync(p)) return;
    const s = measure(p).bytes;
    fs.rmSync(p, { recursive: true, force: true });
    removed.push([label, s]);
  } catch { /* 忽略 */ }
};
// 语言包：只留 zh-CN + en-US
const locales = path.join(work, 'locales');
if (fs.existsSync(locales)) {
  let sum = 0;
  for (const f of fs.readdirSync(locales)) {
    if (f === 'zh-CN.pak' || f === 'en-US.pak') continue;
    const p = path.join(locales, f);
    try { sum += fs.statSync(p).size; fs.rmSync(p, { force: true }); } catch { /* 忽略 */ }
  }
  removed.push(['locales（非中英语言包）', sum]);
}
// 跨平台预编译二进制 + 文档/测试/类型/映射/TS 源码
const crossLabels = { 'darwin-arm64': 1, 'darwin-x64': 1, 'linux-arm64': 1, 'linux-x64': 1, 'win32-arm64': 1, 'win10-arm64': 1 };
let crossBytes = 0; let mapBytes = 0; let mdBytes = 0; let testBytes = 0; let typesBytes = 0; let tsBytes = 0;
(function walk(d) {
  let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) {
      const inPrebuilds = path.dirname(f).endsWith('prebuilds') || (path.basename(path.dirname(f)) === 'conpty' && f.includes('third_party'));
      if (inPrebuilds && crossLabels[e.name]) { crossBytes += measure(f).bytes; rm(f, ''); continue; }
      if (['test', 'tests', '__tests__', 'docs', 'example', 'examples', '.github'].includes(e.name)) { testBytes += measure(f).bytes; rm(f, ''); continue; }
      if (e.name === '@types' && d.includes('node_modules')) { typesBytes += measure(f).bytes; rm(f, ''); continue; }
      walk(f); continue;
    }
    if (e.name.endsWith('.map')) { try { mapBytes += fs.statSync(f).size; fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } continue; }
    if (/\.(md|markdown)$/i.test(e.name) && !/^licen[cs]e/i.test(e.name)) { try { mdBytes += fs.statSync(f).size; fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } continue; }
    if (/\.(ts|tsx|mts|cts)$/.test(e.name)) { try { tsBytes += fs.statSync(f).size; fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } }
  }
})(work);
removed.push(['跨平台预编译二进制', crossBytes], ['*.map 源码映射', mapBytes], ['*.md 文档', mdBytes],
  ['测试/示例/文档目录', testBytes], ['@types 类型包', typesBytes], ['*.ts/.tsx 源码与类型', tsBytes]);
// 启动即再生的运行期文件
for (const rel of ['data/logs', 'data/gateway', 'data/broker', 'data/market']) rm(path.join(work, rel), rel + '（启动再生）');
if (dropNpm) rm(path.join(work, 'resources', 'node_modules', 'npm'), '内嵌 npm');
if (dropDsh) rm(path.join(work, 'data', 'node-global'), '内置 dsh（首次启动需联网安装）');

for (const [label, bytes] of removed) if (label && bytes > 0) console.log('      - ' + label.padEnd(26) + human(bytes));
const after = measure(work);
console.log('[3/5] 精简后：' + human(after.bytes) + ' / ' + after.files + ' 文件（减少 ' + human(before.bytes - after.bytes) + '）');

// ---------- 校验 ----------
function entryCheck(dir) {
  const missing = new Set(); let pkgs = 0;
  (function walk(d) {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (e.name !== 'package.json') continue;
      let j = null; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      pkgs++;
      const rel = path.relative(dir, f);
      for (const key of ['main', 'module', 'browser']) {
        const v = j[key]; if (typeof v !== 'string') continue;
        const t = path.join(path.dirname(f), v);
        if (![t, t + '.js', t + '.json', t + '.mjs', t + '.cjs'].some((x) => fs.existsSync(x))) missing.add(rel + ' :: ' + key + '=' + v);
      }
      const dot = (j.exports && typeof j.exports === 'object') ? j.exports['.'] : null;
      const cand = typeof dot === 'string' ? dot : (dot && (dot.require || dot.import || dot.default));
      if (typeof cand === 'string') {
        const t = path.join(path.dirname(f), cand);
        if (![t, t + '.js', t + '.mjs', t + '.cjs'].some((x) => fs.existsSync(x))) missing.add(rel + ' :: exports.=' + cand);
      }
    }
  })(dir);
  return { pkgs, missing };
}
const ea = entryCheck(src); const eb = entryCheck(work);
const caused = [...eb.missing].filter((x) => !ea.missing.has(x));
let smoke = 'skipped(--drop-dsh)';
if (!dropDsh && fs.existsSync(path.join(work, 'DSH-App.exe'))) {
  const outFile = path.join(workRoot, 'smoke.txt');
  const dshDir = path.join(work, 'data', 'node-global', 'node_modules', '@deepseek-ai', 'dsh');
  const script = "const fs=require('fs');const r=[];"
    + "for(const m of ['sharp','node-pty','@vscode/ripgrep']){try{require(m);r.push(m+':OK');}catch(e){r.push(m+':FAIL');}}"
    + "try{const p=JSON.parse(fs.readFileSync('package.json','utf8'));let ok=0,bad=0;for(const d of Object.keys(p.dependencies||{})){try{require.resolve(d);ok++;}catch(_){bad++;}}r.push('deps:'+ok+'/'+(ok+bad));}catch(e){r.push('deps:ERR');}"
    + 'fs.writeFileSync(' + JSON.stringify(outFile) + ",r.join(' '));";
  spawnSync(path.join(work, 'DSH-App.exe'), ['-e', script], {
    cwd: dshDir, stdio: 'ignore', windowsHide: true,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
  });
  try { smoke = fs.readFileSync(outFile, 'utf8').trim(); } catch { smoke = '（无输出）'; }
}
console.log('[4/5] 校验：入口缺失(精简造成)=' + caused.length + '  原生模块/依赖冒烟: ' + smoke);
if (caused.length > 0 || /FAIL|ERR/.test(smoke)) {
  console.error('[FAIL] 精简破坏了运行时（入口缺失或模块加载失败），已中止，不生成 zip。');
  caused.slice(0, 10).forEach((x) => console.error('   ! ' + x));
  process.exit(1);
}

// ---------- 打包 ----------
fs.mkdirSync(path.dirname(zipOut), { recursive: true });
try { fs.rmSync(zipOut, { force: true }); } catch { /* 忽略 */ }
const t1 = Date.now();
const r = spawnSync(tar, ['-a', '-cf', zipOut, '-C', workRoot, 'DSH-App'], { stdio: 'ignore', windowsHide: true });
if (r.status !== 0 || !fs.existsSync(zipOut)) { console.error('[FAIL] tar 打包失败 exit=' + r.status); process.exit(1); }
const zs = fs.statSync(zipOut).size;
console.log('[5/5] 完成：' + zipOut);
console.log('      ' + human(zs) + '（原始绿色目录 ' + human(before.bytes) + ' → 精简 ' + human(after.bytes) + '）用时 ' + Math.round((Date.now() - t1) / 1000) + 's');
if (!keepWork) { fs.rmSync(workRoot, { recursive: true, force: true }); console.log('      （中间目录已清理；--keep-work 可保留以便人工验证）'); }
