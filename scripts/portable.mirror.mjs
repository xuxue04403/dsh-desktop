// scripts/portable.mirror.mjs — 使用国内镜像打包 Windows 免安装版（单 exe）
//
// 用法：node scripts/portable.mirror.mjs   （或 npm run portable:mirror）
// 产物：dsh-app/dist/DSHApp-Portable-<version>-x64.exe —— 桌面双击即用，无需安装。
//
// 镜像（npmmirror）：
//   ELECTRON_MIRROR                 electron 二进制
//   ELECTRON_BUILDER_BINARIES_MIRROR electron-builder 工具（NSIS/winCodeSign 等）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR
    || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

// 审计修复（P1）：先把 extraResources 源（vendor / npm / pnpm）收集到 out\_extra，
// 否则 electron-builder 的 extraResources 会因 from 不存在而失败；收集完再打包，
// 保证安装版/便携版的 resources\ 里有内嵌 npm 与默认插件（零依赖承诺才对安装包成立）。
const prep = spawnSync(process.execPath, [path.join(root, 'scripts', 'prepare-extra.mjs')], {
  cwd: root, stdio: 'inherit',
});
if (prep.status !== 0) {
  console.error('[错误] prepare-extra.mjs 失败（退出码 ' + prep.status + '），已中止打包。');
  process.exit(prep.status ?? 1);
}

const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
// 审计修复（P2）：先校验 CLI 存在——旧版 spawn 一个不存在的路径，Node 发 'error' 事件
// 而脚本只监听 'exit' → 既没有报错也没有结果，静默"成功"。
if (!fs.existsSync(cli)) {
  console.error('[错误] 未找到 electron-builder CLI: ' + cli);
  console.error('       请先在项目根执行 npm install（devDependencies 含 electron-builder）。');
  process.exit(1);
}
const child = spawn(process.execPath, [cli, '--win', 'portable'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
child.on('error', (err) => {
  // 审计修复（P2）：补 'error' 监听（spawn 失败不会触发 'exit'）
  console.error('[错误] 无法启动 electron-builder：' + (err && err.message ? err.message : err));
  process.exit(1);
});
child.on('exit', (code) => {
  // 打包后断言：产物 resources\ 必须真的带上 vendor 与 node_modules
  const resDir = path.join(root, 'dist', 'win-unpacked', 'resources');
  const missing = [];
  if (!fs.existsSync(path.join(resDir, 'vendor'))) missing.push('vendor');
  if (!fs.existsSync(path.join(resDir, 'node_modules'))) missing.push('node_modules');
  if (missing.length) {
    console.error('[警告] 产物 resources\\ 缺少: ' + missing.join(', ') + ' —— 该安装包在无 Node 机器上无法自动安装 dsh。');
  } else if (fs.existsSync(resDir)) {
    console.log('[校验] 产物 resources\\ 已含 vendor + node_modules。');
  }
  process.exit(code ?? 1);
});