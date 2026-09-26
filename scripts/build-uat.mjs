// build-uat.mjs — UAT 构建入口：把当前源码构建到 out/DSH-App-UAT（验证环境）
// 用法：node scripts/build-uat.mjs
// 规范：开发在 DSH-App（主目录）→ 修改完成后构建到 DSH-App-UAT 验证 → 验证无误
// 由 build-portable.mjs 默认流程（或 release.ps1）发布为 DSH-App / DSH-App-vX.Y.Z。
import { createPackage } from '@electron/asar';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const appDir = path.join(outDir, 'DSH-App-UAT');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');

// UAT 目录独立清理（与开发目录 DSH-App 互不干扰；若被 UAT 实例占用则报错退出）
// R24（2026-09-10 事故）：构建**绝不销毁 UAT 用户数据**——data\（网关配置/设置/输入
// 历史/已装 dsh/市场数据）先暂存到 out\_uat-data-backup，构建完成后还原。此前整目录
// rmSync 会把 data\ 一起删掉，UAT 一重启配置全丢（还被旧桌面助手配置迁移污染）。
// R25（审计加固）：暂存失败**立即中止**（旧版仅警告继续 → rmSync 照删 → 数据全丢）；
// 旧备份只在新备份**完整写入后**才删除；data\ 不存在而备份存在时以备份为数据源；
// 构建主体 try/finally 保证还原。
const dataDir = path.join(appDir, 'data');
const dataBackup = path.join(outDir, '_uat-data-backup');
let hadData = false;
if (existsSync(dataDir)) {
  const staging = path.join(outDir, '_uat-data-backup-staging');
  rmSync(staging, { recursive: true, force: true });
  cpSync(dataDir, staging, { recursive: true });   // 失败直接抛出 → 中止（不删 data）
  rmSync(dataBackup, { recursive: true, force: true });   // 新备份完整后才清旧备份
  renameSync(staging, dataBackup);
  hadData = true;
  console.log('[数据保留] 已暂存 UAT data\\（构建后还原）');
} else if (existsSync(dataBackup)) {
  // data\ 不存在但备份在（上次构建中断）→ 以备份为数据源，避免用半删的 dataDir 覆盖
  hadData = true;
  console.log('[数据保留] data\\ 缺失，使用上次构建备份作为数据源');
}
function restoreUatData() {
  if (!hadData) return;
  try {
    if (existsSync(dataBackup)) {
      cpSync(dataBackup, path.join(appDir, 'data'), { recursive: true });
      rmSync(dataBackup, { recursive: true, force: true });
      console.log('[数据保留] UAT data\\ 已还原（网关配置/设置/历史不丢）');
    }
  } catch (err) {
    console.log('[警告] data\\ 还原失败（' + (err && err.message ? err.message : err) + '）——备份在 ' + dataBackup + '，可手动复制。');
  }
}
try {
  rmSync(appDir, { recursive: true, force: true });
} catch (err) {
  if (err.code === 'EBUSY' || err.code === 'EPERM') {
    // 审计修复（P1）：这里原本 process.exit(1)——`process.exit` 不展开 JS 栈，下面的
    // try/finally **不会执行**，UAT 目录会停在"无 exe 无 data、数据在备份目录"的半毁状态。
    // 改为抛错，由 finally 的 restoreUatData() 还原用户数据。
    throw new Error('UAT 目录被占用（UAT 实例运行中？）：' + appDir + '。请退出 DSH-App-UAT 后重试。');
  }
  throw err;
}

// 1) 源码 staging —— 构建主体（R25：try/finally 保证任何一步失败都还原 data\）
try {
const staging = path.join(outDir, '_app-staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(path.join(root, 'src'), path.join(staging, 'src'), { recursive: true });
cpSync(path.join(root, 'renderer'), path.join(staging, 'renderer'), { recursive: true });
cpSync(path.join(root, 'package.json'), path.join(staging, 'package.json'));

// 2) asar
mkdirSync(path.join(appDir, 'resources'), { recursive: true });
await createPackage(staging, path.join(appDir, 'resources', 'app.asar'));

// 3) electron 运行时
if (!existsSync(electronDist)) {
  // 审计修复（P1）：同上——process.exit 会跳过 finally，使 data\ 停在备份目录。
  throw new Error('未找到 electron 运行时: ' + electronDist + '（请先 npm install）');
}
for (const name of readdirSync(electronDist)) {
  cpSync(path.join(electronDist, name), path.join(appDir, name), { recursive: true });
}

// 4) exe 改名
const exeOld = path.join(appDir, 'electron.exe');
const exeNew = path.join(appDir, 'DSH-App.exe');
if (existsSync(exeOld)) renameSync(exeOld, exeNew);
const defaultAsar = path.join(appDir, 'resources', 'default_app.asar');
// 删不掉也不能中止构建。三个 Windows 事实，2026-09-25 逐个踩到：
//   · 它可能是**目录**（上次构建中断 / cpSync 的"目标已有同名目录就复制进去"语义）
//     → 非递归 rmSync 抛 EISDIR；
//   · 它是**刚由 cpSync 写入**的，而紧接着复制的是 246MB 的 Electron 运行时，Windows 上
//     句柄常被杀软扫描或写回缓存持有数秒 → 抛 EPERM，重试 2 秒仍不够；
//   · 它只是 Electron 的**兜底默认应用**，仅在缺少 app.asar 时才会被加载——而本次构建
//     在上一步必定产出 app.asar。所以留着它无害，为一个装饰性文件让整次构建失败不划算。
if (existsSync(defaultAsar)) {
  try {
    rmSync(defaultAsar, { force: true, recursive: true, maxRetries: 5, retryDelay: 500 });
  } catch (err) {
    console.log('[警告] 未能删除 default_app.asar（' + ((err && err.code) || err) + '）——'
      + '不影响运行（有 app.asar 时它不会被加载），可稍后手工删除。');
  }
}

// 5) 内嵌 npm（同 build-portable）
// 2026-09-25 修复：原先只有两个候选、且**找不到时静默跳过**。本机没有独立 Node.js
// （`node` 就是 Electron，其发行包不含 npm）→ 产物从来没有内嵌 npm，而 dsh 的首次安装
// 与自动升级都依赖它（launcher.findEmbeddedNpmCli → resources\node_modules\npm\bin\npm-cli.js），
// 缺失时回退到 PATH 的 `npm` 并报 `'npm' 不是内部或外部命令`。
// 现在与 build-portable / prepare-extra 对齐候选，并在缺失时**明确告警**。
{
  const npmDst = path.join(appDir, 'resources', 'node_modules', 'npm');
  const npmCandidates = [
    path.join(root, 'out', '_npm', 'package'),                       // scripts/fetch-npm.mjs 产出
    path.join(root, 'node_modules', 'npm'),
    path.join(root, 'out', 'DSH-App', 'resources', 'node_modules', 'npm'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm'),
  ];
  const npmFrom = npmCandidates.find((p) => existsSync(path.join(p, 'bin', 'npm-cli.js')));
  if (npmFrom) {
    rmSync(npmDst, { recursive: true, force: true });
    cpSync(npmFrom, npmDst, { recursive: true });
    // 减体积：与 build-portable 同一套（文档/测试/多语言不在运行链路上）
    for (const junk of ['docs', 'test', 'tap-snapshots']) {
      const j = path.join(npmDst, junk);
      try { if (existsSync(j)) rmSync(j, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
    console.log('[内嵌] npm ← ' + path.relative(root, npmFrom));
  } else {
    console.log('[警告] 未找到内嵌 npm（试过：' + npmCandidates.map((p) => path.relative(root, p)).join(' / ') + '）');
    console.log('        → dsh 首次安装与自动升级会回退系统 npm，零依赖机器上必然失败。');
    console.log('        → 先运行：node scripts/fetch-npm.mjs');
  }
}

// 6) 内嵌 pnpm（同 build-portable）
{
  const pnpmVer = '11.8.0';
  const pnpmDst = path.join(appDir, 'resources', 'node_modules', 'pnpm');
  const vendored = path.join(root, 'vendor', 'pnpm-' + pnpmVer);
  let src = null;
  if (existsSync(path.join(vendored, 'bin', 'pnpm.cjs'))) src = vendored;
  else if (existsSync(path.join(root, 'out', '_pnpm11', 'package', 'bin', 'pnpm.cjs'))) src = path.join(root, 'out', '_pnpm11', 'package');
  if (src) {
    rmSync(pnpmDst, { recursive: true, force: true });
    cpSync(src, pnpmDst, { recursive: true });
    console.log('[内嵌] pnpm ' + pnpmVer + ' ✓');
  } else {
    console.log('[警告] 未找到 pnpm——dsh plugin 安装/卸载将失败');
  }
}

// 6.5) 默认插件（dsh-email-bridge）：out\_vendor → resources\vendor（见 src/default-plugins.js）
{
  const vendorSrc = path.join(root, 'out', '_vendor');
  if (existsSync(path.join(vendorSrc, 'dsh-email-bridge', 'package.json'))) {
    const vendorDst = path.join(appDir, 'resources', 'vendor');
    rmSync(vendorDst, { recursive: true, force: true });
    cpSync(vendorSrc, vendorDst, { recursive: true });
    console.log('[内嵌] 默认插件 vendor → resources\\vendor');
  } else {
    console.log('[警告] 未找到 out\\_vendor\\dsh-email-bridge（先运行 node scripts/vendor-email-bridge.mjs）');
  }
}

// 7) 图标 + 说明
// 审计修复（P2）：图标只写构建目录（exe 旁），不再创建/写入源码树 assets\——
// 源码树里的 assets\icon.* 会被当源码上传到 GitHub，并与 set-exe-icon.cjs 抢同一路径。
cpSync(path.join(root, 'src', 'assets', 'electron-icon.png'), path.join(appDir, 'icon.png'));
cpSync(path.join(root, 'src', 'assets', 'electron-icon.ico'), path.join(appDir, 'icon.ico'));
} catch (err) {
  console.error('[错误] UAT 构建失败：' + (err && err.message ? err.message : err));
  process.exitCode = 1;   // 不用 process.exit：让 finally 先还原 data\（审计修复）
} finally {
  restoreUatData();   // R24/R25：构建结束（含失败路径）还原 UAT 用户数据
}
if (process.exitCode) {
  console.error('[中止] 构建未完成，UAT 目录可能不完整；用户数据已还原。');
  process.exit(1);
}

console.log('[OK] UAT 构建完成: ' + appDir);
console.log('     验证流程：运行 out\\DSH-App-UAT\\DSH-App.exe → 全面测试 → 无误后发布。');
console.log('     （数据目录独立：UAT 用自己的 data\\，不污染开发/发布目录；构建不清空 data\\）');