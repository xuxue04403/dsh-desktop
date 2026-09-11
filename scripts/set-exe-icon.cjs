// scripts/set-exe-icon.cjs — 一键把 DSH-App.exe 的图标替换为品牌徽标（与托盘/窗口一致）
//
// 用法（本机无沙箱限制的环境）：
//   npm i -D rcedit                # 首次：安装图标替换工具（内部为预编译二进制，需在普通环境安装）
//   node scripts/set-exe-icon.cjs  # 替换 out/DSH-App/DSH-App.exe 的图标
//   环境变量：DSH_APP_EXE 指定目标 exe；DSH_ICON_ICO 指定生成的 ico 输出路径
//
// 说明：修改 exe 的 PE 资源需要 rcedit 工具（electron-builder 同款），本文件只做调用封装。
// 替换后重启 DSH-App 即可看到资源管理器/任务栏/托盘（图案）统一为品牌徽标。
//
// 审计修复（P2，2026-09-10）：
//   ① 默认目标不再写死 out/DSH-App/DSH-App.exe —— build-portable 在目录被占用时会回退到
//      out/DSH-App-v<version>，旧版会直接报"找不到 exe"。现在自动探测存在的那个。
//   ② rcedit 就地改 PE 无备份 → 先写 <exe>.bak（已存在则不覆盖，保留最原始的那份），
//      替换失败/结果异常时立即用备份恢复原文件。
//   ③ 生成的 icon.ico 改写到构建目录 out/_icon/（不再污染源码树 assets/，
//      那是会被当源码上传到 GitHub 的路径，且与 build-portable/build-uat 抢同一路径）。
'use strict';

const fs = require('fs');
const path = require('path');
const { iconIcoBuffer, COLORS } = require('../src/icon');

const root = path.resolve(__dirname, '..');
const icoPath = process.env.DSH_ICON_ICO || path.join(root, 'out', '_icon', 'icon.ico');
// 目标 exe：环境变量 DSH_APP_EXE 优先；否则自动探测构建脚本可能产出的目录
function detectExe() {
  if (process.env.DSH_APP_EXE) return process.env.DSH_APP_EXE;
  const outDir = path.join(root, 'out');
  const cands = [path.join(outDir, 'DSH-App', 'DSH-App.exe')];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    cands.push(path.join(outDir, 'DSH-App-v' + pkg.version, 'DSH-App.exe'));
  } catch (_) { /* package.json 不可读时忽略 */ }
  try {
    for (const e of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (e.isDirectory() && /^DSH-App-v/i.test(e.name)) cands.push(path.join(outDir, e.name, 'DSH-App.exe'));
    }
  } catch (_) { /* 无 out 目录 */ }
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* 试下一个 */ }
  }
  return cands[0];   // 都不存在：返回默认路径，由调用方给出明确报错
}
const exePath = detectExe();

async function main() {
  // 1) 生成 icon.ico（16/32/256 多尺寸）→ 写到构建目录，不写源码树 assets/
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
    console.error('       也可用环境变量 DSH_APP_EXE 指向目标 exe（如 out\\DSH-App-v<version>\\DSH-App.exe）。');
    process.exit(1);
  }

  // 3) 备份 + 替换（审计修复 P2：就地改 PE 无备份 → 失败即恢复原文件）
  const bakPath = exePath + '.bak';
  const sizeBefore = fs.statSync(exePath).size;
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(exePath, bakPath);
    console.log('[OK] 已备份原始 exe → ' + bakPath + '（已存在则不覆盖，保留最原始的那份）');
  } else {
    console.log('[..] 备份已存在，沿用：' + bakPath);
  }
  const restore = (why) => {
    try {
      fs.copyFileSync(bakPath, exePath);
      console.log('[恢复] ' + why + ' —— 已用备份还原 ' + exePath);
    } catch (err) {
      console.error('[错误] 还原失败（请手工把 ' + bakPath + ' 复制回 ' + exePath + '）：'
        + (err && err.message ? err.message : err));
    }
  };
  try {
    await rcedit(exePath, { icon: icoPath });
    // rcedit 偶发"退出码 0 但文件损坏/被截断"：补一次结果校验
    const st = fs.statSync(exePath);
    if (!st.isFile() || st.size <= 0 || st.size < sizeBefore * 0.5) {
      throw new Error('rcedit 结果异常（大小 ' + st.size + ' 字节，替换前 ' + sizeBefore + ' 字节）');
    }
  } catch (err) {
    restore('替换失败：' + (err && err.message ? err.message : err));
    throw err;
  }
  console.log('[OK] 已替换图标: ' + exePath);
  console.log('     重启 DSH-App 后，资源管理器/任务栏/exe 图标即为品牌徽标（托盘按状态变色保持）。');
}

main().catch((err) => {
  console.error('[错误] ' + (err && err.message ? err.message : err));
  process.exit(1);
});
