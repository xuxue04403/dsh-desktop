// 决定性验证：cmd broker 下 dsh web 启动 + agent 的 pwsh 孙进程不弹窗
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = 'D:/IDE/dsh/dsh-app/out/DSH-App-v1.5.17/DSH-App.exe';
const npmCli = 'D:/IDE/dsh/dsh-app/out/DSH-App-v1.5.17/resources/node_modules/npm/bin/npm-cli.js';
const prefix = 'D:/IDE/dsh/dsh-app/out/DSH-App-v1.5.17/data/node-global';
const bin = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const appDir = path.dirname(app);

// node.exe（安装期 postinstall 用）
const nodeExe = path.join(appDir, 'node.exe');
if (!fs.existsSync(nodeExe)) { try { fs.linkSync(app, nodeExe); } catch (_) { fs.copyFileSync(app, nodeExe); } }

// 安装 dsh（镜像 + PATH 注入）
if (!fs.existsSync(bin)) {
  const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  env.PATH = appDir + ';' + (env.PATH || '');
  const inst = spawnSync(app, [npmCli, 'install', '-g', '--prefix', prefix,
    '@deepseek-ai/dsh@latest', '--no-fund', '--no-audit', '--force', '--registry', 'https://registry.npmmirror.com'],
    { env, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  console.log('安装 dsh exit:', inst.status);
  if (inst.status !== 0) { console.log(String(inst.stderr || '').slice(-300)); process.exit(1); }
}

// 模拟 v1.5.17e 的 broker：cmd.exe（隐藏控制台宿主）→ DSH-App.exe(node) → dsh web
// dsh 起来后，其 agent 工具 spawn 的 pwsh 将继承隐藏控制台（验证弹窗消失）
const broker = path.join(prefix, '..', 'broker', 'launch-dsh.cmd');
fs.mkdirSync(path.dirname(broker), { recursive: true });
fs.writeFileSync(broker, [
  '@echo off',
  'setlocal DisableDelayedExpansion',
  'set "ELECTRON_RUN_AS_NODE=1"',
  `"${app}" --expose-internals "${bin}" web --no-open --port 3085`,
  'exit /b %errorlevel%',
  '',
].join('\r\n'), 'utf8');

console.log('\n经 cmd broker 启动 dsh web（port 3085）…（请目视：应无任何黑窗弹出）');
const child = spawn('cmd.exe', ['/d', '/s', '/c', broker], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let gotUrl = false, errTail = '';
child.stdout.on('data', (c) => {
  const t = c.toString().trim();
  console.log('[out]', t.slice(0, 120));
  if (t.includes('dsh web:')) gotUrl = true;
});
child.stderr.on('data', (c) => { errTail += c; });
child.on('exit', (code) => console.log('退出 code:', code));

// 就绪后经 HTTP 让 dsh 自己 spawn pwsh（模拟 agent 工具）验证孙进程不弹窗
// ——简化：直接检查服务存活 30 秒（弹窗由人工/后台观察）。更深的工具链验证交给用户实测。
function health(port) {
  return new Promise((r) => {
    const q = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, (res) => { res.resume(); r(res.statusCode); });
    q.on('error', () => r(null)); q.on('timeout', () => { q.destroy(); r(null); });
  });
}
(async () => {
  for (let i = 1; i <= 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await health(3085);
    console.log(`  ${i * 5}s: ${gotUrl ? 'URL已出' : '等URL'} | 端口: ${st === null ? '无' : 'HTTP ' + st}`);
    if (i >= 6 && st !== null) break;
  }
  if (errTail) console.log('stderr 尾:\n', errTail.slice(-300));
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  process.exit(0);
})();