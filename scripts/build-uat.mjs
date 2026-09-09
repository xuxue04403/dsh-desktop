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
try {
  rmSync(appDir, { recursive: true, force: true });
} catch (err) {
  if (err.code === 'EBUSY' || err.code === 'EPERM') {
    console.error('[错误] UAT 目录被占用（UAT 实例运行中？）。请退出 DSH-App-UAT 后重试。');
    process.exit(1);
  }
  throw err;
}

// 1) 源码 staging
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

// 7) 图标 + 说明
mkdirSync(path.join(root, 'assets'), { recursive: true });
cpSync(path.join(root, 'src', 'assets', 'electron-icon.png'), path.join(appDir, 'icon.png'));
cpSync(path.join(root, 'src', 'assets', 'electron-icon.ico'), path.join(appDir, 'icon.ico'));

console.log('[OK] UAT 构建完成: ' + appDir);
console.log('     验证流程：运行 out\\DSH-App-UAT\\DSH-App.exe → 全面测试 → 无误后发布。');
console.log('     （数据目录独立：UAT 用自己的 data\\，不污染开发/发布目录）');