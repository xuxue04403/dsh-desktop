'use strict';
const { extractAll } = require('@electron/asar');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
extractAll('out/DSH-App/resources/app.asar', t);
const asarMk = fs.readFileSync(path.join(t, 'src', 'market.js'), 'utf8');
const srcMk = fs.readFileSync('src/market.js', 'utf8');
console.log('asar market.js 长度:', asarMk.length, '| 源码长度:', srcMk.length, '| 一致:', asarMk === srcMk);
console.log('asar 前 200 字:', JSON.stringify(asarMk.slice(0, 200)));
// asar 里找 _envWithPnpm
console.log('asar 含 _envWithPnpm:', asarMk.includes('_envWithPnpm'));
console.log('asar 含 dshfind:', asarMk.includes('dshfind'));
fs.rmSync(t, { recursive: true, force: true });