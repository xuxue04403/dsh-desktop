// crash-report.js — 致命错误现场落盘（v1.9.0 新增）
//
// 设计来源：官方 DeepSeek Harness Desktop 的 crash-report.ts 在打开致命对话框之前，
// 先把完整现场写一份 `crash-<时间>-<来源>.log` 到日志目录并只保留最近 10 份。
// DSH-App 是**进程外薄宿主**，现场散在四处：壳主进程、渲染进程、dsh web 子进程、
// 网关子进程；而本应用的典型使用方式是绿色目录换机——出问题时用户往往已经在**另一台
// 电脑**上，只剩日志可查。app.log 是滚动流水（1MB 轮转），事故现场会被后续输出冲掉，
// 因此这里为每类致命事件固化一份**独立、可整体拷走**的报告。
//
// 与官方实现的取舍差异（都是刻意的）：
//   · 官方写 `app.getPath('logs')`；本应用一切随绿色目录走，故写 userData/logs（与 logger 同处）。
//   · 官方等待写盘至多 1 秒后弹框；本应用不在错误路径上弹框（R22：壳不因偶发异常退出），
//     故只落盘 + 在 app.log 留一行指针。
//   · 官方直接写 Host stderr 尾部；本应用对全文做**基础脱敏**——错误栈与子进程输出里
//     可能夹带 API Key / Bearer 令牌，而这份文件会被用户主动拷去另一台机器排查。
'use strict';

const fs = require('fs');
const path = require('path');
const { stamp, tzLabel } = require('./timestamp');

const CRASH_PREFIX = 'crash-';
const CRASH_SUFFIX = '.log';
const MAX_KEEP = 10;                 // 保留份数（官方同口径）
const MAX_BYTES = 256 * 1024;        // 单份上限；超长栈/子进程输出截断，避免日志目录被撑爆
const MAX_TAIL_LINES = 120;          // 子进程输出只留尾部若干行

let crashDir = null;

/**
 * 定位崩溃报告目录（与 logger 同一个 logs 目录）。
 * @param {string} logDir - logger.logDirPath() 的结果。
 */
function init(logDir) {
  crashDir = logDir || null;
}

/** 目录是否可用（未 init 或目录不可写时全部接口静默降级）。 */
function ready() {
  return !!crashDir;
}

// ---------------- 脱敏 ----------------
// 这份文件会被用户拷到别的机器排查，不能把凭据一起带走。规则刻意保守：只处理
// "几乎不可能是正常文本"的形态，宁可漏一点，也不要把堆栈/路径改得认不出来。
const REDACTIONS = [
  // 各家的 sk- 形态密钥（含 Cline 的 sk_ 变体）
  [/\bsk[-_][A-Za-z0-9_-]{8,}/g, 'sk-[redacted]'],
  // Bearer / Basic 凭据
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // 赋值形态：apiKey / token / secret / password 后面跟的长串
  [/((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd)\s*[:=]\s*)(["']?)([A-Za-z0-9._~+/=-]{12,})\2/gi, '$1$2[redacted]$2'],
  // 环境变量形态：DSH_GATEWAY_API_KEY=xxxx
  [/(DSH_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(\S{8,})/g, '$1[redacted]'],
  // 长十六进制串（64 位 hex key 等）。正常堆栈/路径里极少出现连续 32 位以上纯 hex。
  [/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-hex]'],
];

/**
 * 对文本做基础脱敏。
 * @param {string} text - 原始文本。
 * @returns {string} 脱敏后的文本。
 */
function redact(text) {
  let out = String(text == null ? '' : text);
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

// ---------------- 序列化 ----------------

/**
 * 把任意值渲染成可读文本（错误保留完整栈与 cause 链）。
 * @param {unknown} value - 待渲染的值。
 * @param {number} [depth] - 剩余递归层数。
 * @returns {string} 文本形式。
 */
function render(value, depth) {
  const d = depth === undefined ? 3 : depth;
  if (value == null) return String(value);
  if (value instanceof Error) {
    const parts = [value.stack || (value.name + ': ' + value.message)];
    // cause 链：包装过的错误只看外层会丢掉真正的成因
    let cause = value.cause;
    let guard = 0;
    while (cause && guard++ < 5) {
      parts.push('  [cause] ' + (cause instanceof Error ? (cause.stack || cause.message) : render(cause, d - 1)));
      cause = cause && cause.cause;
    }
    // 错误对象上的自有可枚举属性（如 Node 的 code/errno/syscall）
    try {
      const own = Object.keys(value).filter((k) => !['stack', 'message', 'cause'].includes(k));
      if (own.length) {
        parts.push('  [props] ' + own.map((k) => k + '=' + render(value[k], d - 1)).join(' '));
      }
    } catch (_) { /* 忽略：取属性失败不影响主栈 */ }
    return parts.join('\n');
  }
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  if (d <= 0) return '[Object]';
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return '[unserializable]';
  }
}

/**
 * 文件名安全的时间戳：`20260925-083012-345`（stamp() 是 `2026-09-25 08:30:12`）。
 * 带毫秒是为了让"同一秒内先后发生的两个不同故障"各留一份，而不是互相覆盖。
 */
function fileStamp() {
  const ms = String(new Date().getMilliseconds()).padStart(3, '0');
  return stamp().replace(/[-:]/g, '').replace(' ', '-') + '-' + ms;
}

/** 只保留尾部若干行（子进程输出前段通常无关，尾部才是崩溃原因）。 */
function tail(text, lines) {
  const all = String(text || '').split(/\r?\n/);
  if (all.length <= lines) return all.join('\n');
  return '…（前 ' + (all.length - lines) + ' 行已省略）\n' + all.slice(-lines).join('\n');
}

/**
 * 取一个未被占用的文件名。
 *
 * 同一毫秒内可能连写多份（例如一次异常引发连串记录，或测试里循环调用）；
 * 若直接覆盖，被冲掉的那份恰恰可能是最原始的那次故障。撞名就加序号。
 *
 * @param {string} base - 期望的文件全路径。
 * @returns {string} 实际可写的全路径。
 */
function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  const stem = base.slice(0, base.length - CRASH_SUFFIX.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = stem + '-' + n + CRASH_SUFFIX;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return stem + '-' + Date.now() + CRASH_SUFFIX;
}

// ---------------- 写盘 ----------------

/**
 * 写一份崩溃报告。
 *
 * 自身绝不抛异常，也绝不阻塞：所有失败都被吞掉（崩溃路径上再抛错只会掩盖原始故障），
 * 调用方用返回值判断是否落盘成功。
 *
 * @param {string} source - 来源标签：main | renderer | web | gateway。
 * @param {unknown} error - 触发本次报告的错误（可为 null）。
 * @param {object} [extra] - 附加现场：{ phase, version, electron, node, port, service, stdoutTail, context }。
 * @returns {string|null} 写入的文件路径；未初始化或写失败时为 null。
 */
function record(source, error, extra) {
  if (!crashDir) return null;
  const info = extra || {};
  const at = stamp();
  const file = path.join(crashDir, CRASH_PREFIX + fileStamp() + '-' + String(source || 'unknown') + CRASH_SUFFIX);

  const lines = [];
  lines.push('=== DSH-App 崩溃报告 ===');
  lines.push('时间        : ' + at + '  (' + tzLabel() + ')');
  lines.push('来源        : ' + String(source || 'unknown'));
  if (info.phase) lines.push('阶段        : ' + info.phase);
  if (info.version) lines.push('应用版本    : ' + info.version);
  if (info.electron) lines.push('Electron    : ' + info.electron);
  if (info.node) lines.push('Node        : ' + info.node);
  if (info.platform) lines.push('平台        : ' + info.platform);
  if (info.port) lines.push('服务端口    : ' + info.port);
  if (info.service) lines.push('服务状态    : ' + info.service);
  if (info.dataDir) lines.push('数据目录    : ' + info.dataDir);
  if (info.uptimeMs !== undefined) lines.push('已运行      : ' + Math.round(info.uptimeMs / 1000) + ' 秒');
  lines.push('');
  lines.push('--- 错误 ---');
  lines.push(render(error));
  if (info.stdoutTail) {
    lines.push('');
    lines.push('--- 子进程输出（尾部） ---');
    lines.push(tail(info.stdoutTail, MAX_TAIL_LINES));
  }
  if (info.context) {
    lines.push('');
    lines.push('--- 附加现场 ---');
    lines.push(render(info.context));
  }
  lines.push('');
  lines.push('提示：本文件已对疑似密钥做基础脱敏；如需随绿色目录换机，可整体拷走 logs\\ 下的 crash-*.log。');
  lines.push('');

  let text = redact(lines.join('\r\n'));
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    text = text.slice(0, MAX_BYTES) + '\r\n…（超过 ' + Math.round(MAX_BYTES / 1024) + 'KB，已截断）\r\n';
  }

  try {
    fs.mkdirSync(crashDir, { recursive: true });
    const target = uniquePath(file);
    fs.writeFileSync(target, text, 'utf8');
    // 每写一份就顺带清理：反复崩溃的进程（例如看门狗反复重启的 dsh）不会把 logs\ 堆满。
    prune();
    return target;
  } catch (_) {
    return null;   // 崩溃路径上不抛：写不下去就只留 app.log 的那行指针
  }
}

/**
 * 清理旧报告，只保留最近 {@link MAX_KEEP} 份。
 *
 * 只删本模块自己产出的 `crash-*.log`（不碰目录里的其它文件）。
 *
 * P1（二次复核修复）：**按 mtime 排序，不再按文件名排序**。旧实现依赖"字典序即时间序"，
 * 但同毫秒撞名时 uniquePath 加的是 `-2 / -10` 后缀，字典序里 `'2' > '1'` 使 `-10` 排在
 * `-2` **之前**；而且不带后缀的第一份（`…-345-main.log`）排在同毫秒全部分片**之后**。
 * 结果是把**更新的**报告当成"最旧"删掉——恰好丢掉最原始那次故障，与该模块的设计初衷相反。
 *
 * @returns {number} 删除的份数。
 */
function prune() {
  if (!crashDir) return 0;
  try {
    const names = fs.readdirSync(crashDir)
      .filter((n) => n.startsWith(CRASH_PREFIX) && n.endsWith(CRASH_SUFFIX));
    if (names.length <= MAX_KEEP) return 0;
    const entries = [];
    for (const n of names) {
      try { entries.push({ n, t: fs.statSync(path.join(crashDir, n)).mtimeMs }); } catch (_) { /* 单个取不到 → 跳过 */ }
    }
    entries.sort((a, b) => a.t - b.t);   // 旧 → 新
    const excess = entries.length - MAX_KEEP;
    if (excess <= 0) return 0;
    let removed = 0;
    for (const e of entries.slice(0, excess)) {
      try { fs.rmSync(path.join(crashDir, e.n), { force: true }); removed++; } catch (_) { /* 忽略 */ }
    }
    return removed;
  } catch (_) {
    return 0;
  }
}

/** 列出已有报告（新→旧），供诊断界面/日志展示。 */
function list() {
  if (!crashDir) return [];
  try {
    return fs.readdirSync(crashDir)
      .filter((n) => n.startsWith(CRASH_PREFIX) && n.endsWith(CRASH_SUFFIX))
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
}

module.exports = { init, ready, record, prune, list, redact, MAX_KEEP };
