// renderer-guard.js — "这个 URL 是否指向本应用自带的渲染页"（v1.9.0 P0-1 安全修复）
//
// 为什么单独成模块：这是**一条安全边界**，被两处共用——
//   ① `will-navigate`：决定主窗口/设置窗是否放行一次 `file://` 导航；
//   ② IPC 守卫 `fromLocalPage`：决定一次壳级 IPC 调用是否来自本地渲染页。
// 两处必须用**同一个**判据，否则又会出现"一边收紧、一边留口"的错位。
//
// 被修掉的旧判据（两处都有）：只看"路径以 `/renderer/<名字>.html` 结尾"，
// 而 `will-navigate` 更是无条件放行任意 `file://`：
//
//     if (url.startsWith('file://')) return;                        // 任意本地文件
//     return /\/renderer\/[A-Za-z0-9._-]+\.html$/i.test(u);         // 只看后缀形态
//
// 于是磁盘上**任意位置**的 `…\renderer\anything.html` —— 解压出来的第三方样例目录、
// 用户下载目录、临时目录 —— 都能通过校验。主窗口一旦被导航到它（dsh web 页面里跑着
// 第三方插件的客户端脚本，一次 `location.href` 或 `<a>` 点击即可），该页面就拿到了
// preload 桥的全部壳级通道：
//   · `gw:action('get-config')` → **全部供应商的明文 API Key**
//   · `gw:action('save-config')` → 覆盖网关配置
//   · `mk:action('install')` → 安装任意插件（走 dsh CLI）
//   · `dsh:save-settings` / `write-dsh` / `upgrade-dsh` → 改壳与 dsh 的配置
//
// 正确判据：把 URL **解析成真实文件系统路径**，再与本应用 `renderer/` 目录做前缀比较。
'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

// Windows / macOS 的路径比较大小写不敏感；Linux 上保持精确比较（那里确实敏感）。
const PATH_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** 本应用 renderer 目录（带尾部分隔符，供前缀比较用）。 */
function defaultRoot() {
  return path.join(__dirname, '..', 'renderer');
}

/**
 * 判断 URL 是否指向本应用自带的渲染页。
 *
 * fail-closed：任何解析失败（非 `file://`、非法 URL、空值）都返回 false。
 *
 * @param {string} u - 待判定 URL，通常形如 `file:///D:/app/renderer/status.html`。
 * @param {string} [rootDir] - 覆盖 renderer 根目录（单测注入用）。
 * @returns {boolean} true 仅当它是 rootDir 下的 `.html` 文件。
 */
function isAppRendererPage(u, rootDir) {
  // 尾部分隔符是关键：没有它，同级的 `renderer-evil\` 目录会被 startsWith 误命中。
  const root = path.resolve(rootDir || defaultRoot()) + path.sep;
  try {
    // fileURLToPath 正确处理 Windows 盘符（file:///D:/x → D:\x）、百分号转义与 UNC 路径；
    // 非 file:// 协议（http/https/自定义 scheme）会抛 TypeError → 落到 catch。
    const full = path.resolve(fileURLToPath(String(u || '')));
    const cmpFull = PATH_CASE_INSENSITIVE ? full.toLowerCase() : full;
    const cmpRoot = PATH_CASE_INSENSITIVE ? root.toLowerCase() : root;
    return cmpFull.startsWith(cmpRoot) && /\.html$/i.test(full);
  } catch (_) {
    return false;
  }
}

module.exports = { isAppRendererPage, defaultRoot, PATH_CASE_INSENSITIVE };
