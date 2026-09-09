'use strict';
// 校验主目录与 UAT asar 一致性（关键文件清单）
const { extractAll } = require('@electron/asar');
const fs = require('fs');
const os = require('os');
const path = require('path');
const KEY_FILES = [
  'src/gateway/model-gateway.mjs',
  'src/gateway-manager.js',
  'src/launcher.js',
  'src/market.js',
  'src/main.js',
  'src/preload.js',
  'src/updater.js',
  'renderer/settings.html',
  'package.json',
];
function grab(asar, keyFiles) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
  extractAll(asar, t);
  const out = {};
  for (const f of keyFiles) out[f] = fs.readFileSync(path.join(t, f), 'utf8');
  fs.rmSync(t, { recursive: true, force: true });
  return out;
}
const a = grab('out/DSH-App/resources/app.asar', KEY_FILES);
const b = grab('out/DSH-App-UAT/resources/app.asar', KEY_FILES);
let same = true;
for (const f of KEY_FILES) {
  if (a[f] !== b[f]) { same = false; console.log('不同:', f, a[f].length, 'vs', b[f].length); }
}
console.log('主目录 vs UAT 关键文件:', same ? '完全一致 ✓' : '存在差异 ✗');
// 版本
console.log('主目录版本:', JSON.parse(a['package.json']).version);
console.log('UAT 版本:', JSON.parse(b['package.json']).version);