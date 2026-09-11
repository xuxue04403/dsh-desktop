// paths.js — 路径可用性工具（可移植性修复，2026-09-11）
//
// 背景（真实故障）：绿色目录整体复制到另一台电脑后，`data\settings.json` 里仍带着**旧机器**
// 的绝对路径（如 workDir=C:\Users\alice，而新机器用户是 C:\Users\bob）。该路径不存在时：
//   * launcher 以它为 spawn 的 cwd → spawn 异步报 ENOENT，dsh 永远起不来（只剩空白窗口）；
//   * watchdog 的 spawnSync 直接抛错 → 安全模式判定降级。
// 这里统一提供"路径不可用就回退"的工具，供 settings / launcher / watchdog 共用。
'use strict';

const fs = require('fs');
const os = require('os');

/** 目录是否真实可用（存在且确实是目录） */
function dirUsable(p) {
  if (!p || typeof p !== 'string') return false;
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

/**
 * 取可用的工作目录：优先传入值，不可用则回退用户主目录。
 * @param {string} p 期望目录（可能来自别的机器）
 * @param {(bad:string, fallback:string)=>void} [onFallback] 发生回退时的回调（写日志用）
 * @returns {string} 一定存在的目录
 */
function workDirOrHome(p, onFallback) {
  if (dirUsable(p)) return p;
  const home = os.homedir();
  if (p && typeof onFallback === 'function') onFallback(p, home);
  return dirUsable(home) ? home : process.cwd();
}

module.exports = { dirUsable, workDirOrHome };
