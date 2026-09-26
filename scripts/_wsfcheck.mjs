// 下载 dsh-web-search-free 各版本，检查其客户端插件的 inject 声明：
// 是否仍注入已被 0.1.7 移除的 settingsScope？
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';

const REG = 'https://registry.npmmirror.com';
const OUT = path.join(os.tmpdir(), 'wsf-check');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

async function meta() {
  const r = await fetch(`${REG}/dsh-web-search-free`, { signal: AbortSignal.timeout(30000) });
  return r.json();
}

const j = await meta();
const versions = ['1.3.0', '1.4.0', '1.5.0', '1.5.1', '1.6.0'];
console.log('全部版本: ' + Object.keys(j.versions).join(', '));
console.log('time:');
for (const v of versions) console.log('  ' + v.padEnd(8) + (j.time[v] || '?'));

for (const v of versions) {
  const url = j.versions[v].dist.tarball;
  process.stdout.write(`\n=== ${v} ===\n  tarball: ${url}\n`);
  let buf;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) { console.log('  下载失败: ' + ((e.cause && e.cause.code) || e.name)); continue }
  console.log('  大小: ' + (buf.length / 1024).toFixed(0) + ' KB');

  // 解 tar.gz，找 client.js
  let tar;
  try { tar = zlib.gunzipSync(buf) } catch (e) { console.log('  gunzip 失败: ' + e.message); continue }
  // 极简 tar 解析
  let off = 0;
  const files = {};
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const sizeStr = tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const dataStart = off + 512;
    if (size > 0) files[name] = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  const clientKey = Object.keys(files).find((k) => /dist\/client\.js$/.test(k));
  if (!clientKey) { console.log('  (无 dist/client.js)  文件: ' + Object.keys(files).slice(0, 12).join(', ')); continue }
  const src = files[clientKey].toString('utf8');
  const injectLine = (src.match(/inject\s*=\s*\[[^\]]*\]/g) || []).slice(0, 3);
  console.log('  ' + clientKey + '  (' + src.length + ' 字符)');
  console.log('  inject 声明: ' + (injectLine.length ? injectLine.join(' | ') : '(未找到)'));
  console.log('  含 settingsScope: ' + /settingsScope/.test(src));
  console.log('  含 settingsSchema: ' + /settingsSchema/.test(src));
  console.log('  含 configForms: ' + /configForms/.test(src));
}
