// 全面版本核查：各目录 asar 关键特征 + data 配置 + 补丁状态
'use strict';
const { extractAll } = require('@electron/asar');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FEATURES = {
  'R19 补丁2(双补丁)': (m, gm, l) => l.includes('wShowWindow: 0,   // dsh-app R19'),
  'R18 退出全清': (m, gm, l) => gm.includes('killAllDshProcesses'),
  'R17 watchdog': (m, gm, l) => m.includes('self-watchdog'),
  'R16 connection-close': (m, gm, l) => m.includes("out['connection'] = 'close'"),
  'pnpm 注入': (mk) => mk.includes('_envWithPnpm'),
  'npm scoped URL 修复': (mk) => mk.includes('@$1%2F'),
  'ComSpec 修复': (mk, m) => mk.includes('ComSpec') || m.includes('ComSpec'),
  '市场 dshfind 默认源': (mk) => mk.includes("id: 'dshfind'"),
};

for (const dir of ['DSH-App', 'DSH-App-v1.5.18']) {
  const asar = `out/${dir}/resources/app.asar`;
  console.log(`\n===== ${dir} =====`);
  if (!fs.existsSync(asar)) { console.log('  无 asar'); continue; }
  const st = fs.statSync(asar);
  console.log(`  asar: ${st.mtime.toLocaleString()} (${st.size}B)`);
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  extractAll(asar, t);
  const m = fs.readFileSync(path.join(t, 'src', 'gateway', 'model-gateway.mjs'), 'utf8');
  const gm = fs.readFileSync(path.join(t, 'src', 'gateway-manager.js'), 'utf8');
  const l = fs.readFileSync(path.join(t, 'src', 'launcher.js'), 'utf8');
  const mk = fs.readFileSync(path.join(t, 'src', 'market.js'), 'utf8');
  for (const [name, fn] of Object.entries(FEATURES)) {
    console.log(`  ${name}: ${fn(m, gm, l, mk) ? '✓' : '✗'}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(t, 'package.json'), 'utf8'));
  console.log(`  版本: ${pkg.version}`);
  // pnpm 资源
  console.log(`  pnpm 资源: ${fs.existsSync(`out/${dir}/resources/node_modules/pnpm/bin/pnpm.cjs`) ? '✓' : '✗'}`);
  // data 配置
  const cfg = `out/${dir}/data/gateway.config.json`;
  if (fs.existsSync(cfg)) {
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    const sen = (j.providers || []).find((p) => p.id === 'sensenova');
    console.log(`  data 配置: port=${j.port} profile=${j.clientProfile} providers=${(j.providers || []).length} sensenova=${sen ? (sen.enabled ? 'on' : 'off') : '无'}`);
  } else {
    console.log('  data 配置: 无（将走迁移/示例）');
  }
  // 已打补丁状态（node-global 的 dsh-win32-process）
  const wp = `out/${dir}/data/node-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js`;
  if (fs.existsSync(wp)) {
    console.log(`  dsh 补丁2(已装 dsh): ${fs.readFileSync(wp, 'utf8').includes('wShowWindow: 0') ? '✓' : '✗'}`);
  }
  fs.rmSync(t, { recursive: true, force: true });
}