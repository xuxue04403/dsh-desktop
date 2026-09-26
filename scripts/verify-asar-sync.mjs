#!/usr/bin/env node
/**
 * 校验「绿目录 resources/app.asar 里的代码」与「dsh-app\src 源码」是否一致。
 *
 * 为什么要单独写：asar 的 extractFile 在本项目里路径归一化不可靠，
 * 手工解析 header 偏移也容易出错；而 asar header 里每个 entry 自带
 * integrity.hash（SHA256），直接和源码文件哈希对比最稳。
 *
 * 用法：
 *   node scripts/verify-asar-sync.mjs                       # 默认校验 out\DSH-App
 *   node scripts/verify-asar-sync.mjs out\DSH-App-UAT       # 指定绿目录
 *   node scripts/verify-asar-sync.mjs out\DSH-App a.js b.js # 只校验指定条目
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 本机没有独立 Node.js 时，`node` 会解析到随应用分发的 DSH-App.exe（Electron 的
// ELECTRON_RUN_AS_NODE 模式），而 Electron 的 asar 层会**透明拦截** .asar 路径的
// fs 调用——`openSync('<...>/app.asar')` 会被当成"asar 内部路径"去查，直接 ENOENT
// （错误形如 `ENOENT,  not found in D:\...\app.asar`）。本脚本要读的正是 asar 的
// **原始字节与 header**，必须关掉这层包装。在独立 Node 下该赋值是无害的空操作。
process.noAsar = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 默认关注的条目：主进程关键文件 + 网关运行时拷贝。 */
const DEFAULT_ENTRIES = [
  'src/logger.js',
  'src/watchdog.js',
  'src/launcher.js',
  'src/gateway-manager.js',
  'src/timestamp.js',
  'src/gateway/model-gateway.mjs',
  'renderer/settings.html',
  'src/main.js',
  'package.json',
];

function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const jsonBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, jsonBuf, 0, headerSize, 8);
    // header 是 pickle 编码：JSON 前有 pickle 头、后有 4 字节长度 + 填充。
    // 直接 JSON.parse 整段会因尾部填充报 "Unexpected non-whitespace character"，
    // 所以按花括号深度扫描出 JSON 的精确边界（比猜偏移可靠）。
    const text = jsonBuf.toString('utf8');
    const start = text.indexOf('{');
    if (start < 0) throw new Error('asar header 里找不到 JSON 起始');
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) throw new Error('asar header JSON 不完整');
    return JSON.parse(text.slice(start, end));
  } finally {
    fs.closeSync(fd);
  }
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, out);
    else out.set(p, entry);
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const args = process.argv.slice(2);
  const dirArg = args[0] && !args[0].endsWith('.js') && !args[0].endsWith('.mjs') ? args[0] : 'out/DSH-App';
  const rest = args.filter((a) => a !== dirArg);
  const entries = rest.length ? rest : DEFAULT_ENTRIES;

  const greenDir = path.resolve(ROOT, dirArg);
  const asarPath = path.join(greenDir, 'resources', 'app.asar');
  const asarDataDir = path.join(greenDir, 'data');

  if (!fs.existsSync(asarPath)) {
    console.error(`[FAIL] 找不到 ${asarPath}`);
    process.exit(1);
  }

  const header = readAsarHeader(asarPath);
  const files = new Map();
  walk(header, '', files);

  console.log(`asar : ${asarPath}`);
  console.log(`      ${fs.statSync(asarPath).size} B  mtime=${fs.statSync(asarPath).mtime.toLocaleString('zh-CN')}`);
  console.log(`源码 : ${path.join(ROOT, 'src')}`);
  console.log('');

  let bad = 0;
  let missing = 0;
  for (const rel of entries) {
    // asar 内路径统一用 / 分隔；有些条目在 asar 里可能位于 app/ 子目录
    const key = files.has(rel) ? rel : [...files.keys()].find((k) => k === rel || k.endsWith('/' + rel));
    const srcFile = path.join(ROOT, rel);

    if (!key) {
      console.log(`  [缺失] ${rel.padEnd(28)} asar 内不存在`);
      missing++;
      continue;
    }
    if (!fs.existsSync(srcFile)) {
      console.log(`  [缺源] ${rel.padEnd(28)} 源码不存在`);
      missing++;
      continue;
    }

    const entry = files.get(key);
    const srcHash = sha256File(srcFile);
    const asarHash = entry.integrity && entry.integrity.hash;

    if (!asarHash) {
      console.log(`  [无校验] ${rel.padEnd(26)} asar 未记录 integrity.hash`);
      missing++;
      continue;
    }
    if (asarHash === srcHash) {
      console.log(`  [一致] ${rel.padEnd(28)} ${srcHash.slice(0, 16)}`);
    } else {
      console.log(`  [不一致] ${rel.padEnd(26)} asar=${asarHash.slice(0, 16)} 源码=${srcHash.slice(0, 16)}`);
      bad++;
    }
  }

  // 网关运行时拷贝（不进 asar，放在 data\gateway）
  const runtimeCopy = path.join(asarDataDir, 'gateway', 'model-gateway.mjs');
  const srcGateway = path.join(ROOT, 'src', 'gateway', 'model-gateway.mjs');
  if (fs.existsSync(runtimeCopy) && fs.existsSync(srcGateway)) {
    const a = sha256File(runtimeCopy);
    const b = sha256File(srcGateway);
    const tag = a === b ? '[一致]' : '[不一致]';
    console.log(`  ${tag} ${'data/gateway/model-gateway.mjs'.padEnd(28)} ${a.slice(0, 16)}`);
    if (a !== b) bad++;
  }

  console.log('');
  if (bad || missing) {
    console.log(`[FAIL] 不一致 ${bad} 项，缺失/无法校验 ${missing} 项`);
    process.exit(1);
  }
  console.log('[OK] 全部一致，绿目录代码 == 当前源码');
}

main();
