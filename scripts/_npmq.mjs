// 查 npm registry：插件是否有支持 dsh 0.1.7 的新版本。
const REG = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';

async function q(name) {
  const url = `${REG}/${name.replace('/', '%2f')}`;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) { console.log(`  ${name}: HTTP ${r.status}`); return null }
      const j = await r.json();
      return j;
    } catch (e) { if (i === 3) console.log(`  ${name}: FAIL ${(e.cause && e.cause.code) || e.name}`) }
  }
  return null;
}

for (const name of ['dsh-web-search-free', 'dsh-email-bridge', 'dsh-opencode-go-model-list']) {
  console.log(`=== ${name} ===`);
  const j = await q(name);
  if (!j) { console.log('  (无数据)\n'); continue }
  console.log('  dist-tags: ' + JSON.stringify(j['dist-tags']));
  const vs = Object.keys(j.versions || {});
  console.log('  版本数: ' + vs.length);
  console.log('  全部版本: ' + vs.slice(-15).join(', '));
  // 最新版的 peerDependencies（判断要求的 dsh 版本）
  const latest = j['dist-tags'] && j['dist-tags'].latest;
  if (latest && j.versions[latest]) {
    const pv = j.versions[latest];
    console.log('  latest=' + latest + '  peerDeps: ' + JSON.stringify(pv.peerDependencies || {}));
    console.log('  发布时间: ' + (j.time && j.time[latest] ? j.time[latest] : '?'));
  }
  console.log('');
}

console.log('=== @deepseek-ai/dsh ===');
const d = await q('@deepseek-ai/dsh');
if (d) {
  console.log('  dist-tags: ' + JSON.stringify(d['dist-tags']));
  const vs = Object.keys(d.versions || {});
  console.log('  近期版本: ' + vs.slice(-15).join(', '));
  const t = d.time || {};
  for (const v of vs.slice(-8)) console.log(`    ${v.padEnd(16)} ${t[v] || '?'}`);
}
