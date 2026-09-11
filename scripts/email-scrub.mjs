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
//   node scripts/email-scrub.mjs --scrub [路径...]       # 就地替换为占位符（改写前先写 <文件>.bak-scrub 备份）
//   node scripts/email-scrub.mjs --scan-zip <a.zip>      # 校验 zip 结构后解包扫描（tar）
//   node scripts/email-scrub.mjs --list-rules            # 打印派生出的规则（掩码）
//   环境变量：DSH_HOME_DIR 覆盖 ~/.dsh；DSH_SCRUB_EXTRA 追加自定义敏感词（逗号分隔，不落库）；
//             DSH_TAR 指定 tar 可执行文件（默认取 PATH，再回退 %SystemRoot%\System32\tar.exe）
//
// 审计修复（P2，2026-09-10）：
//   - --scrub 就地改写前为每个被改写的文件写一份 `<文件>.bak-scrub`（已存在则不覆盖，
//     保留首次备份）；改写前用 TextDecoder{fatal:true} 做 UTF-8 合法性校验，非 UTF-8
//     （GBK/ANSI）文件**跳过并计入报告**——旧版会把它解码成 U+FFFD 后写回，不可逆损坏。
//   - 超过 400MB 的文件不再静默跳过，而是告警并计入报告。
//   - 大二进制分块扫描的 overlap 改为「实际可能匹配长度」上限，不再用正则源码长度
//     （email-domain 规则的 local part 可远长于正则源码）。
//   - tar 不再硬编码 C:\Windows\System32\tar.exe；CLI 入口判定改为大小写不敏感
//     （旧版以小写盘符调用会 isMain=false → 什么都不做却 exit 0，安全闸门静默失效）。
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
// 审计修复（P2）：旧正则过宽且未锚定——`REPLACE|CHANGE_?ME|xxxx` 无边界、`^(you|your|
// user|name|someone|admin)@` 不带域名条件。组合后果：**真实**地址 user@my-domain.com
// 会被地址规则（user@）与域名规则（domain）**双双过滤掉** → literal 规则数为 0 → 闸门
// 全盲却仍打印 [OK]。现在只排除明确的占位形态（example/test/invalid/localhost 顶级域、
// 全等占位词、常见示例账号 + 示例域）。
const PLACEHOLDER_RE = new RegExp(
  '(^|[@.-])(example|sample|placeholder|yourdomain|your-domain|localhost)([.-]|$)'      // 示例域/主机
  + '|@(example|test|invalid|localhost)\\.'                                             // 示例顶级域
  + '|^(you|your|user|name|someone|admin)@(example|test|invalid|localhost|your-?domain)\\.'  // 示例账号（须配示例域）
  + '|^(replace|change_?me|your_?|todo|xxxx+)$'                                        // 整值占位（全等，不做子串匹配）
  , 'i');
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

// 第三方公共数据里天然含有公开的邮件服务商域名（如 nodemailer 预设列表），不是泄漏；
// `*.bak-scrub` 是 --scrub 写出的**原始值备份**（本地保留，绝不参与扫描/上传，否则等于
// 把刚脱敏掉的真实值又扫出来/又推上去）。
export const DEFAULT_ALLOW = [
  /[\\/]node_modules[\\/].*[\\/](well-known|services\.(?:json|js))$/i,
  /\.bak-scrub$/i,
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
    // maxMatch：local part 理论上可远长于正则源码，供分块扫描预留足够的 overlap
    rules.push({ id: 'email-domain', literal: true, maxMatch: 320, label: '邮箱域名 @' + d, re: new RegExp('[A-Za-z0-9._%+-]+@' + escapeRe(d), 'gi'), replace: 'you@example.com' });
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
  // 审计修复（P0）：闸门**不得 fail-open**。literal 规则全部来自本机真实配置（邮箱地址/
  // 域名/邮件服务器/凭据值）；在干净 CI / 新机器上（无 ~/.dsh、无 out\*\data）这些来源
  // 全空时只剩上面两条通用形态规则——真实邮箱与密码一条都检测不到，却照样打印
  // "[OK] 无邮箱/密钥信息"放行。这里把「规则是否真的派生出来」作为闸门前置条件，
  // 由调用方（gate/CLI）fail-closed 处理。
  const literalCount = rules.filter((r) => r.literal).length;
  return { rules, cfg, literalCount };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- 外部工具解析（审计修复 P2）----------
// 解析顺序：DSH_TAR 显式指定 → PATH 上的 tar（Windows 10 1803+ 自带 bsdtar；
// Git for Windows / MSYS 亦可）→ %SystemRoot%\System32\tar.exe 兜底。
// 找不到返回 null，调用方必须显式报错——绝不静默跳过解包/打包。
export function resolveTar() {
  const cands = [];
  if (process.env.DSH_TAR) cands.push(process.env.DSH_TAR);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) cands.push(path.join(dir, 'tar' + ext));
  }
  if (process.platform === 'win32') {
    cands.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'));
  }
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 试下一个 */ }
  }
  return null;
}

// ---------- zip 完整性校验（审计修复 P2，纯 Node 零依赖）----------
// 背景：tar 被打断会留下"半截 zip"（没有中央目录），而 --scan-zip / publish.mjs /
// reupload-zip.ps1 都可能直接使用它——半截 zip 甚至能被部分解包工具"成功"解开一部分，
// 于是闸门扫的是残缺内容（假阴性）或把损坏产物传上 GitHub。
// 这里解析 EOCD（含 ZIP64）与中央目录，确认结构完整、条目可枚举。
export function zipInfo(filePath, { maxNames = 20 } = {}) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) return { ok: false, reason: '文件过小（' + size + ' 字节）', entries: 0, names: [], size };
    const tailLen = Math.min(size, 65557);          // EOCD 最长 = 22 字节 + 64KB 注释
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) {
      return { ok: false, reason: '未找到中央目录结束记录（EOCD）——zip 被截断或未写完', entries: 0, names: [], size };
    }
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      // ZIP64：EOCD 定位器紧邻 EOCD 之前（20 字节），再指向 ZIP64 EOCD 记录
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) {
        return { ok: false, reason: 'ZIP64 定位器缺失', entries: 0, names: [], size };
      }
      const z64 = Number(tail.readBigUInt64LE(loc + 8));
      const head = Buffer.alloc(56);
      if (z64 < 0 || z64 + 56 > size || fs.readSync(fd, head, 0, 56, z64) !== 56
        || head.readUInt32LE(0) !== 0x06064b50) {
        return { ok: false, reason: 'ZIP64 EOCD 记录缺失或越界', entries: 0, names: [], size };
      }
      entries = Number(head.readBigUInt64LE(32));
      cdSize = Number(head.readBigUInt64LE(40));
      cdOff = Number(head.readBigUInt64LE(48));
    }
    if (entries <= 0) return { ok: false, reason: '归档内 0 个条目（空/半截 zip）', entries: 0, names: [], size };
    if (cdSize <= 0 || cdOff < 0 || cdOff + cdSize > size) {
      return { ok: false, reason: '中央目录越界（offset=' + cdOff + ' size=' + cdSize + ' file=' + size + '）', entries, names: [], size };
    }
    const cd = Buffer.alloc(cdSize);
    if (fs.readSync(fd, cd, 0, cdSize, cdOff) !== cdSize) {
      return { ok: false, reason: '中央目录读取不完整', entries, names: [], size };
    }
    const names = [];
    let p = 0, parsed = 0;
    while (p + 46 <= cd.length) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;             // 中央目录条目签名
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) break;
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (names.length < maxNames) names.push(name);
      if (localOff >= size) {
        return { ok: false, reason: '条目本地头偏移越界：' + name, entries: parsed, names, size };
      }
      parsed++;
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (parsed !== entries) {
      return {
        ok: false,
        reason: '中央目录条目数不符（EOCD 声明 ' + entries + '，实际可解析 ' + parsed + '）',
        entries: parsed, names, size,
      };
    }
    return { ok: true, entries: parsed, names, size };
  } finally { fs.closeSync(fd); }
}

// 供打包/发布脚本使用：大小 + 结构双校验，任何异常都转成 {ok:false}
export function verifyZip(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (err) {
    return { ok: false, reason: '无法读取 zip：' + (err && err.message ? err.message : err), entries: 0, names: [], size: 0 };
  }
  if (!st.isFile() || st.size <= 0) {
    return { ok: false, reason: '大小非法（' + st.size + ' 字节）', entries: 0, names: [], size: st.size };
  }
  try { return zipInfo(filePath); } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err), entries: 0, names: [], size: st.size };
  }
}

// ---------- CLI 入口判定（审计修复 P2）----------
// Windows 路径大小写不敏感：以小写盘符调用时（node d:\ide\...\email-scrub.mjs），
// 旧版 `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` 为 false →
// 脚本什么都不做却 exit 0——安全闸门被静默绕过（fail-open）。
// 统一 realpath 归一 + toLowerCase 比较。
export function isCliEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const canon = (p) => {
    let r = p;
    try { r = fs.realpathSync(p); } catch { /* 路径不存在时退回原值 */ }
    return path.resolve(r).toLowerCase();
  };
  try { return canon(argv1) === canon(fileURLToPath(moduleUrl)); } catch { return false; }
}

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
// 分块重叠必须覆盖「实际可能匹配长度」，而不是正则**源码**长度（审计修复 P2）：
// email-domain 的源码是 `[A-Za-z0-9._%+-]+@<domain>`（二三十字符），但实际匹配的
// local part 可以长得多——用源码长度当 overlap 时，正好跨块边界的超长邮箱会漏报。
// 含无界量词（+ / * / {n,}）的规则一律按上限预留；规则可显式声明 maxMatch 覆盖。
const UNBOUNDED_MATCH_SPAN = 4096;
export function ruleMatchSpan(r) {
  if (Number.isFinite(r.maxMatch) && r.maxMatch > 0) return r.maxMatch;
  const src = r.re.source;
  if (/[+*]|\{\d+,\}/.test(src)) return UNBOUNDED_MATCH_SPAN;
  return src.length;
}
function scanLargeBinary(p, size, rules) {
  const use = rules.filter((r) => r.literal);
  if (!use.length) return [];
  const overlap = Math.min(CHUNK / 2, Math.max(...use.map(ruleMatchSpan)) + 8);
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
  const oversized = [];      // 审计修复 P2：超限文件不再静默跳过（告警 + 计入报告）
  let files = 0, skipped = 0;
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (skipDirs.has(path.basename(p))) return;
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      return;
    }
    if (!st.isFile()) return;
    if (allow.some((re) => re.test(p))) { skipped++; return; }
    if (st.size > MAX_SCAN_BYTES) { oversized.push({ where: p, size: st.size }); return; }
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
  return { findings, files, skipped, oversized };
}

export function scrubTree(targets, { rules, skipDirs = SKIP_DIRS, allow = DEFAULT_ALLOW, backup = true } = {}) {
  const hits = [];
  const backups = [];            // 本次写出的 <文件>.bak-scrub（原始值，本地保留）
  const skippedNonUtf8 = [];     // 审计修复 P2：非 UTF-8 一律跳过，绝不写 U+FFFD
  const oversized = [];
  let files = 0, changed = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (skipDirs.has(path.basename(p))) return;
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      return;
    }
    if (!st.isFile()) return;
    if (allow.some((re) => re.test(p))) return;
    if (!TEXT_EXT.has(path.extname(p).toLowerCase())) return;   // 只改写文本，二进制不擅自动
    if (st.size > MAX_SCAN_BYTES) { oversized.push({ where: p, size: st.size }); return; }
    let buf;
    try { buf = fs.readFileSync(p); } catch { return; }
    // 审计修复 P2：改写前先做 UTF-8 合法性校验。旧版直接 readFileSync(p,'utf8')——
    // GBK/ANSI 文本会被解码成 U+FFFD 再写回，**不可逆损坏**用户文件。
    let text;
    try { text = decoder.decode(buf); } catch { skippedNonUtf8.push(p); return; }
    files++;
    let nextText = text, n = 0;
    for (const r of rules) {
      nextText = nextText.replace(r.re, () => { n++; return r.replace; });
    }
    if (n > 0) {
      // 审计修复 P2：就地改写前先备份（已存在则不覆盖，保留首次/最原始的那份）。
      // 备份失败即放弃改写（fail-closed），绝不出现"改了但没备份"的状态。
      const bak = p + '.bak-scrub';
      if (backup && !fs.existsSync(bak)) {
        try { fs.copyFileSync(p, bak); backups.push(bak); }
        catch (err) {
          throw new Error('备份失败，已放弃就地改写：' + p + ' → ' + (err && err.message ? err.message : err));
        }
      }
      fs.writeFileSync(p, nextText, 'utf8');
      changed++; hits.push({ where: p, count: n });
    }
  };
  // 与 scanTree 一致：显式传入的扫描根不做跳过判定
  for (const t of targets) {
    const abs = path.resolve(t);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(abs)) walk(path.join(abs, e)); }
    else walk(abs);
  }
  return { files, changed, hits, backups, skippedNonUtf8, oversized };
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
function reportSkips({ oversized, skippedNonUtf8 }, indent = '[警告] ') {
  const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
  if (oversized && oversized.length) {
    console.warn(indent + '跳过 ' + oversized.length + ' 个超过 ' + mb(MAX_SCAN_BYTES) + ' 的文件（未检查）：');
    for (const o of oversized) console.warn('        - ' + (o.where || o) + ' (' + mb(o.size || 0) + ')');
  }
  if (skippedNonUtf8 && skippedNonUtf8.length) {
    console.warn(indent + '跳过 ' + skippedNonUtf8.length + ' 个非 UTF-8 文本文件（绝不改写，避免 U+FFFD 不可逆损坏）：');
    for (const p of skippedNonUtf8) console.warn('        - ' + p);
  }
}

// 审计修复（P2）：CLI 入口判定大小写不敏感（旧版以小写盘符调用会静默 exit 0）
if (isCliEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const { rules, cfg, literalCount } = buildRules();
  const scope = positional.length ? positional : [root];
  // 审计修复（P0）：扫描类入口一律 fail-closed——派生不出真实值规则时，扫描结果没有
  // 任何意义（只剩通用形态规则），绝不能用 exit 0 让发布脚本误以为"已检查过"。
  if (!args.includes('--list-rules') && !literalCount) {
    console.error('[FAIL] 未能从本机配置派生任何真实值规则（邮箱地址/域名/邮件服务器/凭据值全为空）——'
      + '扫描结果不可信，拒绝放行。请确认 DSH_HOME_DIR（默认 ~/.dsh）下有 settings.yaml / .credentials.yaml，'
      + '或用 DSH_SCRUB_EXTRA 显式补充敏感词。');
    process.exit(2);
  }

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
    // 审计修复（P2）：解包前先校验 zip 完整性——半截 zip 也能"解开一部分"，
    // 那样闸门扫的是残缺内容（假阴性）却照样打印 [OK]。
    const v = verifyZip(zip);
    if (!v.ok) {
      console.error('[FAIL] zip 完整性校验失败：' + v.reason + '（拒绝扫描损坏/半截归档，请重新打包）');
      process.exit(2);
    }
    console.log('[..] zip 结构校验通过：' + v.entries + ' 个条目 / ' + (v.size / 1048576).toFixed(1) + ' MB'
      + (v.names.length ? '（如 ' + v.names.slice(0, 3).join(', ') + '）' : ''));
    const tar = resolveTar();
    if (!tar) {
      console.error('[FAIL] 未找到 tar：可设 DSH_TAR=<tar 路径>，或把 tar 加入 PATH'
        + '（Windows 10 1803+ 自带 %SystemRoot%\\System32\\tar.exe）。');
      process.exit(2);
    }
    const tmp = path.join(os.tmpdir(), 'dsh-scrub-zip-' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    let code = 0;
    try {
      const r = spawnSync(tar, ['-xf', path.resolve(zip), '-C', tmp], { stdio: 'ignore' });
      if (r.error) { console.error('[FAIL] 无法启动 tar（' + tar + '）：' + r.error.message); code = 2; }
      else if (r.status !== 0) { console.error('[FAIL] 解包失败 status=' + r.status); code = 2; }
      else {
        const { findings, files, oversized } = scanTree([tmp], { rules });
        console.log('[..] zip 扫描完成：' + files + ' 个文件，命中 ' + findings.length);
        reportSkips({ oversized });
        if (findings.length) { console.error(formatReport(findings)); code = 1; }
        else console.log('[OK] zip 内无邮箱/密钥信息');
      }
    } finally {
      // 审计修复：清理放在 finally，且内部不调用 process.exit（exit 不展开 JS 栈，
      // 会把临时解包目录留在 %TEMP%）
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    process.exit(code);
  }

  if (args.includes('--scrub')) {
    let s;
    try {
      s = scrubTree(scope, { rules });
    } catch (err) {
      console.error('[FAIL] 脱敏中止：' + (err && err.message ? err.message : err));
      process.exit(2);
    }
    console.log('[..] 脱敏：扫描 ' + s.files + ' 个文本文件，改写 ' + s.changed + ' 个');
    for (const h of s.hits) console.log('  - ' + h.where + ' (' + h.count + ' 处)');
    if (s.backups.length) {
      console.log('[..] 原始备份 ' + s.backups.length + ' 个（*.bak-scrub：不参与扫描/上传，确认无误后可自行删除）：');
      for (const b of s.backups) console.log('  - ' + b);
    }
    reportSkips(s);
    const after = scanTree(scope, { rules });
    if (after.findings.length) { console.error(formatReport(after.findings)); console.error('[FAIL] 仍有余留，请手动处理'); process.exit(1); }
    console.log('[OK] 已清除，复扫无残留');
    process.exit(0);
  }

  // 默认 --scan
  const { findings, files, oversized } = scanTree(scope, { rules });
  console.log('[..] 扫描 ' + scope.length + ' 个路径 / ' + files + ' 个文件，命中 ' + findings.length + (findings.length ? '（' + summarize(findings) + '）' : ''));
  reportSkips({ oversized });
  if (findings.length) { console.error(formatReport(findings)); console.error('[FAIL] 存在真实邮箱/密钥信息，已阻止发布。修复：node scripts/email-scrub.mjs --scrub'); process.exit(1); }
  console.log('[OK] 未发现真实邮箱/密钥信息');
  process.exit(0);
}
