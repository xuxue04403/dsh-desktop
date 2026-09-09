'use strict';
const { extractAll } = require('@electron/asar');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-'));
extractAll('out/DSH-App-UAT/resources/app.asar', t);
const R = (p) => fs.readFileSync(path.join(t, p), 'utf8');
const m = R('src/gateway/model-gateway.mjs');
const gm = R('src/gateway-manager.js');
const l = R('src/launcher.js');
const mk = R('src/market.js');
const checks = [
  ['R19 双补丁(native)', l.includes('wShowWindow: 0,   // dsh-app R19')],
  ['R18 退出全清', gm.includes('killAllDshProcesses')],
  ['R17 watchdog', m.includes('self-watchdog')],
  ['R16 connection-close', m.includes("out['connection'] = 'close'")],
  ['R20 熔断 90s', m.includes('90_000')],
  ['R20 503 语义', m.includes('breaker cooldown')],
  ['pnpm 注入(market)', mk.includes('_envWithPnpm')],
  ['pnpm 注入(launcher)', l.includes('pnpmCjs')],
  ['npm scoped URL 修复', mk.includes('@$1%2F')],
  ['dshfind 默认源', mk.includes("id: 'dshfind'")],
];
let ok = 0;
for (const [name, pass] of checks) { console.log(`  ${name}: ${pass ? '✓' : '✗'}`); if (pass) ok++; }
console.log(`  pnpm 资源: ${fs.existsSync('out/DSH-App-UAT/resources/node_modules/pnpm/bin/pnpm.cjs') ? '✓' : '✗'}`);
const pkg = JSON.parse(R('package.json'));
console.log(`  版本: ${pkg.version} | 特征 ${ok}/${checks.length}`);
fs.rmSync(t, { recursive: true, force: true });