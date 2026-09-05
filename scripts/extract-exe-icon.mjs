// scripts/extract-exe-icon.mjs — 从 electron.exe 提取官方内嵌图标（纯 Node，零依赖）
//
// 目的：绿色版 DSH-App.exe 即 electron.exe 改名，其任务栏/资源管理器图标是 Electron
// 官方图标（深蓝底白色原子）。本脚本解析 PE 资源段，把 RT_GROUP_ICON + RT_ICON
// 提取为多尺寸 .ico，并把最大的 PNG blob 单独导出为 .png，供托盘/窗口/分发使用，
// 从而与 exe 图标 100% 一致（不再程序化近似绘制）。
//
// 用法：node scripts/extract-exe-icon.mjs [exePath] [outIco] [outPng]
//   默认：node_modules/electron/dist/electron.exe → src/assets/electron-icon.ico + .png
'use strict';

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exePath = process.argv[2] || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const outIco = process.argv[3] || path.join(root, 'src', 'assets', 'electron-icon.ico');
const outPng = process.argv[4] || path.join(root, 'src', 'assets', 'electron-icon.png');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

// 把资源 RVA 映射为文件偏移
function sectionForRva(sections, rva) {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + s.virtualSize) {
      return s.pointerToRawData + (rva - s.virtualAddress);
    }
  }
  return -1;
}

function parseResourceTree(buf, sections, dirRva) {
  const off = sectionForRva(sections, dirRva);
  if (off < 0 || off + 16 > buf.length) return null;
  const named = buf.readUInt16LE(off + 12);
  const idCount = buf.readUInt16LE(off + 14);
  let e = off + 16;
  const entries = [];
  for (let i = 0; i < named + idCount; i++) {
    if (e + 8 > buf.length) break;
    const name = buf.readUInt32LE(e);
    const data = buf.readUInt32LE(e + 4);
    entries.push({ name, data, isNamed: (name >>> 31) === 1 });
    e += 8;
  }
  return { entries, off };
}

// 资源树内偏移是相对资源段起始的；高位=1 表示子目录，否则是叶子数据条目的相对偏移
function childRva(resBaseRva, value) {
  return resBaseRva + (value & 0x7fffffff);
}

function dataEntryPayload(buf, sections, resBaseRva, leafRelative) {
  const off = sectionForRva(sections, resBaseRva + (leafRelative & 0x7fffffff));
  if (off < 0 || off + 16 > buf.length) return null;
  const rva = buf.readUInt32LE(off);
  const size = buf.readUInt32LE(off + 4);
  const foff = sectionForRva(sections, rva);
  if (foff < 0 || foff + size > buf.length) return null;
  return buf.subarray(foff, foff + size);
}

export function extractExeIcon(buf) {
  if (buf.length < 0x40) throw new Error('文件过小，不是有效 PE');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('未找到 PE 签名');
  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optOff = coff + 20;                     // IMAGE_OPTIONAL_HEADER
  const optMagic = buf.readUInt16LE(optOff);
  const is64 = optMagic === 0x20b;
  if (optMagic !== 0x10b && optMagic !== 0x20b) throw new Error('未知可选头格式 0x' + optMagic.toString(16));
  // 数据目录：PE32 在可选头 +96，PE32+ 在 +112；资源目录是第 2 项（index 2）
  const ddBase = optOff + (is64 ? 112 : 96);
  const resRva = buf.readUInt32LE(ddBase + 2 * 8);
  if (!resRva) throw new Error('无资源段');
  // 节表（可选头固定大小：PE32 224 / PE32+ 240）
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const sOff = optOff + (is64 ? 240 : 224) + i * 40;
    sections.push({
      virtualAddress: buf.readUInt32LE(sOff + 12),
      virtualSize: buf.readUInt32LE(sOff + 8),
      pointerToRawData: buf.readUInt32LE(sOff + 20),
    });
  }
  const rootTree = parseResourceTree(buf, sections, resRva);
  if (!rootTree) throw new Error('资源段解析失败');
  // 收集 RT_GROUP_ICON 组（第二/三层用相对资源段起始的偏移）
  const groups = [];
  for (const typeEntry of rootTree.entries) {
    if (typeEntry.isNamed) continue;
    if (typeEntry.name === RT_GROUP_ICON || typeEntry.name === RT_ICON) {
      const kind = typeEntry.name === RT_GROUP_ICON ? 'group' : 'icon';
      const l2 = parseResourceTree(buf, sections, childRva(resRva, typeEntry.data));
      if (!l2) continue;
      for (const idEntry of l2.entries) {
        const l3 = parseResourceTree(buf, sections, childRva(resRva, idEntry.data));
        if (!l3) continue;
        for (const lang of l3.entries) {
          const payload = dataEntryPayload(buf, sections, resRva, lang.data);
          if (payload) groups.push({ kind, id: idEntry.isNamed ? idEntry.name : idEntry.name, payload });
        }
      }
    }
  }
  const grp = groups.find((g) => g.kind === 'group');
  if (!grp) throw new Error('未找到 RT_GROUP_ICON');
  if (grp.payload.length < 6) throw new Error('组图标数据过短');
  const count = grp.payload.readUInt16LE(4);
  const members = [];
  for (let i = 0; i < count; i++) {
    const m = 6 + i * 14;
    if (m + 14 > grp.payload.length) break;
    const width = grp.payload[m];
    const height = grp.payload[m + 1];
    const colors = grp.payload[m + 2];
    const planes = grp.payload.readUInt16LE(m + 4);
    const bitCount = grp.payload.readUInt16LE(m + 6);
    const byteSize = grp.payload.readUInt32LE(m + 8);
    const iconId = grp.payload.readUInt16LE(m + 12);
    const blob = groups.find((g) => g.kind === 'icon' && g.id === iconId);
    if (!blob || blob.payload.length < byteSize) continue;
    members.push({ width, height, colors, planes, bitCount, data: blob.payload.subarray(0, byteSize) });
  }
  if (members.length === 0) throw new Error('组图标下无可用成员');
  // 组装 ICO：ICONDIR + ICONDIRENTRY + 数据
  const ico = Buffer.alloc(6 + members.length * 16);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(members.length, 4);
  let offset = 6 + members.length * 16;
  members.forEach((m, i) => {
    const e = 6 + i * 16;
    ico[e] = m.width === 256 ? 0 : m.width;
    ico[e + 1] = m.height === 256 ? 0 : m.height;
    ico[e + 2] = m.colors;
    ico[e + 3] = 0;
    ico.writeUInt16LE(m.planes || 1, e + 4);
    ico.writeUInt16LE(m.bitCount, e + 6);
    ico.writeUInt32LE(m.data.length, e + 8);
    ico.writeUInt32LE(offset, e + 12);
    offset += m.data.length;
  });
  const blobs = Buffer.concat(members.map((m) => m.data));
  const icoBuf = Buffer.concat([ico, blobs]);
  // PNG：取最大的 PNG 编码成员；若有 BMP 编码则回退到第一个成员
  const pngMember = [...members].sort((a, b) => b.data.length - a.data.length).find((m) =>
    m.data.length > 8 && m.data[0] === 0x89 && m.data[1] === 0x50 && m.data[2] === 0x4e && m.data[3] === 0x47);
  return { ico: icoBuf, png: pngMember ? pngMember.data : null, members };
}

// 直接运行：提取并把结果写入目标
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const buf = readFileSync(exePath);
  const { ico, png } = extractExeIcon(buf);
  mkdirSync(path.dirname(outIco), { recursive: true });
  writeFileSync(outIco, ico);
  let note = 'ico 大小: ' + ico.length + ' 字节';
  if (png) {
    mkdirSync(path.dirname(outPng), { recursive: true });
    writeFileSync(outPng, png);
    note += '，png 大小: ' + png.length + ' 字节（' + (png.readUInt32BE(16) || '?') + 'x' + (png.readUInt32BE(20) || '?') + '）';
  } else {
    note += '，无 PNG 编码成员';
  }
  console.log('[OK] 已从 ' + path.basename(exePath) + ' 提取官方图标：' + note);
  console.log('     ico → ' + outIco);
  if (png) console.log('     png → ' + outPng);
}