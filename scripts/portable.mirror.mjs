// scripts/portable.mirror.mjs — 使用国内镜像打包 Windows 免安装版（单 exe）
//
// 用法：node scripts/portable.mirror.mjs   （或 npm run portable:mirror）
// 产物：dsh-app/dist/DSHApp-<version>-便携版.exe —— 桌面双击即用，无需安装。
//
// 镜像（npmmirror）：
//   ELECTRON_MIRROR                 electron 二进制
//   ELECTRON_BUILDER_BINARIES_MIRROR electron-builder 工具（NSIS/winCodeSign 等）
import { spawn } from 'node:child_process';
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

const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const child = spawn(process.execPath, [cli, '--win', 'portable'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));