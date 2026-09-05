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

// 渲染图标：深色圆底 + 白色原子轨道（与 Electron 官方 exe 图标同一风格）。
// 底色 = rgb（服务状态色：运行时托盘随状态变色；白色轨道/中心点不变）。
function renderIcon(size, rgb) {
  const w = size, h = size;
  const rgba = new Uint8Array(w * h * 4);
  const r = rgb[0], g = rgb[1], b = rgb[2];
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const RR = w / 2 - Math.max(1, size * 0.02);       // 圆底半径（留 1px 抗锯齿余量）

  // 三条椭圆轨道（±35° / 水平）
  const a = w * 0.40, bb = w * 0.17;
  const tracks = [];
  for (const th of [-0.6, 0, 0.6]) {
    const cos = Math.cos(th), sin = Math.sin(th);
    const pts = [];
    for (let k = 0; k <= 180; k++) {
      const t = (Math.PI * 2 * k) / 180;
      const x0 = a * Math.cos(t), y0 = bb * Math.sin(t);
      pts.push([cx + x0 * cos - y0 * sin, cy + x0 * sin + y0 * cos]);
    }
    tracks.push(pts);
  }
  // 轨道长轴两端的空心环点
  const dots = [];
  for (const th of [-0.6, 0, 0.6]) {
    const cos = Math.cos(th), sin = Math.sin(th);
    dots.push([cx + a * 0.86 * cos, cy + a * 0.86 * sin]);
    dots.push([cx - a * 0.86 * cos, cy - a * 0.86 * sin]);
  }

  const lineW2 = Math.max(1, size * 0.052) / 2;       // 轨道线宽/2
  const ringIn2 = Math.pow(size * 0.03, 2);           // 环点内径²
  const ringOut2 = Math.pow(size * 0.105, 2);         // 环点外径²
  const centerR2 = Math.pow(Math.max(1, size * 0.075), 2);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > RR * RR) { rgba[i + 3] = 0; continue; }   // 圆外透明
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;

      let white = d2 <= centerR2;
      // 轨道（采样点最近距离判定，先粗筛再精算）
      if (!white) {
        for (const pts of tracks) {
          if (Math.abs(x - cx) > a + Math.max(1, size * 0.06) && Math.abs(y - cy) > a + Math.max(1, size * 0.06)) continue;
          let best = Infinity;
          for (const p of pts) {
            const ddx = x - p[0], ddy = y - p[1];
            const dd = ddx * ddx + ddy * ddy;
            if (dd < best) best = dd;
            if (best <= lineW2 * lineW2) break;
          }
          if (best <= lineW2 * lineW2) { white = true; break; }
        }
      }
      // 空心环点（轨道端点）
      if (!white) {
        for (const dot of dots) {
          const ddx = x - dot[0], ddy = y - dot[1];
          const dd = ddx * ddx + ddy * ddy;
          if (dd >= ringIn2 && dd <= ringOut2) { white = true; break; }
        }
      }

      if (white) { rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; }
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