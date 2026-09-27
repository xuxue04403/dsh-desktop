// fs-safe.js — 对 junction / symlink 安全的删除（共享工具）
//
// 为什么需要它：`fs.rmSync(p, { recursive: true })` 在 Windows 上会**穿透 junction**
// 删掉链接目标里的真实内容。本应用的 profile / node_modules 里存在大量 junction
//（pnpm 布局、default-plugins 的 linkMissingHostPackages 建的 @deepseek-ai/*），
// 而删除目标经常是"插件目录"这类看起来无害的位置——一旦穿透，删掉的是**宿主包**。
// 另外 Electron 内置 node 的 rmSync 对 junction 会直接报 ERR_FS_EISDIR。
//
// 原实现长在 default-plugins.js 里（那里只处理 profile 目录）。plugin-snapshot 的
// copyTree / 随包清理同样要删目录，却用的是裸 `fs.rmSync(recursive)`。与其复制两份
// 逻辑（必然漂移），不如提到这里，两处共用。
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 删除路径（junction / symlink 安全版）。
 *
 * 规则：
 *   · 目标本身是链接 → unlink（绝不 recursive，否则删的是目标内容）；
 *   · 目标是真实目录 → **先递归摘掉树内所有链接**，再 rmSync(recursive)。
 *     只摘链接不打洞：真实子目录照常被删除，链接指向的外部内容保持不动。
 *   · 路径不存在 / 无权限 → 静默返回（调用方多为清理路径，不应因此中断主流程）。
 *
 * @param {string} p - 待删除路径。
 */
function removePath(p) {
  let st = null;
  try { st = fs.lstatSync(p); } catch (_) { return; }   // 不存在 → 无事可做
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(p); return; } catch (_) { /* 尝试 rmdir 兜底 */ }
    try { fs.rmdirSync(p); } catch (_) { /* 忽略 */ }
    return;
  }
  if (st.isDirectory()) {
    const stripLinks = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const child = path.join(dir, e.name);
        let cst = null;
        try { cst = fs.lstatSync(child); } catch (_) { continue; }
        if (cst.isSymbolicLink()) {
          try { fs.unlinkSync(child); } catch (_) { /* 忽略 */ }
        } else if (cst.isDirectory()) {
          stripLinks(child);
        }
      }
    };
    stripLinks(p);
  }
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * 递归复制目录（dereference: false —— 链接按链接复制，不把目标内容拽进来）。
 * 目标已存在时先走 {@link removePath}，避免 rmSync 穿透 junction。
 *
 * @param {string} src - 源目录。
 * @param {string} dst - 目标目录。
 */
function copyTreeSafe(src, dst) {
  removePath(dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true, dereference: false, errorOnExist: false });
}

module.exports = { removePath, copyTreeSafe };
