// scripts/publish.mjs — 发布当前版本到 GitHub（node 实现，语义对齐 scripts/release.ps1）
//
// 用法：
//   node scripts/publish.mjs --token <TOKEN>            （或设环境变量 DSH_GH_TOKEN）
//   node scripts/publish.mjs --token <TOKEN> --skip-source   （仅 release+资产，不传源码）
//
// 流程：1) 身份/仓库校验 → 2) 上传源码（剔除 node_modules/out/dist/.git）→
//       3) 绿色版 zip（剔除 data\，R15：绝不外发用户 key）→ 4) 创建 v<version> release →
//       5) 上传资产（Setup / Portable-exe / zip，同名先删）
// 版本默认取 package.json（tag = v<version>），资产名与 electron-builder artifactName 对齐。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tokenArg = (() => { const i = args.indexOf('--token'); return i >= 0 ? args[i + 1] : ''; })();
const token = tokenArg || process.env.DSH_GH_TOKEN || '';
const skipSource = args.includes('--skip-source');
const zipFromArg = (() => { const i = args.indexOf('--zip-from'); return i >= 0 ? args[i + 1] : ''; })();
if (!token) { console.error('[FAIL] 缺少 token：--token <TOKEN> 或环境变量 DSH_GH_TOKEN'); process.exit(1); }

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ver = pkg.version;                    // 1.6.0
const tag = 'v' + ver;
const OWNER = 'xuxue04403';
const REPO = 'dsh-desktop';
const API = 'https://api.github.com';
const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dsh-app-publisher' };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(method + ' ' + url + ' → ' + res.status + ' ' + (j && j.message ? j.message : text.slice(0, 300)));
  return j;
}
async function uploadAsset(uploadUrl, name, filePath) {
  const buf = fs.readFileSync(filePath);
  const u = uploadUrl.replace('{?name,label}', '') + '?name=' + encodeURIComponent(name);
  const res = await fetch(u, { method: 'POST', headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) }, body: new Uint8Array(buf) });
  const text = await res.text();
  if (!res.ok) throw new Error('asset ' + name + ' → ' + res.status + ' ' + text.slice(0, 300));
  console.log('  ↑ asset ' + name + ' (' + (buf.length / 1048576).toFixed(1) + ' MB)');
  return JSON.parse(text);
}

// 1) 身份与仓库
const me = await api('GET', API + '/user');
console.log('[OK] authenticated as ' + me.login + (me.login === OWNER ? '' : '  (!! 期望 ' + OWNER + ')'));
await api('GET', `${API}/repos/${OWNER}/${REPO}`);
console.log('[OK] repo ' + OWNER + '/' + REPO);

// 2) 绿色版 zip（剔除 data\）
const zipPath = path.join(root, 'dist', `DSHApp-${ver}-Portable.zip`);
{
  const stage = path.join(root, 'out', '_zip-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  // 绿色目录默认 out\DSH-App（运行中文件也可读）；--zip-from 可指向无运行锁的目录
  // （如 out\DSH-App-UAT：与 dev 逐字节一致且无 data\，打包最干净）
  const green = zipFromArg || path.join(root, 'out', 'DSH-App');
  if (!fs.existsSync(path.join(green, 'DSH-App.exe'))) throw new Error('绿色目录缺少 DSH-App.exe：先运行 node scripts/build-portable.mjs');
  const skipDir = new Set(['data']);
  const copy = (s, d) => {
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (e.isDirectory() && skipDir.has(e.name)) continue;      // R15：绝不打包用户数据
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) { fs.mkdirSync(dp, { recursive: true }); copy(sp, dp); }
      else { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(sp, dp); }
    }
  };
  copy(green, stage);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  const r = spawnSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', zipPath, '-C', stage, '.'], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('tar zip failed status=' + r.status);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log('[OK] zip → ' + zipPath + ' (' + (fs.statSync(zipPath).size / 1048576).toFixed(1) + ' MB, data 已剔除)');
}

// 3) 上传源码（与 release.ps1 相同的剔除规则）
if (!skipSource) {
  let count = 0;
  const walk = async (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'out' || e.name === 'dist' || e.name === '.git') continue;
      if (e.name === 'anywhere-lab-sdsh-desktop') continue;   // 官方参考源码副本，不属于本项目仓库
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(abs); continue; }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (/^tests\/.*\.tmp/.test(rel)) continue;
      const buf = fs.readFileSync(abs);
      if (buf.length > 95 * 1048576) { console.log('  !! skip(>95MB) ' + rel); continue; }
      const b64 = buf.toString('base64');
      const uri = `${API}/repos/${OWNER}/${REPO}/contents/${rel}`;
      let sha = null;
      try { sha = (await api('GET', uri)).sha; } catch { /* 新文件 */ }
      await api('PUT', uri, { message: sha ? 'chore: update ' + rel : 'feat: add ' + rel, content: b64, sha: sha || undefined });
      count++;
      if (count % 10 === 0) console.log('  .. ' + count + ' files');
    }
  };
  await walk(root);
  console.log('[OK] uploaded ' + count + ' source file(s)');
}

// 4) 创建/复用 release
let rel = null;
try { rel = await api('GET', `${API}/repos/${OWNER}/${REPO}/releases/tags/${tag}`); } catch { /* 不存在 */ }
if (!rel) {
  const body =
    `DSH App ${tag}（自研 Electron 薄壳：进程外托管 dsh web + 看门狗安全模式 + 模型网关 + 输入历史）\n\n` +
    `What's new in ${tag}:\n` +
    `- R22：网关端口约定固化——示例/默认/回退端口统一 3091（dsh-app 网关），与桌面助手 3090 分离；保存配置强制校验 port\n` +
    `- R22：launcher 进程身份校验——重启/托盘重启不再被旧进程迟到的 exit 误触发看门狗（防误杀新进程/误进安全模式）\n` +
    `- R22：看门狗按「本次启动」基线分析 web.log，历史故障行不再引发假安全模式\n` +
    `- R21：启动自动补丁 OpenCode Go 的 x-opencode-session 头（pi-ai，opencode.ai/zen/go 400 修复），dsh 升级后自动重打\n` +
    `- R22：主窗口关闭后托盘/二次启动可重新打开（minimizeToTray=false 场景）；未捕获异常/Promise 拒绝兜底记录\n` +
    `- npm test 纳入 tests/market.test.js（47 项用例全绿）\n\n` +
    `Assets:\n` +
    `- DSHApp-Setup-${ver}-x64.exe : NSIS 安装版\n` +
    `- DSHApp-Portable-${ver}-x64.exe : 单文件便携版\n` +
    `- DSHApp-Portable-${ver}.zip : 绿色免安装目录版`;
  rel = await api('POST', `${API}/repos/${OWNER}/${REPO}/releases`, { tag_name: tag, name: tag, body });
  console.log('[OK] release created: ' + tag);
} else {
  console.log('[..] release ' + tag + ' already exists, reuse');
}

// 5) 上传资产（同名先删）
const uploadUrl = rel.upload_url;
const want = [
  ['DSHApp-Setup-' + ver + '-x64.exe', path.join(root, 'dist', 'DSHApp-' + ver + '-x64.exe')],
  ['DSHApp-Portable-' + ver + '-x64.exe', path.join(root, 'dist', 'DSHApp-' + ver + '-便携版.exe')],
  ['DSHApp-Portable-' + ver + '.zip', zipPath],
];
const existing = rel.assets || [];
for (const [name, file] of want) {
  if (!fs.existsSync(file)) { console.log('[WARN] 资产缺失: ' + file); continue; }
  const old = existing.find((a) => a.name === name);
  if (old) await api('DELETE', `${API}/repos/${OWNER}/${REPO}/releases/assets/${old.id}`);
  await uploadAsset(uploadUrl, name, file);
}

console.log('[DONE] ' + tag + ' published → https://github.com/' + OWNER + '/' + REPO + '/releases/tag/' + tag);
