// logger.js — 日志落盘（userData/logs）
//   app.log    壳自身诊断（1MB 轮转为 .prev）
//   web.log    dsh web 子进程输出（实时追加，供看门狗分析）
'use strict';

const fs = require('fs');
const path = require('path');
// 时间戳口径（时区可移植性修复）：缺省北京时间，与机器时区无关；见 timestamp.js
const { stamp, tzLabel } = require('./timestamp');

const MAX_SIZE = 1024 * 1024;

// 日志脱敏（P1 二次复核修复）。
//
// 旧实现把文本**原文**落盘，而这个应用把 dsh 子进程 stdout/stderr 全量喂进 web.log——
// 其中包含就绪行 `dsh web: http://127.0.0.1:<port>/?token=<启动令牌>`（launcher.REGEX_URL_LINE
// 解析的那行），以及插件/子进程打印的配置（可能含供应商 Key、邮箱密码）。慢启动时
// main.logSlowBootDetails 还会把 web.log 尾部**抄进 app.log**，而 app.log 正是"用户随手贴出来
// 求助"的文件；整个 logs\ 目录又会随绿色目录被拷到别的机器。
//
// crash-report 早已有脱敏规则（因为它同样会被拷走），这里复用它，避免两套规则各自漂移。
// 取不到就退化为不脱敏——绝不因日志组件的缺失影响主流程。
// 注意：write() 的 try/catch 会吞掉一切异常，所以这里的 redact **必须**保证可用且不抛错，
// 否则表现为"日志静默停止"（比泄漏更难排查）。
let redact = (s) => s;
try {
  const cr = require('./crash-report');
  if (cr && typeof cr.redact === 'function') redact = cr.redact;
} catch (_) { /* 忽略：退化为不脱敏 */ }

let logDir = null;
let logFile = null;
let webLogFile = null;
// 各文件已知字节数（审计修复）：旧实现每次写入都 existsSync + statSync——同步 IO 且落在
// dsh stdout 高频输出路径上。改为内存记账，仅首次/异常回退到 fs 探测。
const sizes = new Map();

function init(userDataDir) {
  logDir = path.join(userDataDir, 'logs');
  logFile = path.join(logDir, 'app.log');
  webLogFile = path.join(logDir, 'web.log');
  sizes.clear();
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (_) { /* 忽略 */ }
  // 时间口径写在每次启动的第一行：事后核对"日志时间是什么时区"不必再猜
  appendLog('日志时间口径：' + tzLabel() + (process.env.DSH_LOG_TZ ? '（DSH_LOG_TZ=' + process.env.DSH_LOG_TZ + '）' : '（缺省北京时间；DSH_LOG_TZ=local 可跟随系统时区）'));
}

// 轮转：**rename 到 .prev**（原子、不复制、不丢历史）。
// 审计修复：旧实现是 copyFileSync 到 .prev 再 writeFileSync 清空——既整文件复制，又可能
// "复制成功但清空失败"造成不一致，且被清空的那段历史在崩溃时彻底丢失。
// 与看门狗的基线切分兼容：轮转后文件尺寸归零，watchdog 会视为"整文件都是新内容"。
function rotateIfNeeded(file, incoming) {
  try {
    let size = sizes.get(file);
    if (size === undefined) {
      try { size = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch (_) { size = 0; }
    }
    if (size + incoming <= MAX_SIZE) { sizes.set(file, size); return; }
    try {
      fs.renameSync(file, file + '.prev');
    } catch (_) {
      try {
        fs.rmSync(file + '.prev', { force: true });
        fs.renameSync(file, file + '.prev');
      } catch (_) {
        try { fs.writeFileSync(file, '', 'utf8'); } catch (_) { /* 忽略 */ }
      }
    }
    sizes.set(file, 0);
  } catch (_) { /* 轮转失败不影响写入 */ }
}

// 壳自身日志（带时间戳）。
// 审计/可移植性修复（2026-09-11）：旧版 `new Date().toISOString()` 是 **UTC**——在时区为
// UTC 的机器（镜像/克隆的 Windows 很常见）上，日志比北京时间早 8 小时，排查时序会误导。
// 现在统一走 timestamp.js：缺省北京时间（UTC+8），可用 DSH_LOG_TZ 覆盖。
function appendLog(line) {
  write(logFile, '[' + stamp() + '] ' + line + '\r\n');
}

// dsh web 输出日志（逐行加时间戳前缀，2026-09-22 用户要求）
//
// 背景：web.log 是 dsh 子进程 stdout/stderr 的直通，**原来没有任何时间信息**。
// 2026-09-22 新电脑启动故障排查时，无法判断崩溃发生在哪一次启动、距启动多久、
// 与 app.log 里的事件谁先谁后——只能靠猜。现在每行前缀 `[YYYY-MM-DD HH:mm:ss] `，
// 与 app.log 同一时间口径（timestamp.js，缺省北京时间）。
//
// 关键约束（不能踩的坑）：
//   · **看门狗按行解析**这份日志（parseFailedPlugins / classifyDidNotActivate）——
//     解析侧会先剥掉时间戳前缀（watchdog.js 的 stripLogStamp），否则条目名会被污染。
//   · stdout 的 chunk **不保证按行切**：一个 chunk 可能是半行，也可能含多行。
//     做法是"整行立即落盘 + 半行暂存"：只有见到 \n 才认为一行结束并补时间戳；
//     暂存段若在 FLUSH_IDLE_MS 内没有后续数据（说明那就是一整行、只是没带换行），
//     就按行补时间戳落盘。这样既不把堆栈打成一堆时间戳，也不会把完整行误当续行。
const FLUSH_IDLE_MS = 250;
let webPending = '';        // 未见到 \n 的暂存段
let webFlushTimer = null;

function flushWebPending() {
  if (webFlushTimer) { clearTimeout(webFlushTimer); webFlushTimer = null; }
  if (!webPending) return;
  const line = webPending;
  webPending = '';
  write(webLogFile, '[' + stamp() + '] ' + line + '\r\n');
}

function appendWeb(text) {
  if (!text) return;
  const s = String(text).replace(/\r\n/g, '\n');
  const parts = s.split('\n');
  // 最后一段：文本以 \n 结尾时它是空串（行已结束），否则是待续的半行
  const tail = parts.pop();
  for (const line of parts) {
    const full = webPending + line;
    webPending = '';
    write(webLogFile, '[' + stamp() + '] ' + full + '\r\n');
  }
  if (tail) {
    webPending += tail;
    if (webFlushTimer) clearTimeout(webFlushTimer);
    webFlushTimer = setTimeout(flushWebPending, FLUSH_IDLE_MS);
    if (webFlushTimer.unref) webFlushTimer.unref();
  }
}

// 进程退出/切换时把暂存段落盘（否则最后一行永远留在内存里）
function flushWebNow() {
  flushWebPending();
}

function write(file, text) {
  try {
    if (!file) return;
    // P1：落盘前统一脱敏（app.log 与 web.log 同一条路径，不存在漏网的出口）。
    // 脱敏自身失败时退回原文——**宁可记下原文，也不能因为脱敏而丢日志**。
    let safe = text;
    try { safe = redact(text); } catch (_) { safe = text; }
    const buf = Buffer.from(safe, 'utf8');
    rotateIfNeeded(file, buf.length);
    fs.appendFileSync(file, buf);
    sizes.set(file, (sizes.get(file) || 0) + buf.length);
  } catch (_) { /* 忽略 */ }
}

// 每次 dsh 启动前：把上次残留的暂存段落盘并清空（新进程应从头开始记）。
function resetWebLineState() {
  flushWebPending();
}

function logDirPath() {
  return logDir;
}

function webLogPath() {
  return webLogFile;
}

// web.log 当前字节数（看门狗"本次启动之后"基线切分用；文件不存在/未初始化 → 0）
function webLogSize() {
  try {
    if (!webLogFile) return 0;
    if (!fs.existsSync(webLogFile)) return 0;
    return fs.statSync(webLogFile).size;
  } catch (_) { return 0; }
}

module.exports = {
  init, appendLog, appendWeb, resetWebLineState, flushWebNow, logDirPath, webLogPath, webLogSize,
};