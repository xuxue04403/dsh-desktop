// winutil.js — Windows 平台工具（可移植性修复，2026-09-11）
//
// 背景（真实故障）：把绿色目录复制到另一台电脑后启动失败——
//   [启动进程失败: spawn C:\WINDOWS\system32\cmd.exe ENOENT]
// 根因：cmd 隐藏控制台宿主（broker）直接用了 `process.env.ComSpec`。**镜像/克隆/迁移过的
// Windows 上该环境变量常残留旧系统盘路径**（系统实际装在 D:\Windows，ComSpec 仍指向
// C:\WINDOWS\system32\cmd.exe）→ spawn 该路径 ENOENT，dsh 永远起不来。
// 这里按"存在性校验 + 多候选回退"解析 cmd.exe，解析不到就返回 null，由调用方走无 broker 的
// 直接启动路径（功能不受影响，只是少了"隐藏控制台宿主"这一层）。
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 解析可用的 cmd.exe 绝对路径（或 'cmd.exe' 交给 PATH 解析）；都没有则返回 null。
 * 候选顺序：ComSpec（**须存在**）→ %SystemRoot%\System32\cmd.exe → %windir%\System32\cmd.exe
 *          → C:\Windows\System32\cmd.exe → 'cmd.exe'（PATH 兜底）
 */
function resolveCmdExe() {
  const cands = [];
  const com = String(process.env.ComSpec || '').trim();
  if (com) cands.push(com);
  for (const root of [process.env.SystemRoot, process.env.windir, 'C:\\Windows']) {
    const r = String(root || '').trim();
    if (r) cands.push(path.join(r, 'System32', 'cmd.exe'));
  }
  const seen = new Set();
  for (const c of cands) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.existsSync(c)) return c;      // 真实存在的绝对路径：最可靠
    } catch (_) { /* 忽略：无权限/路径畸形 */ }
  }
  // 全部候选都不存在：交给 PATH 解析（spawn('cmd.exe') 会走 CreateProcess 的搜索路径）。
  // 这一步在"系统盘不在 C: 且环境变量也坏掉"的机器上仍可能成功。
  return 'cmd.exe';
}

/**
 * 反向用例（测试/诊断用）：ComSpec 是否指向一个**不存在**的可执行文件。
 * 为真说明该机器的环境变量是坏的（典型：从别的机器克隆而来），日志里值得记一笔。
 */
function comSpecIsStale() {
  const com = String(process.env.ComSpec || '').trim();
  if (!com) return false;
  try { return !fs.existsSync(com); } catch (_) { return true; }
}

module.exports = { resolveCmdExe, comSpecIsStale };
