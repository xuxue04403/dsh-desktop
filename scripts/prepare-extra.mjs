// scripts/prepare-extra.mjs — 为 electron-builder 产物准备 extraResources
//
// 【为什么需要它（2026-09-10 审计 P1）】
// `package.json` 的 build 段此前**没有 extraResources**：NSIS 安装版与单文件便携版的
// resources\ 里只有 app.asar，**没有** node_modules(npm/pnpm) 与 vendor(默认插件)。
// 而运行时按 `process.resourcesPath\node_modules\npm\bin\npm-cli.js` 与
// `process.resourcesPath\vendor\<插件>` 定位它们（src/launcher.js、src/default-plugins.js）
// —— 于是"用户机器无需安装 Node.js/npm，首次启动自动装 dsh""默认插件随包分发"这两条承诺
// 对**安装包用户**根本不成立（只有手工绿色目录版才有）。
//
// 【本脚本做什么】
// 把三份资源收集到 out\_extra\，package.json 的 extraResources 再从那里映射：
//   out\_extra\vendor                       ← out\_vendor（默认插件 vendor 源）
//   out\_extra\node_modules\npm             ← 内嵌 npm（asar 外，ELECTRON_RUN_AS_NODE 可读）
//   out\_extra\node_modules\pnpm            ← 内嵌 pnpm（dsh plugin 需要）
// 目录**总是**被创建（含缺失时的 PLACEHOLDER 说明），这样 electron-builder 不会因为
// `from` 不存在而直接构建失败；缺失项会打印醒目告警。
//
// 用法：node scripts/prepare-extra.mjs   （dist.mirror.mjs / portable.mirror.mjs 会自动调用）
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extra = path.join(root, 'out', '_extra');
const warnings = [];

function copyDir(from, to, label) {
  if (!existsSync(from)) return false;
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log('[extra] ' + label + ' ← ' + path.relative(root, from));
  return true;
}

// —— 1) 默认插件 vendor ——
const vendorFrom = path.join(root, 'out', '_vendor');
if (!copyDir(vendorFrom, path.join(extra, 'vendor'), '默认插件 vendor')) {
  warnings.push('缺少 out\\_vendor（先运行：node scripts/vendor-email-bridge.mjs）');
}

// —— 2) 内嵌 npm ——
// 顺序：项目 node_modules\npm → 已构建绿色目录的 resources\node_modules\npm
//      → 当前 node 运行时旁的 node_modules\npm（nvm/标准安装）
const npmCandidates = [
  path.join(root, 'node_modules', 'npm'),
  path.join(root, 'out', 'DSH-App', 'resources', 'node_modules', 'npm'),
  path.join(root, 'out', 'DSH-App-UAT', 'resources', 'node_modules', 'npm'),
  path.join(path.dirname(process.execPath), 'node_modules', 'npm'),
];
const npmFrom = npmCandidates.find((p) => existsSync(path.join(p, 'bin', 'npm-cli.js')));
if (npmFrom) {
  if (!copyDir(npmFrom, path.join(extra, 'node_modules', 'npm'), '内嵌 npm')) { /* 忽略 */ }
} else {
  mkdirSync(path.join(extra, 'node_modules', 'npm'), { recursive: true });
  warnings.push('未找到内嵌 npm（试过：' + npmCandidates.map((p) => path.relative(root, p)).join(' / ') + '）——安装版将回退系统 npm');
}

// —— 3) 内嵌 pnpm（dsh plugin 安装/卸载必需）——
const pnpmCandidates = [
  path.join(root, 'vendor', 'pnpm-11.8.0'),
  path.join(root, 'out', '_pnpm11', 'package'),
];
const pnpmFrom = pnpmCandidates.find((p) => existsSync(path.join(p, 'bin', 'pnpm.cjs')));
if (pnpmFrom) {
  if (!copyDir(pnpmFrom, path.join(extra, 'node_modules', 'pnpm'), '内嵌 pnpm')) { /* 忽略 */ }
} else {
  mkdirSync(path.join(extra, 'node_modules', 'pnpm'), { recursive: true });
  warnings.push('未找到内嵌 pnpm（试过：' + pnpmCandidates.map((p) => path.relative(root, p)).join(' / ') + '）——插件市场安装/卸载将失败');
}

// electron-builder 对空目录不敏感，但留个说明便于排查
writeFileSync(path.join(extra, 'README.txt'),
  'electron-builder extraResources 源目录（构建中间产物，可安全删除）。\r\n'
  + 'vendor\\            → 产物 resources\\vendor（默认插件）\r\n'
  + 'node_modules\\npm   → 产物 resources\\node_modules\\npm（内嵌 npm）\r\n'
  + 'node_modules\\pnpm  → 产物 resources\\node_modules\\pnpm（内嵌 pnpm）\r\n',
  'utf8');

const count = (p) => { try { return readdirSync(p, { withFileTypes: true }).length; } catch { return 0; } };
console.log('[extra] 汇总：vendor ' + count(path.join(extra, 'vendor'))
  + ' 项 / npm ' + count(path.join(extra, 'node_modules', 'npm'))
  + ' 项 / pnpm ' + count(path.join(extra, 'node_modules', 'pnpm')) + ' 项');
if (warnings.length) {
  console.log('');
  for (const w of warnings) console.log('[警告] ' + w);
  console.log('[警告] 安装版/便携版将缺少上述资源（绿色目录版不受影响）。');
}
