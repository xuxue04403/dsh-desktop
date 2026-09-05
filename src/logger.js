// logger.js — 日志落盘（userData/logs）
//   app.log    壳自身诊断（1MB 轮转为 .prev）
//   web.log    dsh web 子进程输出（实时追加，供看门狗分析）
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SIZE = 1024 * 1024;

let logDir = null;
let logFile = null;
let webLogFile = null;

function init(userDataDir) {
  logDir = path.join(userDataDir, 'logs');
  logFile = path.join(logDir, 'app.log');
  webLogFile = path.join(logDir, 'web.log');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (_) { /* 忽略 */ }
}

function rotate(file) {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size > MAX_SIZE) {
      try { fs.copyFileSync(file, file + '.prev'); } catch (_) { /* 忽略 */ }
      fs.writeFileSync(file, '', 'utf8');
    }
  } catch (_) { /* 忽略 */ }
}

// 壳自身日志（带时间戳）
function appendLog(line) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  write(logFile, '[' + ts + '] ' + line + '\r\n');
}

// dsh web 输出日志（原样追加，无时间戳前缀）
function appendWeb(text) {
  if (!text) return;
  write(webLogFile, text + '\r\n');
}

function write(file, text) {
  try {
    if (!file) return;
    rotate(file);
    fs.appendFileSync(file, text, 'utf8');
  } catch (_) { /* 忽略 */ }
}

function logDirPath() {
  return logDir;
}

function webLogPath() {
  return webLogFile;
}

module.exports = { init, appendLog, appendWeb, logDirPath, webLogPath };