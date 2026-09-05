// scripts/build-portable.mjs — 手工构建 Windows 绿色免安装版（无需 electron-builder / 无需 MSVC）
//
// 产物：dsh-app/out/DSH-App/  （双击 DSH-App.exe 即用；可整目录压缩分发）
// 原理：
//   1) 收集应用源码（src / renderer / package.json）→ asar 打包为 resources/app.asar
//   2) 复制 electron 官方运行时（node_modules/electron/dist）→ 绿色目录
//   3) 主程序改名为 DSH-App.exe，删除默认 default_app.asar
//
// 用法：node scripts/build-portable.mjs
import { createPackage } from '@electron/asar';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out');
// 输出目录名：环境变量优先；默认 DSH-App。若被运行中的实例占用则自动回退到带版本号的目录。
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const defaultOut = 'DSH-App';
const fallbackOut = 'DSH-App-v' + pkg.version;
let outName = process.env.OUT_NAME || defaultOut;
let appDir = path.join(outDir, outName);
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');

// 清理旧输出目录；EBUSY（有实例在运行）→ 自动回退目录
function prepareAppDir() {
  try {
    rmSync(appDir, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'EBUSY') throw err;
    if (outName === fallbackOut) {
      console.error('[错误] 输出目录 ' + appDir + ' 被占用（应用可能正在运行）。请退出 DSH App 后重试。');
      process.exit(1);
    }
    const alt = path.join(outDir, fallbackOut);
    console.log('[提示] ' + appDir + ' 被占用（可能有实例在运行），改用 ' + alt);
    try {
      rmSync(alt, { recursive: true, force: true });
    } catch (err2) {
      if (err2.code === 'EBUSY') {
        console.error('[错误] 备用目录 ' + alt + ' 也被占用。请退出 DSH App 后重试。');
        process.exit(1);
      }
      throw err2;
    }
    outName = fallbackOut;
    appDir = alt;
  }
}

// —— 1) 收集应用源码 ————————————————————————————————
const staging = path.join(outDir, '_app-staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(path.join(root, 'src'), path.join(staging, 'src'), { recursive: true });
cpSync(path.join(root, 'renderer'), path.join(staging, 'renderer'), { recursive: true });
cpSync(path.join(root, 'package.json'), path.join(staging, 'package.json'));

// —— 2) asar 打包 ————————————————————————————————————
prepareAppDir();
mkdirSync(path.join(appDir, 'resources'), { recursive: true });
await createPackage(staging, path.join(appDir, 'resources', 'app.asar'));

// —— 3) 复制 electron 运行时 —————————————————————————
if (!existsSync(electronDist)) {
  console.error('[错误] 未找到 electron 运行时: ' + electronDist + '。请先执行 npm install。');
  process.exit(1);
}
for (const name of readdirSync(electronDist)) {
  cpSync(path.join(electronDist, name), path.join(appDir, name), { recursive: true });
}

// —— 4) 主程序改名 + 移除默认壳 —————————————————————
const exeOld = path.join(appDir, 'electron.exe');
const exeNew = path.join(appDir, 'DSH-App.exe');
if (existsSync(exeOld)) renameSync(exeOld, exeNew);
const defaultAsar = path.join(appDir, 'resources', 'default_app.asar');
if (existsSync(defaultAsar)) rmSync(defaultAsar, { force: true });

// —— 5) 品牌图标（与 DSH-App.exe 内嵌图标完全一致：src/assets/electron-icon.*
//       是从 electron.exe 资源原样提取的官方图标，见 scripts/extract-exe-icon.mjs）——
mkdirSync(path.join(root, 'assets'), { recursive: true });
cpSync(path.join(root, 'src', 'assets', 'electron-icon.png'), path.join(root, 'assets', 'icon.png'));
cpSync(path.join(root, 'src', 'assets', 'electron-icon.ico'), path.join(root, 'assets', 'icon.ico'));
cpSync(path.join(root, 'src', 'assets', 'electron-icon.png'), path.join(appDir, 'icon.png'));
cpSync(path.join(root, 'src', 'assets', 'electron-icon.ico'), path.join(appDir, 'icon.ico'));

// —— 6) 说明文件 ————————————————————————————————————
writeFileSync(path.join(appDir, '使用说明.txt'),
  'DSH App（DeepSeek Harness 桌面壳）· 绿色免安装版\r\n'
  + '\r\n'
  + '双击 DSH-App.exe 即可运行（无需安装，不写注册表）。\r\n'
  + '首次启动建议：点击「启动 dsh 服务」；服务就绪后窗口内嵌 Harness 界面。\r\n'
  + '\r\n'
  + '运行数据（设置/日志/网关配置/安全模式）保存在本目录旁的 data\\ 文件夹，\r\n'
  + '随程序目录走（复制整个目录即随身携带）；目录不可写时才回退 %APPDATA%\\DSH-App\\。\r\n'
  + '本机需已安装 Node.js 与 dsh（未安装 dsh 时应用会通过 npx 自动获取）。\r\n'
  + '\r\n'
  + '加载超时/插件故障时应用会自动进入安全模式（见应用内提示与日志）。\r\n',
  'utf8');

console.log('[OK] 绿色免安装版已生成: ' + appDir);
console.log('OUTDIR=' + appDir);
console.log('     启动方式：双击 ' + path.join(appDir, 'DSH-App.exe'));
console.log('     分发方式：将 ' + outName + ' 目录压缩为 zip 即可（解压即用）。');