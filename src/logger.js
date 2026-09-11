// logger.js — 日志落盘（userData/logs）
//   app.log    壳自身诊断（1MB 轮转为 .prev）
//   web.log    dsh web 子进程输出（实时追加，供看门狗分析）
'use strict';

const fs = require('fs');
const path = require('path');
// 时间戳口径（时区可移植性修复）：缺省北京时间，与机器时区无关；见 timestamp.js
const { stamp, tzLabel } = require('./timestamp');

const MAX_SIZE = 1024 * 1024;

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

// dsh web 输出日志（原样追加，无时间戳前缀）
function appendWeb(text) {
  if (!text) return;
  write(webLogFile, text + '\r\n');
}

function write(file, text) {
  try {
    if (!file) return;
    const buf = Buffer.from(text, 'utf8');
    rotateIfNeeded(file, buf.length);
    fs.appendFileSync(file, buf);
    sizes.set(file, (sizes.get(file) || 0) + buf.length);
  } catch (_) { /* 忽略 */ }
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

module.exports = { init, appendLog, appendWeb, logDirPath, webLogPath, webLogSize };