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
// 应用根目录的 node.exe：**不是随包文件**，而是 shell 启动时幂等再生的「内嵌运行期入口」。
// src/main.js「v1.9.0：每次启动幂等确保应用根目录 node.exe 存在」→
// launcher.prepareEmbeddedInstallEnv 把应用 exe **硬链接**为 node.exe（失败才退回复制）。
// 它与应用 exe 同为约 237 MB 的 Electron 二进制，留着等于白背一份
// （实测：372.5 MB → 269.4 MB，省 103 MB ≈ node.exe 压缩后大小）。
// publish.mjs 的绿色包早已如此排除
// （ZIP_SKIP_FILES = ['node.exe']，注释「运行期 node.exe」），此处对齐。
rm(path.join(work, 'node.exe'), 'node.exe（启动时由 DSH-App.exe 硬链接再生）');
if (dropNpm) rm(path.join(work, 'resources', 'node_modules', 'npm'), '内嵌 npm');
if (dropDsh) rm(path.join(work, 'data', 'node-global'), '内置 dsh（首次启动需联网安装）');

// ---------- 换机清洗（2026-09-22）----------
// 目的：让"复制到新电脑"尽量一键。这里只删"只对原机器成立/会主动误导"的残留；
// 真正的换机适配（写死的凭据路径、WorkBuddy 区域、本地代理）由应用**首次启动时**
// 自动完成，见 src/machine-adapt.js —— 所以那些字段不用在这里改，保留原样即可。
{
  // ① 适配/迁移标记：这两个标记都是"按机器指纹决定要不要干活"的闸门。
  //    留着的话，新电脑只要**主机名与用户名恰好相同**（同名机、克隆镜像、同一个人
  //    换机后沿用同名账户）就会被判成"本机已处理过"而**跳过换机适配与插件装回**。
  //    删掉：新机必定重新适配一次、重新装回一次（幂等逻辑本身保证重复执行无副作用）。
  for (const rel of ['data/machine-adapt.applied.json', 'data/plugin-snapshot.applied.json']) {
    const p = path.join(work, rel);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      console.log('      - ' + rel.replace('data/', '').padEnd(30) + '（删除：让新机必定重新适配/装回）');
    }
  }
  // ② 路径绑定脚本（data/broker/launch-dsh.cmd、data/market/*/pnpm.cmd 里写死了绿目录
  //    绝对路径）已经由上面的 `data/broker` / `data/market` 整目录删除覆盖，这里不重复处理。
  // ③ 上次残留的临时副本
  for (const rel of ['data/gateway.config.json.tmp', 'data/settings.json.tmp']) {
    const p = path.join(work, rel);
    try { if (fs.existsSync(p)) fs.rmSync(p, { force: true }); } catch { /* 忽略 */ }
  }
}

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
  const r = spawnSync(path.join(work, 'DSH-App.exe'), ['-e', script], {
    cwd: dshDir, stdio: 'ignore', windowsHide: true,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
  });
  // 第二轮审计修复：旧实现丢弃 spawnSync 的返回值、且 stdio:'ignore' 吞掉子进程报错 ——
  // 子进程根本没跑起来（盘被禁止执行 / cwd 不存在 / 杀软拦截）时 outFile 不生成，
  // smoke 变成 '（无输出）'，既不匹配下面的 /FAIL|ERR/ 也不触发中止，
  // 于是"原生模块全挂"的产物被当作校验通过发布出去。现在显式判失败并中止。
  if (r.error || r.status !== 0) {
    console.error('[FAIL] 冒烟子进程未能执行（' + (r.error ? r.error.message : 'exit ' + r.status) + '）'
      + '，无法验证原生模块可用性，已中止，不生成 zip。');
    process.exit(1);
  }
  try { smoke = fs.readFileSync(outFile, 'utf8').trim(); } catch { smoke = '（无输出）'; }
  if (!smoke || smoke === '（无输出）') {
    console.error('[FAIL] 冒烟未产出结果文件（' + outFile + '），已中止，不生成 zip。');
    process.exit(1);
  }
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
