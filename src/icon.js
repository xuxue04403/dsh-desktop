// icon.js — 程序化生成应用/托盘 PNG 图标（零外部资源，纯 Node 实现）
//
// 图形：品牌蓝圆角方块 + 白色圆点。支持任意尺寸与主色（托盘图标随服务状态变色）。
// 实现：手绘 RGBA 像素 → PNG 编码（zlib deflate + 表驱动 CRC32），与 Electron nativeImage 直接兼容。
'use strict';

const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// —— CRC32（PNG chunk 校验）——
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// 由 RGBA 像素编码 PNG（rgba: Buffer/TypedArray，长度 w*h*4，行序自上而下）
function pngFromPixels(w, h, rgba) {
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  // 一次性建立整块像素的 view（避免按行重复拷贝的越界问题）
  const rgbaView = Buffer.from(rgba.buffer || rgba, rgba.byteOffset || 0, rgba.length || w * h * 4);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;   // filter: None
    rgbaView.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 渲染品牌徽标：圆角方块（主色）+ 中心白色圆点，外围透明
function renderIcon(size, rgb) {
  const w = size, h = size;
  const rgba = new Uint8Array(w * h * 4);
  const r = rgb[0], g = rgb[1], b = rgb[2];
  const corner = Math.max(1, Math.round(size * 0.22));      // 圆角半径
  const dotR = Math.max(1, size * 0.2);                     // 中心白点半径
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // 圆角矩形判定
      const inRect =
        x >= corner && x < w - corner ? true :
        y >= corner && y < h - corner ? true :
        Math.hypot(x - (x < corner ? corner : w - 1 - corner), y - (y < corner ? corner : h - 1 - corner)) <= corner;
      if (!inRect) { rgba[i + 3] = 0; continue; }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      // 中心白点
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= dotR * dotR) {
        rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255;
      }
    }
  }
  return { buffer: Buffer.from(rgba.buffer), width: w, height: h };
}

// 生成 dataURL（Electron nativeImage.createFromDataURL 直接可用）
function iconDataURL(size, rgb) {
  const png = pngFromPixels(size, size, renderIcon(size, rgb).buffer);
  return 'data:image/png;base64,' + png.toString('base64');
}

// 生成 PNG Buffer（写文件用）
function iconPngBuffer(size, rgb) {
  return pngFromPixels(size, size, renderIcon(size, rgb).buffer);
}

// 生成 ICO（PNG-in-ICO，Vista+ 标准）：多尺寸条目（16/32/256）+ 品牌蓝。
// 供 rcedit / electron-builder 设置 exe 图标，保证托盘/窗口/exe 图案一致。
function iconIcoBuffer(rgb, sizes) {
  const list = sizes || [16, 32, 256];
  const pngs = list.map((s) => iconPngBuffer(s, rgb));
  const count = pngs.length;
  const headerLen = 6;
  const entryLen = 16;
  const dataOffset = headerLen + count * entryLen;
  const total = dataOffset + pngs.reduce((n, p) => n + p.length, 0);
  const buf = Buffer.alloc(total);
  buf.writeUInt16LE(0, 0);            // reserved
  buf.writeUInt16LE(1, 2);            // type: icon
  buf.writeUInt16LE(count, 4);
  let off = dataOffset;
  for (let i = 0; i < count; i++) {
    const s = list[i];
    const e = headerLen + i * entryLen;
    buf[e] = s >= 256 ? 0 : s;        // width（0=256）
    buf[e + 1] = s >= 256 ? 0 : s;    // height
    buf[e + 2] = 0;                   // palette
    buf[e + 3] = 0;                   // reserved
    buf.writeUInt16LE(1, e + 4);      // planes
    buf.writeUInt16LE(32, e + 6);     // bpp
    buf.writeUInt32LE(pngs[i].length, e + 8);
    buf.writeUInt32LE(off, e + 12);
    pngs[i].copy(buf, off);
    off += pngs[i].length;
  }
  return buf;
}

// 品牌蓝与其他状态色（与界面状态色一致）
const COLORS = {
  brand: [47, 91, 215],
  stopped: [138, 147, 163],
  starting: [245, 185, 60],
  ready: [62, 207, 142],
  failed: [232, 84, 77],
  safe: [240, 155, 60],
};

module.exports = { pngFromPixels, renderIcon, iconDataURL, iconPngBuffer, iconIcoBuffer, COLORS };