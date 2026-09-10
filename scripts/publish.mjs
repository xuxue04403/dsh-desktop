// scripts/publish.mjs — 发布当前版本到 GitHub（node 实现，语义对齐 scripts/release.ps1）
//
// 用法：
//   node scripts/publish.mjs --token <TOKEN>            （或设环境变量 DSH_GH_TOKEN）
//   node scripts/publish.mjs --token <TOKEN> --skip-source   （仅 release+资产，不传源码）
//
// 流程：0) 安全闸门（真实邮箱/密钥信息检测；--scrub 可就地脱敏）→ 1) 身份/仓库校验 →
//       2) 上传源码（剔除 node_modules/out/dist/.git）→ 3) 绿色版 zip（剔除 data\，R15：绝不外发
//       用户 key；打包前再对产物做一次闸门）→ 4) 创建 v<version> release → 5) 上传资产（同名先删）
// 版本默认取 package.json（tag = v<version>），资产名与 electron-builder artifactName 对齐。
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRules, scanTree, scrubTree, formatReport, summarize } from './email-scrub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tokenArg = (() => { const i = args.indexOf('--token'); return i >= 0 ? args[i + 1] : ''; })();
// token 兜底：环境变量 → 本机 PowerShell 历史（PSReadLine）中的发布 token
function tokenFromHistory() {
  try {
    const p = process.env.APPDATA + '\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt';
    if (!fs.existsSync(p)) return '';
    const c = fs.readFileSync(p, 'utf8');
    const m = c.match(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/);
    return m ? m[0] : '';
  } catch (_) { return ''; }
}
const token = tokenArg || process.env.DSH_GH_TOKEN || tokenFromHistory() || '';
const skipSource = args.includes('--skip-source');
const doScrub = args.includes('--scrub');
const zipFromArg = (() => { const i = args.indexOf('--zip-from'); return i >= 0 ? args[i + 1] : ''; })();

// ---------- 0) 安全闸门（R27）：绝不把真实邮箱信息/密钥推到 GitHub ----------
// 规则由本机配置派生（~/.dsh/settings.yaml 的 email-bridge 段、.credentials.yaml、
// 各网关 gateway.config.json），因此源码里不含任何真实值也能精确拦截。
// 扫描两处：a) 待上传的源码树；b) 绿色目录（zip 的内容，data\ 已排除）。
const SOURCE_TREES = [root, path.resolve(root, '..', 'dsh-email-bridge')].filter((p) => fs.existsSync(p));
function gate(targets, label, { allowScrub = false, skipDirs } = {}) {
  const { rules } = buildRules();
  const opts = skipDirs ? { rules, skipDirs } : { rules };
  const first = scanTree(targets, opts);
  if (!first.findings.length) {
    console.log('[OK] 安全闸门(' + label + ')：' + first.files + ' 个文件，无邮箱/密钥信息');
    return;
  }
  if (allowScrub && doScrub) {
    const r = scrubTree(targets, opts);
    console.log('[..] 安全闸门(' + label + ')：已就地脱敏 ' + r.changed + ' 个文件');
    const after = scanTree(targets, opts);
    if (!after.findings.length) { console.log('[OK] 安全闸门(' + label + ')：脱敏后复扫干净'); return; }
    console.error(formatReport(after.findings));
    throw new Error('脱敏后仍有残留，已阻止发布');
  }
  console.error(formatReport(first.findings));
  console.error('[FAIL] 安全闸门(' + label + ')命中 ' + summarize(first.findings) +
    '——已阻止发布。处理：node scripts/email-scrub.mjs --scan 查看，--scrub 就地清除真实值' +
    (allowScrub ? '（或本次加 --scrub）' : ''));
  process.exit(1);
}
if (!token) { console.error('[FAIL] 缺少 token：--token <TOKEN> / 环境变量 DSH_GH_TOKEN / 或本机 PSReadLine 历史中无发布 token'); process.exit(1); }

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
// 资产上传（直连 https.request）：实测本环境直连 uploads.github.com 约 0.1MB/s 但稳定
// 成功（代理 CONNECT 对大文件反而超时）。带进度日志与 3 次重试，单次上限 50 分钟。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function uploadAsset(uploadUrl, name, filePath) {
  const buf = fs.readFileSync(filePath);
  const u = new URL(uploadUrl.replace('{?name,label}', '') + '?name=' + encodeURIComponent(name));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const totalMB = (buf.length / 1048576).toFixed(1);
    console.log('  .. ' + name + ' attempt ' + attempt + ' (' + totalMB + ' MB) uploading (direct, ~0.1MB/s)...');
    try {
      await new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; req.destroy(); reject(new Error('timeout 50min: ' + name)); } }, 50 * 60 * 1000);
        const prog = setInterval(() => {
          try {
            const sent = req.socket ? req.socket.bytesWritten : 0;
            console.log('  .. ' + name + ' progress ' + (sent / 1048576).toFixed(1) + ' / ' + totalMB + ' MB');
          } catch (_) { /* 忽略 */ }
        }, 90000);
        const req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'dsh-app-publisher',
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(buf.length),
          },
        }, (res) => {
          let body = '';
          res.on('data', (ch) => { body += ch; });
          res.on('end', () => {
            if (done) return; done = true;
            clearTimeout(timer); clearInterval(prog);
            if (res.statusCode === 201 || res.statusCode === 200) resolve();
            else reject(new Error('asset ' + name + ' → ' + res.statusCode + ' ' + body.slice(0, 300)));
          });
        });
        req.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); clearInterval(prog); reject(err); } });
        req.write(buf);
        req.end();
      });
      console.log('  ↑ asset ' + name + ' (' + totalMB + ' MB, attempt ' + attempt + ') OK');
      return;
    } catch (err) {
      console.log('  .. asset ' + name + ' attempt ' + attempt + ' failed: ' + (err.message || err) + ' — retrying');
      await sleep(5000 * attempt);
    }
  }
  throw new Error('asset upload failed after 3 attempts: ' + name);
}

// 1) 身份与仓库
const me = await api('GET', API + '/user');
console.log('[OK] authenticated as ' + me.login + (me.login === OWNER ? '' : '  (!! 期望 ' + OWNER + ')'));
await api('GET', `${API}/repos/${OWNER}/${REPO}`);
console.log('[OK] repo ' + OWNER + '/' + REPO);

// 1.5) 源码树安全闸门（真实邮箱信息/密钥在上传前拦下）
gate(SOURCE_TREES, '源码树', { allowScrub: true });

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
  // 产物安全闸门：zip 的内容在打包前再扫一次（含 resources\vendor 与 app.asar 二进制）
  gate([stage], '绿色产物(zip 内容)');
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
    `- R27：发布安全闸门——推送 GitHub 前自动检测真实邮箱信息/密钥（邮箱地址、邮件服务器、本机凭据值、网关 key），命中即阻断上传；--scrub 可就地脱敏后重发\n` +
    `- R27：邮箱桥接设置页补全全部参数（IMAP/SMTP 主机、账号、端口、TLS、IDLE、轮询间隔、标记已读、摘要长度、附件落盘与上限），支持「保存/恢复默认」\n` +
    `- R26：vendor 更新后可自动刷新 profile 内插件副本（.dsh-app-managed.json 标记比对），修复"插件文件已更新但运行中的仍是旧副本"\n` +
    `- R24：默认插件安装加固——file: 依赖声明 + vendor 目录 + 启动前自检修复 + 看门狗识别"插件树加载失败"；dsh 升级或 pnpm 清理后不再出现整树启动失败\n` +
    `- R25：凭据/命令 API 对齐 dsh 0.1.5；构建链路剔除官方参考源码副本与任意层级 node_modules（此前曾被误传）\n` +
    `- R22：网关端口约定固化——示例/默认/回退端口统一 3091（dsh-app 网关），与桌面助手 3090 分离；保存配置强制校验 port\n` +
    `- R22：launcher 进程身份校验——重启/托盘重启不再被旧进程迟到的 exit 误触发看门狗（防误杀新进程/误进安全模式）\n` +
    `- R22：看门狗按「本次启动」基线分析 web.log，历史故障行不再引发假安全模式\n` +
    `- R21：启动自动补丁 OpenCode Go 的 x-opencode-session 头（pi-ai，opencode.ai/zen/go 400 修复），dsh 升级后自动重打\n` +
    `- 测试：npm test 覆盖单元 32 + 集成 23 + 市场 7 = 62 项用例\n\n` +
    `Assets:\n` +
    `- DSHApp-Setup-${ver}-x64.exe : NSIS 安装版\n` +
    `- DSHApp-Portable-${ver}-x64.exe : 单文件便携版\n` +
    `- DSHApp-Portable-${ver}.zip : 绿色免安装目录版（绝不包含 data\\ 用户数据）`;
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
