// scripts/dist.mirror.mjs — 使用国内镜像编译 Windows 安装版（NSIS）+ 单文件便携版
//
// 用法：node scripts/dist.mirror.mjs   （或 npm run dist:mirror）
// 产物（dsh-app/dist/）：
//   DSHApp-1.5.0-x64.exe           —— NSIS 安装程序（安装版）
//   DSHApp-1.5.0-便携版.exe        —— 单文件便携版（自解压，双击即用）
//
// 说明：electron-builder 需要访问 GitHub 下载 NSIS/签名工具；本脚本使用 npmmirror 镜像，
// 无需代理也能完成。若 GitHub 可达，也可直接 `npm run dist`。
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
const child = spawn(process.execPath, [cli, '--win', 'nsis', 'portable'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));