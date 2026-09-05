// scripts/set-exe-icon.cjs — 一键把 DSH-App.exe 的图标替换为品牌徽标（与托盘/窗口一致）
//
// 用法（本机无沙箱限制的环境）：
//   npm i -D rcedit                # 首次：安装图标替换工具（内部为预编译二进制，需在普通环境安装）
//   node scripts/set-exe-icon.cjs  # 替换 out/DSH-App/DSH-App.exe 的图标
//
// 说明：修改 exe 的 PE 资源需要 rcedit 工具（electron-builder 同款），本文件只做调用封装。
// 替换后重启 DSH-App 即可看到资源管理器/任务栏/托盘（图案）统一为品牌徽标。
'use strict';

const fs = require('fs');
const path = require('path');
const { iconIcoBuffer, COLORS } = require('../src/icon');

const root = path.resolve(__dirname, '..');
const icoPath = path.join(root, 'assets', 'icon.ico');
// 目标 exe：环境变量 DSH_APP_EXE 优先（发布脚本指向新构建的绿色目录），默认 out/DSH-App/DSH-App.exe
const exePath = process.env.DSH_APP_EXE || path.join(root, 'out', 'DSH-App', 'DSH-App.exe');

async function main() {
  // 1) 生成 icon.ico（16/32/256 多尺寸）
  fs.mkdirSync(path.dirname(icoPath), { recursive: true });
  fs.writeFileSync(icoPath, iconIcoBuffer(COLORS.brand));
  console.log('[OK] 已生成 ' + icoPath);

  // 2) 定位 rcedit（兼容多种导出形态：函数 / ESM namespace 命名导出 / default / editExe）
  let mod = null;
  try {
    mod = require('rcedit');
  } catch (_) { /* 下面统一报错 */ }
  const rcedit = typeof mod === 'function' ? mod
    : (mod && typeof mod.rcedit === 'function') ? mod.rcedit        // rcedit 5.x（ESM 命名导出）
    : (mod && typeof mod.default === 'function') ? mod.default
    : (mod && typeof mod.editExe === 'function') ? mod.editExe
    : null;
  if (!rcedit) {
    console.error('[错误] 无法识别 rcedit 模块的导出形式（typeof=' + typeof mod
      + (mod ? ', keys=' + Object.keys(mod).join(',') : '') + '）。请安装兼容版本：npm i -D rcedit@^3');
    process.exit(1);
  }
  if (!fs.existsSync(exePath)) {
    console.error('[错误] 找不到 ' + exePath + '。请先运行：node scripts/build-portable.mjs');
    process.exit(1);
  }

  // 3) 替换图标
  await rcedit(exePath, { icon: icoPath });
  console.log('[OK] 已替换图标: ' + exePath);
  console.log('     重启 DSH-App 后，资源管理器/任务栏/exe 图标即为品牌徽标（托盘按状态变色保持）。');
}

main().catch((err) => {
  console.error('[错误] ' + (err && err.message ? err.message : err));
  process.exit(1);
});