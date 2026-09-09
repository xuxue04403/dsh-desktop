'use strict';
const { extractAll } = require('@electron/asar');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const dir of ['DSH-App', 'DSH-App-v1.5.18']) {
  const asar = `out/${dir}/resources/app.asar`;
  console.log(`\n===== ${dir} =====`);
  if (!fs.existsSync(asar)) { console.log('  无 asar'); continue; }
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  extractAll(asar, t);
  const R = (p) => fs.readFileSync(path.join(t, p), 'utf8');
  const m = R('src/gateway/model-gateway.mjs');
  const gm = R('src/gateway-manager.js');
  const l = R('src/launcher.js');
  const mk = R('src/market.js');
  console.log('  R19 双补丁(native):', l.includes('wShowWindow: 0,   // dsh-app R19') ? '✓' : '✗');
  console.log('  R18 退出全清:', gm.includes('killAllDshProcesses') ? '✓' : '✗');
  console.log('  R17 watchdog:', m.includes('self-watchdog') ? '✓' : '✗');
  console.log('  R16 connection-close:', m.includes("out['connection'] = 'close'") ? '✓' : '✗');
  console.log('  pnpm 注入(market):', mk.includes('_envWithPnpm') ? '✓' : '✗');
  console.log('  pnpm 注入(launcher):', l.includes('pnpmCjs') ? '✓' : '✗');
  console.log('  npm scoped URL 修复:', mk.includes('@$1%2F') ? '✓' : '✗');
  console.log('  ComSpec:', (mk.includes('ComSpec') || l.includes('ComSpec')) ? '✓' : '✗');
  console.log('  dshfind 默认源:', mk.includes("id: 'dshfind'") ? '✓' : '✗');
  const pkg = JSON.parse(R('package.json'));
  console.log('  版本:', pkg.version);
  console.log('  pnpm 资源:', fs.existsSync(`out/${dir}/resources/node_modules/pnpm/bin/pnpm.cjs`) ? '✓' : '✗');
  const wp = `out/${dir}/data/node-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js`;
  if (fs.existsSync(wp)) console.log('  dsh 已装+补丁2:', fs.readFileSync(wp, 'utf8').includes('wShowWindow: 0') ? '✓' : '✗（需重启服务重打）');
  fs.rmSync(t, { recursive: true, force: true });
}