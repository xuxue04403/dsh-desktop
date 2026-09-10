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
    console.error('[错误] UAT 目录被占用（UAT 实例运行中？）。请退出 DSH-App-UAT 后重试。');
    process.exit(1);
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
  console.error('[错误] 未找到 electron 运行时: ' + electronDist);
  process.exit(1);
}
for (const name of readdirSync(electronDist)) {
  cpSync(path.join(electronDist, name), path.join(appDir, name), { recursive: true });
}

// 4) exe 改名
const exeOld = path.join(appDir, 'electron.exe');
const exeNew = path.join(appDir, 'DSH-App.exe');
if (existsSync(exeOld)) renameSync(exeOld, exeNew);
const defaultAsar = path.join(appDir, 'resources', 'default_app.asar');
if (existsSync(defaultAsar)) rmSync(defaultAsar, { force: true });

// 5) 内嵌 npm（同 build-portable）
{
  let npmSrc = path.join(root, 'node_modules', 'npm');
  if (!existsSync(npmSrc)) npmSrc = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
  if (existsSync(npmSrc)) {
    cpSync(npmSrc, path.join(appDir, 'resources', 'node_modules', 'npm'), { recursive: true });
    console.log('[内嵌] npm → resources\\node_modules\\npm');
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
mkdirSync(path.join(root, 'assets'), { recursive: true });
cpSync(path.join(root, 'src', 'assets', 'electron-icon.png'), path.join(appDir, 'icon.png'));
cpSync(path.join(root, 'src', 'assets', 'electron-icon.ico'), path.join(appDir, 'icon.ico'));
} finally {
  restoreUatData();   // R24/R25：构建结束（含失败路径）还原 UAT 用户数据
}

console.log('[OK] UAT 构建完成: ' + appDir);
console.log('     验证流程：运行 out\\DSH-App-UAT\\DSH-App.exe → 全面测试 → 无误后发布。');
console.log('     （数据目录独立：UAT 用自己的 data\\，不污染开发/发布目录；构建不清空 data\\）');