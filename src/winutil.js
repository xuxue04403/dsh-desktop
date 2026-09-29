// winutil.js — Windows 平台工具（可移植性修复，2026-09-11）
//
// 背景（真实故障）：把绿色目录复制到另一台电脑后启动失败——
//   [启动进程失败: spawn C:\WINDOWS\system32\cmd.exe ENOENT]
// 根因：cmd 隐藏控制台宿主（broker）直接用了 `process.env.ComSpec`。**镜像/克隆/迁移过的
// Windows 上该环境变量常残留旧系统盘路径**（系统实际装在 D:\Windows，ComSpec 仍指向
// C:\WINDOWS\system32\cmd.exe）→ spawn 该路径 ENOENT，dsh 永远起不来。
// 这里按"存在性校验 + 多候选回退"解析 cmd.exe，解析不到就返回 null，由调用方走无 broker 的
// 直接启动路径（功能不受影响，只是少了"隐藏控制台宿主"这一层）。
//
// 第二轮审计修正（文档与实现对齐）：**实现不会返回 null** —— 最后一个候选是交给 PATH 解析的
// `'cmd.exe'`（见下方 resolveCmdExe），因此在"所有绝对路径都不存在"的机器上它仍返回一个
// 命令名而不是 null。调用方（launcher.js / market.js）里 `if (!cmdExe)` 的分支实际不可达；
// 这是刻意保留的折中：改成返回 null 会切到无 broker 的直接启动路径，反而丢掉"隐藏控制台
// 宿主"这一层（历史上弹黑窗的成因），而 spawn('cmd.exe') 真失败时调用方的 error 事件兜底
// 会正常接管。若要恢复"返回 null"的语义，必须同时确认直接启动路径的控制台隐藏能力。
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 解析可用的 cmd.exe 绝对路径（或 'cmd.exe' 交给 PATH 解析）。
 * 候选顺序：ComSpec（**须存在**）→ %SystemRoot%\System32\cmd.exe → %windir%\System32\cmd.exe
 *          → C:\Windows\System32\cmd.exe → 'cmd.exe'（PATH 兜底）
 *
 * @returns {string} 命令名/绝对路径。**保证非空**（最差是 'cmd.exe'，交由 PATH 解析）——
 *   调用方的 `if (!cmdExe)` 分支因此不可达，理由见文件头注释。
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

/**
 * 找出 env 对象里 PATH 的**实际键名**（大小写不敏感）。
 *
 * 为什么需要它（2026-09-29 实测事故）：Windows 上这个变量的名字通常是 **`Path`（混合大小写）**，
 * 而 `Object.assign({}, process.env, …)` 产出的是**普通对象**——键名大小写敏感。于是
 * `spawnEnv.PATH = …` 不是"更新原值"，而是**新建了一个 `PATH` 键**：原 `Path` 仍在对象里，
 * 但 Node 序列化环境块时按大小写不敏感去重、后设的 `PATH` 胜出 → **完整 PATH 被整个丢掉**。
 * 实测后果：应用被资源管理器（PATH 19 项）启动，它交给 dsh 的子进程只剩 2 个目录，
 * 继而使 DSH 的 shell 里 `icacls`/`robocopy`/`git`/`cmd` 全部按名字调不到
 * （实测：Explorer 侧键名 `Path` 19 项 / DSH shell 侧键名 `PATH` 3 项）。
 *
 * @param {object} env 环境对象
 * @returns {string} 现有键名；不存在时返回 'PATH'
 */
function pathKeyOf(env) {
  for (const k of Object.keys(env || {})) {
    if (k.toLowerCase() === 'path') return k;
  }
  return 'PATH';
}

/**
 * 把若干目录**前置**到 env 的 PATH（就地更新既有键，绝不新建大小写不同的重复键）。
 *
 * @param {object} env 环境对象（就地修改）
 * @param {string[]} dirs 要前置的目录（空值自动跳过）
 * @returns {string} 实际使用的键名
 */
function prependPath(env, dirs) {
  const target = env || {};
  const key = pathKeyOf(target);
  const cur = typeof target[key] === 'string' ? target[key] : '';
  const head = (dirs || []).filter((d) => d && String(d).trim()).map(String);
  const parts = head.concat(cur ? [cur] : []);
  target[key] = parts.join(path.delimiter);
  return key;
}

module.exports = { resolveCmdExe, comSpecIsStale, pathKeyOf, prependPath };
