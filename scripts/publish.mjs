// scripts/publish.mjs — 发布当前版本到 GitHub（node 实现，语义对齐 scripts/release.ps1）
//
// 用法：
//   node scripts/publish.mjs --token <TOKEN>            （或设环境变量 DSH_GH_TOKEN）
//   node scripts/publish.mjs --token <TOKEN> --skip-source   （仅 release+资产，不传源码）
//   node scripts/publish.mjs --token <TOKEN> --skip-assets   （仅同步源码与 release）
//   node scripts/publish.mjs --notes "<本版说明>" | --notes-file <path>
//
// 流程：0) 安全闸门（真实邮箱/密钥信息检测；--scrub 可就地脱敏并写 *.bak-scrub 备份）→
//       1) 身份/仓库校验 → 2) 绿色版 zip（剔除 data\/logs\/node.exe/*.log/*.tmp，
//          R15：绝不外发用户 key；打包后校验 zip 结构完整）→ 3) 上传源码
//          （剔除 node_modules/out/dist/.git；GET sha 区分 404 与限流/权限，PUT 重试 2 次，
//          结束时打印失败清单并非零退出）→ 4) 创建/复用 v<version> release
//          （正文按版本生成，见 dshApp.releaseNotes / --notes）→ 5) 上传资产
//          （同名旧资产先**改名保留**，新资产上传成功后才删除，避免"两头落空"）→
//          6) 断言三类资产（安装版 exe / 便携版 exe / zip）在 release 上且大小与本地一致。
// 版本默认取 package.json（tag = v<version>），资产名与 electron-builder artifactName 对齐。
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRules, scanTree, scrubTree, formatReport, summarize, resolveTar, verifyZip } from './email-scrub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return '';
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const tokenArg = argValue('--token');
const skipSource = args.includes('--skip-source');
const skipAssets = args.includes('--skip-assets');   // 仅同步源码与 release（不重传数百 MB 资产）
const doScrub = args.includes('--scrub');
const zipFromArg = argValue('--zip-from');
const notesArg = argValue('--notes');
const notesFileArg = argValue('--notes-file');

// ---------- token 解析（审计修复 P3）----------
// 兜底顺序：--token → 环境变量 DSH_GH_TOKEN → 本机 PowerShell 历史（PSReadLine）。
// 保留历史自动读取（本机使用习惯依赖它），但必须醒目告警：该文件是**明文长期留存**的，
// 等于把发布 token 常驻磁盘；读取失败也要给出明确指引，而不是静默当作"没有 token"。
const HISTORY_PATH = String(process.env.APPDATA || '') + '\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt';
const TOKEN_HELP = 'token 获取/撤销：https://github.com/settings/tokens（classic 需 repo 权限）';
function tokenFromHistory() {
  try {
    if (!process.env.APPDATA) return { token: '', error: 'APPDATA 未设置，无法定位 PSReadLine 历史文件' };
    if (!fs.existsSync(HISTORY_PATH)) return { token: '', error: '历史文件不存在：' + HISTORY_PATH };
    const c = fs.readFileSync(HISTORY_PATH, 'utf8');
    const m = c.match(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/);
    return m ? { token: m[0], error: '' } : { token: '', error: '历史文件中未找到 gh*_/github_pat_ 形态的 token' };
  } catch (err) {
    return { token: '', error: '读取失败：' + (err && err.message ? err.message : err) };
  }
}
const haveExplicitToken = Boolean(tokenArg || process.env.DSH_GH_TOKEN);
const hist = haveExplicitToken ? { token: '', error: '' } : tokenFromHistory();
const token = tokenArg || process.env.DSH_GH_TOKEN || hist.token || '';
if (!token) {
  if (hist.error) {
    console.warn('[警告] 未能从 PSReadLine 历史自动读取 token：' + hist.error);
  }
  console.error('[FAIL] 缺少 token。请任选一种方式提供：');
  console.error('       1) node scripts/publish.mjs --token <TOKEN>');
  console.error('       2) 设环境变量 DSH_GH_TOKEN=<TOKEN>（推荐：可放 CI secret，用完即清）');
  console.error('       3) 本机 PSReadLine 历史中的发布 token（不推荐：明文长期留存于 '
    + HISTORY_PATH + '）');
  console.error('       ' + TOKEN_HELP);
  process.exit(1);
}
if (!haveExplicitToken && hist.token) {
  console.warn('============================================================');
  console.warn('[安全告警] 发布 token 取自 PSReadLine 历史文件（明文长期留存）：');
  console.warn('           ' + HISTORY_PATH);
  console.warn('           推荐改用 --token <TOKEN> 或环境变量 DSH_GH_TOKEN；');
  console.warn('           发布结束后请到 https://github.com/settings/tokens 撤销该 token，');
  console.warn('           并清理历史文件里的明文（该 token 可能已随历史文件被多处留存）。');
  console.warn('============================================================');
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ver = pkg.version;                    // 1.7.0
const tag = 'v' + ver;
const OWNER = 'xuxue04403';
const REPO = 'dsh-desktop';
const API = 'https://api.github.com';
const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dsh-app-publisher' };

// 不抛错的 API 调用：需要按 HTTP 状态码分流时使用（如 GET sha 的 404 vs 403/429）
async function apiTry(method, url, body) {
  const res = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json: j, text };
}
async function api(method, url, body) {
  const r = await apiTry(method, url, body);
  if (!r.ok) throw new Error(method + ' ' + url + ' → ' + r.status + (r.json && r.json.message ? ' ' + r.json.message : ' ' + r.text.slice(0, 300)));
  return r.json;
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
        let done = false, prog = null, timer = null, req = null;
        const cleanup = () => {
          if (timer) { clearTimeout(timer); timer = null; }
          if (prog) { clearInterval(prog); prog = null; }
        };
        // 审计修复（P2）：超时分支也要清理 setInterval/timeout——旧版只 destroy+reject，
        // 进度定时器会一直挂着，导致进程在失败后长时间不退出。
        timer = setTimeout(() => {
          if (done) return;
          done = true; cleanup();
          try { if (req) req.destroy(); } catch (_) { /* 忽略 */ }
          reject(new Error('timeout 50min: ' + name));
        }, 50 * 60 * 1000);
        prog = setInterval(() => {
          try {
            const sent = req && req.socket ? req.socket.bytesWritten : 0;
            console.log('  .. ' + name + ' progress ' + (sent / 1048576).toFixed(1) + ' / ' + totalMB + ' MB');
          } catch (_) { /* 忽略 */ }
        }, 90000);
        try {
          req = https.request({
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
              if (done) return; done = true; cleanup();
              if (res.statusCode === 201 || res.statusCode === 200) resolve();
              else reject(new Error('asset ' + name + ' → ' + res.statusCode + ' ' + body.slice(0, 300)));
            });
          });
        } catch (err) {
          done = true; cleanup(); reject(err); return;
        }
        req.on('error', (err) => { if (!done) { done = true; cleanup(); reject(err); } });
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

// ---------- 0) 安全闸门（R27）：绝不把真实邮箱信息/密钥推到 GitHub ----------
// 规则由本机配置派生（~/.dsh/settings.yaml 的 email-bridge 段、.credentials.yaml、
// 各网关 gateway.config.json），因此源码里不含任何真实值也能精确拦截。
// 扫描两处：a) 待上传的源码树；b) 绿色目录（zip 的内容，data\ 已排除）。
// 审计修复（P2）：闸门命中时**抛错**而不是 process.exit——exit 不展开 JS 栈，
// 会让 buildPortableZip 的 finally（_zip-stage 清理）与 finally 语义全部失效。
const SOURCE_TREES = [root, path.resolve(root, '..', 'dsh-email-bridge')].filter((p) => fs.existsSync(p));
function gate(targets, label, { allowScrub = false, skipDirs } = {}) {
  const { rules, literalCount } = buildRules();
  // 审计修复（P0）：闸门 fail-closed。literal 规则全部派生自本机真实配置；干净 CI /
  // 新机器上（无 ~/.dsh、无 out\*\data\gateway.config.json）它们会全部为空，此时只剩
  // api-key/bearer 两条通用形态规则——真实邮箱与密码一条也检测不到，旧版却照样打印
  // "[OK] 无邮箱/密钥信息"放行。规则派生不出就**拒绝发布**，而不是假装扫过了。
  if (!literalCount) {
    console.error('[FAIL] 安全闸门(' + label + ')：未能从本机配置派生任何真实值规则'
      + '（~/.dsh/settings.yaml、.credentials.yaml、out\\*\\data\\gateway.config.json 均不可读或为空）。');
    console.error('       此时闸门形同虚设，已阻止发布。请在装有真实配置的机器上发布，'
      + '或设 DSH_HOME_DIR / DSH_SCRUB_EXTRA 指向正确配置后再试。');
    throw new Error('安全闸门(' + label + ')：无可用真实值规则（fail-closed）');
  }
  const opts = skipDirs ? { rules, skipDirs } : { rules };
  const first = scanTree(targets, opts);
  const reportSkips = (r) => {
    if (r.oversized && r.oversized.length) {
      console.warn('[警告] 闸门(' + label + ')：跳过 ' + r.oversized.length + ' 个超过 400MB 的文件（未检查）：');
      for (const o of r.oversized) console.warn('        - ' + (o.where || o));
    }
  };
  if (!first.findings.length) {
    console.log('[OK] 安全闸门(' + label + ')：' + first.files + ' 个文件，无邮箱/密钥信息');
    reportSkips(first);
    return;
  }
  if (allowScrub && doScrub) {
    const r = scrubTree(targets, opts);
    console.log('[..] 安全闸门(' + label + ')：已就地脱敏 ' + r.changed + ' 个文件');
    if (r.backups.length) {
      console.log('[..] 原始备份 ' + r.backups.length + ' 个（*.bak-scrub：不参与扫描/上传，确认无误后可删）');
    }
    if (r.skippedNonUtf8.length) {
      console.warn('[警告] 闸门(' + label + ')：跳过 ' + r.skippedNonUtf8.length + ' 个非 UTF-8 文本文件（未脱敏，绝不写 U+FFFD）：');
      for (const p of r.skippedNonUtf8) console.warn('        - ' + p);
    }
    reportSkips(r);
    const after = scanTree(targets, opts);
    if (!after.findings.length) { console.log('[OK] 安全闸门(' + label + ')：脱敏后复扫干净'); reportSkips(after); return; }
    console.error(formatReport(after.findings));
    throw new Error('脱敏后仍有残留，已阻止发布');
  }
  console.error(formatReport(first.findings));
  console.error('[FAIL] 安全闸门(' + label + ')命中 ' + summarize(first.findings) +
    '——已阻止发布。处理：node scripts/email-scrub.mjs --scan 查看，--scrub 就地清除真实值' +
    (allowScrub ? '（或本次加 --scrub）' : ''));
  throw new Error('安全闸门(' + label + ')命中 ' + summarize(first.findings));
}

// ---------- 2) 绿色版 zip ----------
// 排除名单（审计修复 P2）：除 data\（用户数据，R15 绝不外发）外，还必须剔除运行期生成物——
// node.exe 是 launcher 在 exe 旁做的内嵌运行时硬链接（最大 246MB）、logs\ 与 *.log/*.tmp
// 是运行日志，都不该进发布包。
// 注意（本次一并收窄）：data\/logs\ 只在**绿色目录根**按名字排除——旧版递归按名字排除，
// 会把第三方包里的合法同名目录一并删掉（实测 resources\node_modules\npm\node_modules\
// node-gyp\gyp\data、pnpm 内的同名目录），导致内嵌 node-gyp 缺 data\。
const ZIP_SKIP_DIRS = new Set(['data', 'logs']);
const ZIP_SKIP_FILES = new Set(['node.exe']);
const ZIP_SKIP_FILE_RE = /\.(log|tmp)$/i;

function buildPortableZip(green, zipOut) {
  const stage = path.join(root, 'out', '_zip-stage');
  const skipped = { dirs: [], files: [] };
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    const copy = (s, d, depth = 0) => {
      for (const e of fs.readdirSync(s, { withFileTypes: true })) {
        const sp = path.join(s, e.name), dp = path.join(d, e.name);
        if (e.isDirectory()) {
          if (depth === 0 && ZIP_SKIP_DIRS.has(e.name.toLowerCase())) { skipped.dirs.push(sp); continue; }
          fs.mkdirSync(dp, { recursive: true });
          copy(sp, dp, depth + 1);
          continue;
        }
        if (ZIP_SKIP_FILES.has(e.name.toLowerCase()) || ZIP_SKIP_FILE_RE.test(e.name)) { skipped.files.push(sp); continue; }
        fs.mkdirSync(d, { recursive: true });
        fs.copyFileSync(sp, dp);
      }
    };
    copy(green, stage);
    // 产物安全闸门：zip 的内容在打包前再扫一次（含 resources\vendor 与 app.asar 二进制）
    gate([stage], '绿色产物(zip 内容)');
    const tar = resolveTar();
    if (!tar) throw new Error('未找到 tar：可设 DSH_TAR=<tar 路径>，或确认 %SystemRoot%\\System32\\tar.exe 存在');
    if (fs.existsSync(zipOut)) fs.rmSync(zipOut);
    const r = spawnSync(tar, ['-a', '-cf', zipOut, '-C', stage, '.'], { stdio: 'ignore' });
    if (r.error) throw new Error('无法启动 tar（' + tar + '）：' + r.error.message);
    if (r.status !== 0) {
      fs.rmSync(zipOut, { force: true });
      throw new Error('tar zip failed status=' + r.status + '（半截 zip 已删除）');
    }
    // 审计修复（P2）：zip 完整性校验——大小 > 0 且中央目录可解析、条目可枚举；
    // 不合格直接删除并以非零码退出，绝不把半截 zip 发出去（reupload-zip.ps1 会直接上传它）。
    const v = verifyZip(zipOut);
    if (!v.ok) {
      fs.rmSync(zipOut, { force: true });
      throw new Error('zip 完整性校验失败：' + v.reason + '（半截 zip 已删除，未上传）');
    }
    console.log('[OK] zip → ' + zipOut + ' (' + (v.size / 1048576).toFixed(1) + ' MB, ' + v.entries + ' 条目)');
    console.log('     zip 已剔除：用户数据/日志目录 ' + (skipped.dirs.map((x) => path.basename(x) + '\\').join(' ') || '(无)')
      + '；运行期文件 ' + skipped.files.length + ' 个（node.exe/*.log/*.tmp）');
    return { info: v, skipped };
  } finally {
    // 审计修复（P2）：无论成功、抛错还是闸门拦截，stage 都必须清理
    // （旧版 throw 发生在 fs.rmSync(stage) 之前 → out\_zip-stage 残留）
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ---------- 3) 上传源码 ----------
async function syncSources() {
  let count = 0, skippedBackups = 0;
  const failures = [];
  const walk = async (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'out' || e.name === 'dist' || e.name === '.git') continue;
      if (e.name === 'anywhere-lab-sdsh-desktop') continue;   // 官方参考源码副本，不属于本项目仓库
      // 审计修复（P2）：*.bak-scrub / *.bak 是脱敏或改图标前的**原始值**备份（含真实
      // 邮箱/密钥），绝不允许随源码上传。
      if (/\.bak-scrub$/i.test(e.name) || /\.bak$/i.test(e.name)) { skippedBackups++; continue; }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(abs); continue; }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (/^tests\/.*\.tmp/.test(rel)) continue;
      const buf = fs.readFileSync(abs);
      if (buf.length > 95 * 1048576) { console.log('  !! skip(>95MB) ' + rel); continue; }
      const b64 = buf.toString('base64');
      const uri = `${API}/repos/${OWNER}/${REPO}/contents/${rel}`;
      // 审计修复（P2）：GET sha 必须区分 404（新文件）与其它错误（限流/权限/网络）。
      // 旧版 `catch {}` 把 401/限流一律当"新文件"，随后 PUT 422 中断整轮且没有失败清单。
      let sha = null;
      const probe = await apiTry('GET', uri);
      if (probe.ok && probe.json) {
        sha = probe.json.sha;
      } else if (probe.status !== 404) {
        console.error('[FAIL] 读取远端 sha 失败：' + rel + ' → HTTP ' + probe.status
          + ' ' + ((probe.json && probe.json.message) || probe.text.slice(0, 200)));
        if (probe.status === 403 || probe.status === 429) {
          console.error('       疑似限流或权限不足（GitHub secondary rate limit 需等待后重试；'
            + '未认证请求 60/h、认证 5000/h）。');
        }
        throw new Error('源码同步已中止（绝不把限流/权限失败当作"新文件"继续写）');
      }
      // PUT 重试 2 次；409/422（sha 过期或并发写）先重取 sha 再试
      let lastErr = null, done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        try {
          await api('PUT', uri, { message: sha ? 'chore: update ' + rel : 'feat: add ' + rel, content: b64, sha: sha || undefined });
          done = true;
        } catch (err) {
          lastErr = err;
          const msg = String((err && err.message) || err);
          console.log('  .. PUT ' + rel + ' attempt ' + attempt + '/3 failed: ' + msg);
          if (/\b(409|422)\b/.test(msg)) {
            const re = await apiTry('GET', uri);
            if (re.ok && re.json && re.json.sha) sha = re.json.sha;
          }
          if (attempt < 3) await sleep(1500 * attempt);
        }
      }
      if (!done) { failures.push({ rel, err: String((lastErr && lastErr.message) || lastErr) }); continue; }
      count++;
      if (count % 10 === 0) console.log('  .. ' + count + ' files');
    }
  };
  await walk(root);
  console.log('[OK] uploaded ' + count + ' source file(s)');
  if (skippedBackups) console.log('[..] 已跳过 ' + skippedBackups + ' 个备份文件（*.bak-scrub/*.bak：含原始真实值，绝不上传）');
  if (failures.length) {
    console.error('[FAIL] 源码同步失败清单（' + failures.length + ' 个，重试后仍未成功）：');
    for (const f of failures) console.error('  - ' + f.rel + ' → ' + f.err);
    throw new Error('源码同步未完成：' + failures.length + ' 个文件上传失败（见上方清单）');
  }
}

// ---------- 4) release 正文：按版本生成（审计修复 P2）----------
// 旧版把 R27 的变更日志写死，换 tag 后新 release 正文仍是旧版本的变更记录。
// 现在：--notes / --notes-file 覆盖 → package.json 的 dshApp.releaseNotes
// （字符串，或 { "<version>": "...", "default": "..." }）→ 兜底为明确的待填写提示。
function releaseNotesFor(version) {
  if (notesArg) return notesArg.trim();
  if (notesFileArg) {
    const p = path.resolve(notesFileArg);
    if (!fs.existsSync(p)) throw new Error('--notes-file 不存在：' + p);
    return fs.readFileSync(p, 'utf8').trim();
  }
  const cfg = pkg.dshApp && pkg.dshApp.releaseNotes;
  if (typeof cfg === 'string') return cfg.trim();
  if (cfg && typeof cfg === 'object') {
    for (const k of [version, 'v' + version, 'default']) {
      if (typeof cfg[k] === 'string' && cfg[k].trim()) return cfg[k].trim();
    }
  }
  return '';
}
function buildReleaseBody(version) {
  const notes = releaseNotesFor(version);
  const notesBlock = notes
    ? `What's new in ${tag}:\n${notes}`
    : `What's new in ${tag}:\n- （本版说明未配置：请在 package.json 的 dshApp.releaseNotes["${version}"] 填写，`
      + '或用 --notes / --notes-file 传入；不再自动沿用旧版本的变更日志）';
  return `DSH App ${tag}（自研 Electron 薄壳：进程外托管 dsh web + 看门狗安全模式 + 模型网关 + 输入历史）\n\n`
    + notesBlock + '\n\n'
    + 'Assets:\n'
    + `- DSHApp-Setup-${version}-x64.exe : NSIS 安装版\n`
    + `- DSHApp-Portable-${version}-x64.exe : 单文件便携版\n`
    + `- DSHApp-Portable-${version}.zip : 绿色免安装目录版（已剔除 data\\ 用户数据、logs\\ 日志与运行期 node.exe）`;
}

// ---------- 5) 资产（同名不删旧，改名保留；审计修复 P1）----------
// 便携版产物名已改为纯 ASCII（`DSHApp-Portable-<ver>-x64.exe`，见 package.json 的
// build.portable.artifactName）：旧名含中文「便携版」，任何编码差异（PS5.1 以 GBK 读脚本）
// 都会让查找/匹配静默失败。这里同时兼容旧名，避免历史构建产物无法上传。
function portableLocalPath() {
  const ascii = path.join(root, 'dist', 'DSHApp-Portable-' + ver + '-x64.exe');
  if (fs.existsSync(ascii)) return ascii;
  return path.join(root, 'dist', 'DSHApp-' + ver + '-便携版.exe');   // 旧版 electron-builder 产物名
}
function assetSpecs(zipPath) {
  return [
    ['DSHApp-Setup-' + ver + '-x64.exe', path.join(root, 'dist', 'DSHApp-' + ver + '-x64.exe'), 'NSIS 安装版'],
    ['DSHApp-Portable-' + ver + '-x64.exe', portableLocalPath(), '单文件便携版'],
    ['DSHApp-Portable-' + ver + '.zip', zipPath, '绿色目录 zip'],
  ];
}
async function uploadAssets(rel, specs) {
  const uploadUrl = rel.upload_url;
  const failures = [];
  for (const [name, file, label] of specs) {
    if (!fs.existsSync(file)) { console.error('[FAIL] 本地资产缺失（' + label + '）：' + file); failures.push(name); continue; }
    const old = (rel.assets || []).find((a) => a.name === name);
    let renamed = null;
    if (old) {
      // 审计修复（P1）：不再"先删后传"。旧资产先改名为 <name>.old-<时间戳> 保留，
      // 新资产上传成功后才删除；上传失败则旧资产原样留着（可手工改名恢复）。
      const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      renamed = await api('PATCH', `${API}/repos/${OWNER}/${REPO}/releases/assets/${old.id}`, { name: name + '.old-' + stamp });
      console.log('  .. 旧资产已改名保留: ' + renamed.name + '（新资产上传成功后才删除）');
    }
    try {
      await uploadAsset(uploadUrl, name, file);
    } catch (err) {
      const msg = String((err && err.message) || err);
      console.error('[FAIL] 资产上传失败: ' + name + ' → ' + msg);
      if (renamed) console.error('       旧资产保留为 ' + renamed.name + '（未删除）——可手工改回 ' + name + ' 恢复。');
      failures.push(name);
      continue;
    }
    if (renamed) {
      try {
        await api('DELETE', `${API}/repos/${OWNER}/${REPO}/releases/assets/${renamed.id}`);
        console.log('  .. 已删除改名后的旧资产: ' + renamed.name);
      } catch (err) {
        console.warn('[警告] 旧资产删除失败（不影响新资产，可手工清理）：' + ((err && err.message) || err));
      }
    }
  }
  return failures;
}

// ---------- 6) 断言三类资产齐全且大小一致（审计修复 P1）----------
async function verifyAssets(specs, strict) {
  const fresh = await api('GET', `${API}/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
  const assets = fresh.assets || [];
  const problems = [];
  for (const [name, file, label] of specs) {
    const a = assets.find((x) => x.name === name);
    const hasLocal = fs.existsSync(file);
    if (!a) { problems.push('缺失（' + label + '）：' + name); continue; }
    if (!hasLocal) {
      if (strict) problems.push('本机无文件可比对（' + label + '）：' + name);
      else console.log('[..] 远端已有（--skip-assets，未比对大小）: ' + name + ' (' + a.size + ' 字节)');
      continue;
    }
    const local = fs.statSync(file).size;
    if (a.size !== local) problems.push('大小不一致（' + label + '）：' + name + ' 远端 ' + a.size + ' ≠ 本地 ' + local);
    else console.log('[OK] 资产校验通过 ' + name + ' (' + local + ' 字节)');
  }
  if (!problems.length) return;
  console.error('[FAIL] 资产校验未通过（' + problems.length + ' 项）：');
  for (const p of problems) console.error('  - ' + p);
  if (strict) throw new Error('release ' + tag + ' 资产不齐全或大小不一致，已置非零退出码');
  console.warn('[警告] --skip-assets：远端资产不齐全（本次未上传资产，故不作失败处理）');
}

async function main() {
  // 1) 身份与仓库
  const me = await api('GET', API + '/user');
  console.log('[OK] authenticated as ' + me.login + (me.login === OWNER ? '' : '  (!! 期望 ' + OWNER + ')'));
  await api('GET', `${API}/repos/${OWNER}/${REPO}`);
  console.log('[OK] repo ' + OWNER + '/' + REPO);

  // 1.5) 源码树安全闸门（真实邮箱信息/密钥在上传前拦下）
  gate(SOURCE_TREES, '源码树', { allowScrub: true });

  // 2) 绿色版 zip（剔除 data\、logs\、node.exe、*.log、*.tmp）
  const zipPath = path.join(root, 'dist', `DSHApp-${ver}-Portable.zip`);
  const green = zipFromArg || path.join(root, 'out', 'DSH-App');
  if (!fs.existsSync(path.join(green, 'DSH-App.exe'))) {
    throw new Error('绿色目录缺少 DSH-App.exe：' + green + '（先运行 node scripts/build-portable.mjs）');
  }
  buildPortableZip(green, zipPath);

  // 3) 上传源码（与 release.ps1 相同的剔除规则）
  if (skipSource) console.log('[..] --skip-source：跳过源码上传');
  else await syncSources();

  // 4) 创建/复用 release（正文按版本生成）
  let rel = null;
  try { rel = await api('GET', `${API}/repos/${OWNER}/${REPO}/releases/tags/${tag}`); } catch { /* 不存在 */ }
  if (!rel) {
    const body = buildReleaseBody(ver);
    rel = await api('POST', `${API}/repos/${OWNER}/${REPO}/releases`, { tag_name: tag, name: tag, body });
    console.log('[OK] release created: ' + tag);
  } else {
    console.log('[..] release ' + tag + ' already exists, reuse');
  }

  // 5) 上传资产（同名旧资产先改名保留）
  const specs = assetSpecs(zipPath);
  let failures = [];
  if (skipAssets) {
    console.log('[..] --skip-assets：跳过资产上传（源码与 release 已同步）');
  } else {
    failures = await uploadAssets(rel, specs);
  }

  // 6) 断言三类资产齐全且大小一致（缺失即失败清单 + 非零退出，不再只 WARN 后报 [DONE]）
  await verifyAssets(specs, !skipAssets);

  if (failures.length) throw new Error('有 ' + failures.length + ' 个资产上传失败：' + failures.join(', '));

  console.log('[DONE] ' + tag + ' published → https://github.com/' + OWNER + '/' + REPO + '/releases/tag/' + tag);
  console.log('[安全] 发布已完成，建议现在就撤销本次使用的 token：https://github.com/settings/tokens');
  if (!haveExplicitToken && hist.token) {
    console.log('       并清理 ' + HISTORY_PATH + ' 中残留的明文 token。');
  }
}

main().catch((err) => {
  console.error('[FAIL] ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
