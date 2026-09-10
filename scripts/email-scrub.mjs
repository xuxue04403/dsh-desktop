// scripts/email-scrub.mjs — 发布守卫（R27）：推送 GitHub 前检测并清除真实邮箱信息
//
// 背景：邮箱桥接插件的真实配置（IMAP/SMTP 主机、账号、密码）保存在本机
//   ~/.dsh/settings.yaml（email-bridge 段）、~/.dsh/.credentials.yaml（EMAIL_CRED_*）
//   以及 ~/.dsh/profiles/*/cordis.patch.yml 中。源码/产物里若残留这些真实值，
//   一旦随 release 上传就等同泄漏。本模块在发布链路的两处入口做闸门：
//     1) scripts/publish.mjs  —— 上传源码 / 打包 zip 之前
//     2) scripts/release.ps1  —— 上传源码 / 资产之前
//
// 设计要点：**规则全部由本机真实配置派生**，模块源码不硬编码任何真实域名、地址或密码，
//   因此本文件自身可以安全地出现在公开仓库里（只含 example.com 之类的占位符）。
//
// 用法（CLI）：
//   node scripts/email-scrub.mjs --scan [路径...]        # 只报告，命中退出码 1（默认扫描项目根）
//   node scripts/email-scrub.mjs --scrub [路径...]       # 就地替换为占位符，退出码 0
//   node scripts/email-scrub.mjs --scan-zip <a.zip>      # 解包后扫描（tar.exe）
//   node scripts/email-scrub.mjs --list-rules            # 打印派生出的规则（掩码）
//   环境变量：DSH_HOME_DIR 覆盖 ~/.dsh；DSH_SCRUB_EXTRA 追加自定义敏感词（逗号分隔，不落库）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 默认跳过：依赖/构建产物/官方参考源码副本 ----------
// 注意：这里只跳过“子目录”。显式传入的扫描根即使名字命中跳过名单也会被扫描
// （见 scanTree/scrubTree 的 roots 处理）——否则 `--scan out\_zip-stage` 会静默扫 0 个文件。
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'anywhere-lab-sdsh-desktop',
  '.cache', '.vite', 'coverage',
]);
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yml', '.yaml', '.md', '.txt',
  '.html', '.css', '.ps1', '.cmd', '.bat', '.sh', '.env', '.example', '.toml', '.ini', '.cfg',
]);
const MAX_SCAN_BYTES = 400 * 1048576;   // 单文件上限（含 exe/asar 的二进制扫描）

// ---------- 占位符判定：模板值不是秘密 ----------
// 命中这些形态的地址/主机不参与规则派生（否则会误判我们自己的默认模板）。
const PLACEHOLDER_RE = /(^|[@.-])(example|sample|placeholder|yourdomain|your-domain|domain|localhost)([.-]|$)|@(example|test|invalid|localhost)\.|^(you|your|user|name|someone|admin)@|REPLACE|CHANGE_?ME|xxxx/i;
const PLACEHOLDER_SECRET_RE = /^(REPLACE|CHANGE_?ME|YOUR|PASSWORD|SECRET|EXAMPLE|PLACEHOLDER|XXX+|TODO)/i;

// ---------- 掩码：报告里绝不出现明文 ----------
export function mask(v) {
  const s = String(v);
  if (s.length <= 4) return s[0] + '***';
  const at = s.indexOf('@');
  if (at > 0) return s[0] + '***' + s.slice(at);              // 邮箱：保留域名，隐去账号
  return s.slice(0, 2) + '***' + s.slice(-2) + ' (' + s.length + ' 字符)';
}

// ---------- 解析本机真实配置（只用于生成规则，不写出明文） ----------
function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function liveConfig(home) {
  const texts = [];
  const settings = readIf(path.join(home, 'settings.yaml'));
  if (settings) texts.push(settings);
  const creds = readIf(path.join(home, '.credentials.yaml'));
  const profDir = path.join(home, 'profiles');
  let profs = [];
  try {
    profs = fs.readdirSync(profDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* 无 profiles 目录 */ }
  for (const p of profs) {
    const t = readIf(path.join(profDir, p, 'cordis.patch.yml'));
    if (t) texts.push(t);
  }
  const joined = texts.join('\n');

  // 邮箱地址（settings 段 / patch 里的 user、from 等）
  const addresses = new Set();
  for (const m of joined.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) addresses.add(m[0]);

  // 邮箱服务器主机名（只取与邮件相关的 key，避免把代理/网关主机也算进来）
  const hosts = new Set();
  for (const m of joined.matchAll(/^\s*(?:host|hostname)\s*:\s*["']?([A-Za-z0-9.-]+\.[A-Za-z]{2,})["']?\s*$/gm)) {
    hosts.add(m[1]);
  }

  // 密钥类字面量：凭据库全部 ref 值（供应商 key / 网关 key 等）+ 邮箱密码
  // 说明：密钥格式由用户自定（如 dsh-gateway-xxx 是自家前缀），形态规则必然误报，
  //       因此这里全部用「本机真实值」做字面量匹配。
  const secrets = new Set();
  const pushSecret = (v) => {
    const s = String(v || '').trim().replace(/^["']|["']$/g, '');
    if (s.length >= 12 && !/^(https?|file):\/\//i.test(s) && !/^[\d.]+$/.test(s)) secrets.add(s);
  };
  for (const m of creds.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/gm)) {
    const [, key, rawVal] = m;
    if (/^(refs|version|updatedAt|note|comment)$/i.test(key)) continue;
    pushSecret(rawVal);
  }
  // 网关配置（providers[].apiKey 与网关自身 apiKey）
  for (const gc of gatewayConfigPaths(home)) {
    try {
      const j = JSON.parse(readIf(gc) || '{}');
      pushSecret(j.apiKey);
      for (const p of Array.isArray(j.providers) ? j.providers : []) pushSecret(p && p.apiKey);
    } catch { /* 配置损坏则跳过 */ }
  }

  const domains = new Set();
  for (const a of addresses) { const d = a.split('@')[1]; if (d) domains.add(d.toLowerCase()); }
  // 占位符过滤：本机 profile 补丁里的模板值（imap.example.com / you@example.com …）不是秘密，
  // 若当成规则会反过来误判/误改我们自己的默认模板。
  const keep = (v) => !PLACEHOLDER_RE.test(v);
  const addr = [...addresses].filter(keep);
  const dom = [...domains].filter(keep);
  return {
    addresses: addr,
    hosts: [...hosts].filter(keep),
    secrets: [...secrets].filter((s) => !PLACEHOLDER_SECRET_RE.test(s)),
    domains: dom,
  };
}

// 本机可能的网关配置位置（发布时读取其中真实 key，作为字面量规则）
export function gatewayConfigPaths(home = process.env.DSH_HOME_DIR || path.join(os.homedir(), '.dsh')) {
  const cands = [];
  const push = (p) => { if (p && fs.existsSync(p)) cands.push(p); };
  push(process.env.DSH_GATEWAY_CONFIG);
  push(path.join(home, 'gateway.config.json'));
  try {
    for (const d of fs.readdirSync(path.join(root, 'out'), { withFileTypes: true })) {
      if (d.isDirectory()) push(path.join(root, 'out', d.name, 'data', 'gateway.config.json'));
    }
  } catch { /* 无 out 目录 */ }
  return cands;
}

// 第三方公共数据里天然含有公开的邮件服务商域名（如 nodemailer 预设列表），不是泄漏
export const DEFAULT_ALLOW = [
  /[\\/]node_modules[\\/].*[\\/](well-known|services\.(?:json|js))$/i,
];

// ---------- 规则 ----------
// 1) literal：本机真实值（地址/主机/密码/地址域名下的任意账号）
// 2) generic ：通用密钥形态（与邮箱无关，但同属「绝不上传」类），可安全写在源码里
export function buildRules({ home = process.env.DSH_HOME_DIR || path.join(os.homedir(), '.dsh'), extra = process.env.DSH_SCRUB_EXTRA || '' } = {}) {
  const cfg = liveConfig(home);
  const rules = [];
  // literal: true = 本机真实值字面量（精确，二进制也可扫）
  // literal 缺省 = 通用形态（只扫文本：exe/dll/asar 里的随机字节极易误报）
  for (const a of cfg.addresses) {
    rules.push({ id: 'email-address', literal: true, label: '邮箱地址 ' + mask(a), re: new RegExp(escapeRe(a), 'gi'), replace: 'you@example.com' });
  }
  for (const d of cfg.domains) {
    // 同一域名下的其它账号（配置里没出现过的）也要拦住
    rules.push({ id: 'email-domain', literal: true, label: '邮箱域名 @' + d, re: new RegExp('[A-Za-z0-9._%+-]+@' + escapeRe(d), 'gi'), replace: 'you@example.com' });
  }
  for (const h of cfg.hosts) {
    const isSmtp = /^smtp/i.test(h);
    rules.push({ id: 'mail-host', literal: true, label: '邮件服务器 ' + h, re: new RegExp(escapeRe(h), 'gi'), replace: isSmtp ? 'smtp.example.com' : 'imap.example.com' });
  }
  for (const s of cfg.secrets) {
    rules.push({ id: 'secret-value', literal: true, label: '本机凭据值 ' + mask(s), re: new RegExp(escapeRe(s), 'g'), replace: 'REDACTED_SECRET' });
  }
  for (const term of String(extra).split(',').map((x) => x.trim()).filter(Boolean)) {
    rules.push({ id: 'extra', literal: true, label: '自定义敏感词 ' + mask(term), re: new RegExp(escapeRe(term), 'gi'), replace: 'REDACTED' });
  }
  // 通用密钥形态（不含真实值，可提交进仓库）：仅作兜底，且只用于文本文件
  rules.push({ id: 'api-key', label: 'API key 形态 (sk-/ghp_/github_pat_)', re: /(?<![A-Za-z0-9])(?:sk|ghp|gho|ghu|ghs|ghr)-[A-Za-z0-9_-]{24,}|github_pat_[A-Za-z0-9_]{20,}/g, replace: 'REDACTED_KEY' });
  rules.push({ id: 'bearer', label: '硬编码 Bearer token', re: /Bearer\s+[A-Za-z0-9._-]{24,}/g, replace: 'Bearer REDACTED' });
  return { rules, cfg };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- 扫描 ----------
export function scanText(text, rules, where, { binary = false } = {}) {
  const out = [];
  // 二进制文件（exe/dll/asar/pak）只做精确字面量匹配：通用形态规则在二进制里必然误报
  const use = binary ? rules.filter((r) => r.literal) : rules;
  for (const r of use) {
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ rule: r.id, label: r.label, where, line, sample: mask(m[0]) });
    }
  }
  return out;
}

// 大二进制（Electron node.exe 约 250MB）分块扫描：避免一次性 toString 造成内存峰值
const CHUNK = 16 * 1048576;
function scanLargeBinary(p, size, rules) {
  const use = rules.filter((r) => r.literal);
  if (!use.length) return [];
  const overlap = Math.max(...use.map((r) => r.re.source.length)) + 8;
  const findings = [];
  const fd = fs.openSync(p, 'r');
  try {
    let pos = 0, tail = '';
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      const text = tail + buf.subarray(0, n).toString('latin1');
      findings.push(...scanText(text, use, p, { binary: true }));
      tail = text.slice(-overlap);
      pos += n;
      if (findings.length > 200) break;   // 命中已足够多，无需继续
    }
  } finally { fs.closeSync(fd); }
  // 分块重叠区可能重复命中同一处：按规则+掩码去重（大二进制的行号无意义）
  const seen = new Set();
  return findings.filter((f) => {
    const k = f.rule + '|' + f.sample;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function scanTree(targets, { rules, skipDirs = SKIP_DIRS, allow = DEFAULT_ALLOW } = {}) {
  const findings = [];
  let files = 0, skipped = 0;
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (skipDirs.has(path.basename(p))) return;
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      return;
    }
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) return;
    if (allow.some((re) => re.test(p))) { skipped++; return; }
    files++;
    const isText = TEXT_EXT.has(path.extname(p).toLowerCase());
    if (!isText && st.size > 32 * 1048576) {           // 大二进制分块扫，控制内存
      findings.push(...scanLargeBinary(p, st.size, rules));
      return;
    }
    // 文本按 utf8 扫；小二进制按 latin1 兜底扫，避免解码丢字节导致漏报
    let buf;
    try { buf = fs.readFileSync(p); } catch { return; }
    const text = isText ? buf.toString('utf8') : buf.toString('latin1');
    findings.push(...scanText(text, rules, p, { binary: !isText }));
  };
  // 显式传入的扫描根不做跳过判定（只对其子目录生效）
  for (const t of targets) {
    const abs = path.resolve(t);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(abs)) walk(path.join(abs, e)); }
    else walk(abs);
  }
  return { findings, files, skipped };
}

export function scrubTree(targets, { rules, skipDirs = SKIP_DIRS, allow = DEFAULT_ALLOW } = {}) {
  const hits = [];
  let files = 0, changed = 0;
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (skipDirs.has(path.basename(p))) return;
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      return;
    }
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) return;
    if (allow.some((re) => re.test(p))) return;
    if (!TEXT_EXT.has(path.extname(p).toLowerCase())) return;   // 只改写文本，二进制不擅自动
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
    files++;
    let nextText = text, n = 0;
    for (const r of rules) {
      nextText = nextText.replace(r.re, () => { n++; return r.replace; });
    }
    if (n > 0) { fs.writeFileSync(p, nextText, 'utf8'); changed++; hits.push({ where: p, count: n }); }
  };
  // 与 scanTree 一致：显式传入的扫描根不做跳过判定
  for (const t of targets) {
    const abs = path.resolve(t);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(abs)) walk(path.join(abs, e)); }
    else walk(abs);
  }
  return { files, changed, hits };
}

export function formatReport(findings) {
  if (!findings.length) return '';
  const lines = ['[安全] 检测到真实邮箱/密钥信息（明文已掩码显示）：'];
  for (const f of findings) {
    lines.push('  - ' + f.where + ':' + f.line + '  [' + f.label + '] → ' + f.sample);
  }
  return lines.join('\n');
}

export function summarize(findings) {
  const by = {};
  for (const f of findings) by[f.rule] = (by[f.rule] || 0) + 1;
  return Object.entries(by).map(([k, v]) => k + '×' + v).join(', ');
}

// ---------- CLI ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const { rules, cfg } = buildRules();
  const scope = positional.length ? positional : [root];

  if (args.includes('--list-rules')) {
    console.log('[..] 规则 ' + rules.length + ' 条（来自 ' + (process.env.DSH_HOME_DIR || path.join(os.homedir(), '.dsh')) + '）');
    for (const r of rules) console.log('  - ' + r.id + ' : ' + r.label);
    console.log('[..] 取自本机配置：地址 ' + cfg.addresses.length + ' / 主机 ' + cfg.hosts.length + ' / 密码 ' + cfg.secrets.length + ' / 域名 ' + cfg.domains.length);
    process.exit(0);
  }

  if (args.includes('--scan-zip')) {
    const i = args.indexOf('--scan-zip');
    const zip = args[i + 1];
    if (!zip || !fs.existsSync(zip)) { console.error('[FAIL] --scan-zip 需要存在的 zip 路径'); process.exit(2); }
    const tmp = path.join(os.tmpdir(), 'dsh-scrub-zip-' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    const r = spawnSync('C:\\Windows\\System32\\tar.exe', ['-xf', path.resolve(zip), '-C', tmp], { stdio: 'ignore' });
    if (r.status !== 0) { console.error('[FAIL] 解包失败 status=' + r.status); process.exit(2); }
    const { findings, files } = scanTree([tmp], { rules });
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('[..] zip 扫描完成：' + files + ' 个文件，命中 ' + findings.length);
    if (findings.length) { console.error(formatReport(findings)); process.exit(1); }
    console.log('[OK] zip 内无邮箱/密钥信息');
    process.exit(0);
  }

  if (args.includes('--scrub')) {
    const { files, changed, hits } = scrubTree(scope, { rules });
    console.log('[..] 脱敏：扫描 ' + files + ' 个文本文件，改写 ' + changed + ' 个');
    for (const h of hits) console.log('  - ' + h.where + ' (' + h.count + ' 处)');
    const after = scanTree(scope, { rules });
    if (after.findings.length) { console.error(formatReport(after.findings)); console.error('[FAIL] 仍有余留，请手动处理'); process.exit(1); }
    console.log('[OK] 已清除，复扫无残留');
    process.exit(0);
  }

  // 默认 --scan
  const { findings, files } = scanTree(scope, { rules });
  console.log('[..] 扫描 ' + scope.length + ' 个路径 / ' + files + ' 个文件，命中 ' + findings.length + (findings.length ? '（' + summarize(findings) + '）' : ''));
  if (findings.length) { console.error(formatReport(findings)); console.error('[FAIL] 存在真实邮箱/密钥信息，已阻止发布。修复：node scripts/email-scrub.mjs --scrub'); process.exit(1); }
  console.log('[OK] 未发现真实邮箱/密钥信息');
  process.exit(0);
}
