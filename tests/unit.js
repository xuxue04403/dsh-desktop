// tests/unit.js — 无 Electron 依赖的纯逻辑单测
// 运行：node tests/unit.js（脚本内部不捕获子进程输出，适合受限环境）
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseFailedPlugins, resolveEntryIds } = require('../src/watchdog');
const { compareVersions, REGEX_URL_LINE } = require('../src/launcher');
const { validateConfigText } = require('../src/gateway-manager');
const { migrateGatewayConfig } = require('../src/datadir');
const { pngFromPixels, renderIcon, iconDataURL, iconPngBuffer, iconIcoBuffer, COLORS } = require('../src/icon');
const zlib = require('zlib');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// —— 看门狗：失败日志解析（0.1.x 两种报错形态）——
t('parseFailedPlugins 形态2 (did not activate)', () => {
  const log =
    'dsh: 1 entry did not activate\r\n' +
    '@linxin666/dsh-web-ui-all: Error: Cannot find module \'x\'\r\n' +
    '    at ModuleJob.run (node:internal/modules:96:1)\r\n';
  const names = parseFailedPlugins(log);
  assert.deepStrictEqual(names, ['@linxin666/dsh-web-ui-all']);
});

t('parseFailedPlugins 形态1 (failed to load: a, b)', () => {
  const log =
    'dsh: plugin(s) failed to load: dshmarket, @someone/dsh-chat-import; ' +
    'Cordis startup failed because these plugin(s) could not be resolved';
  const names = parseFailedPlugins(log);
  assert.deepStrictEqual(names, ['dshmarket', '@someone/dsh-chat-import']);
});

t('parseFailedPlugins 空日志 → 空', () => {
  assert.deepStrictEqual(parseFailedPlugins(''), []);
  assert.deepStrictEqual(parseFailedPlugins('no plugin failure here'), []);
});

// —— 看门狗：dump-config YAML → 条目 id 映射 ——
const YAML =
  '- id: dshmarket\r\n' +
  "  name: 'dshmarket'\r\n" +
  '  config: {}\r\n' +
  '- id: chat-import\r\n' +
  "  name: '@someone/dsh-chat-import'\r\n" +
  '  config: {}\r\n' +
  '- id: web-ui-all\r\n' +
  "  name: '@linxin666/dsh-web-ui-all'\r\n" +
  '  config: {}\r\n';

t('resolveEntryIds 命中 id', () => {
  const ids = resolveEntryIds(YAML, ['dshmarket', '@someone/dsh-chat-import']);
  assert.deepStrictEqual(ids, ['dshmarket', 'chat-import']);
});

t('resolveEntryIds 无关名 → 空', () => {
  const ids = resolveEntryIds(YAML, ['node_modules', 'dsh']);
  assert.deepStrictEqual(ids, []);
});

t('resolveEntryIds 空输入 → 空', () => {
  assert.deepStrictEqual(resolveEntryIds(null, ['x']), []);
  assert.deepStrictEqual(resolveEntryIds(YAML, []), []);
});

// —— launcher：版本比较与 URL 就绪行契约 ——
t('compareVersions 基础', () => {
  assert.ok(compareVersions('0.1.3-alpha.1', '0.1.2-rc.1') > 0);
  assert.ok(compareVersions('0.1.2-rc.1', '0.1.2-rc.1') === 0);
  assert.ok(compareVersions('0.1.1-rc.2', '0.1.2-rc.1') < 0);
});

t('REGEX_URL_LINE 匹配 dsh web 就绪行（含 token）', () => {
  const line = 'dsh web: http://127.0.0.1:3080/?token=abc123 (LAN: http://192.168.1.2:3080/?token=abc123)';
  const m = REGEX_URL_LINE.exec(line);
  assert.ok(m, '应匹配二维码行');
  assert.strictEqual(m[1], 'http://127.0.0.1:3080/?token=abc123');
});

// —— 模型网关：供应商配置校验 ——
const GOOD_CFG = JSON.stringify({
  port: 3090,
  apiKey: 'k',
  providers: [
    { id: 'a', baseURL: 'https://a.com/v1', apiKey: 'sk-1', models: ['m1'], priority: 1, enabled: true },
  ],
});

t('validateConfigText 合法配置', () => {
  const r = validateConfigText(GOOD_CFG);
  assert.strictEqual(r.ok, true);
});

t('validateConfigText 非法 JSON → 拒绝', () => {
  const r = validateConfigText('{not json');
  assert.strictEqual(r.ok, false);
});

t('validateConfigText 缺 providers → 拒绝', () => {
  const r = validateConfigText(JSON.stringify({ port: 3090, apiKey: 'k' }));
  assert.strictEqual(r.ok, false);
});

t('validateConfigText 供应商缺 baseURL → 拒绝', () => {
  const r = validateConfigText(JSON.stringify({
    port: 3090, providers: [{ id: 'x', apiKey: 'sk' }],
  }));
  assert.strictEqual(r.ok, false);
});

// —— 数据目录：网关注入配置一次性迁移 ——
const GATEWAY_CFG = JSON.stringify({
  port: 3090,
  apiKey: 'dsh-gw-test-123',
  providers: [
    { id: 'mockA', baseURL: 'http://127.0.0.1:3190/v1', apiKey: 'k-a', models: ['deepseek-v4-flash', 'glm-5.2'], priority: 1, enabled: true },
    { id: 'mockB', baseURL: 'http://127.0.0.1:3191/v1', apiKey: 'k-b', models: ['deepseek-v4-flash'], priority: 2, enabled: true },
  ],
});

t('migrateGatewayConfig 从已有来源复制到空目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const src = path.join(base, 'legacy', 'gateway.config.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, GATEWAY_CFG, 'utf8');
  const out = path.join(base, 'data');
  const from = migrateGatewayConfig(out, [src]);
  assert.strictEqual(from, src);
  assert.strictEqual(fs.readFileSync(path.join(out, 'gateway.config.json'), 'utf8'), GATEWAY_CFG);
});

t('migrateGatewayConfig 目标已存在 → 不覆盖', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const src = path.join(base, 'legacy', 'gateway.config.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, GATEWAY_CFG, 'utf8');
  const out = path.join(base, 'data');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'gateway.config.json'), '{"custom":1}', 'utf8');
  const from = migrateGatewayConfig(out, [src]);
  assert.strictEqual(from, null);
  assert.strictEqual(fs.readFileSync(path.join(out, 'gateway.config.json'), 'utf8'), '{"custom":1}');
});

t('migrateGatewayConfig 来源缺失 → null', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const out = path.join(base, 'data');
  fs.mkdirSync(out, { recursive: true });
  const from = migrateGatewayConfig(out, [path.join(base, 'missing', 'gateway.config.json')]);
  assert.strictEqual(from, null);
  assert.strictEqual(fs.existsSync(path.join(out, 'gateway.config.json')), false);
});

// —— 官方图标资源（与 DSH-App.exe 内嵌图标一致）——
const OFFICIAL_PNG = path.join(__dirname, '..', 'src', 'assets', 'electron-icon.png');
const OFFICIAL_ICO = path.join(__dirname, '..', 'src', 'assets', 'electron-icon.ico');

t('官方图标资源存在', () => {
  assert.ok(fs.existsSync(OFFICIAL_PNG), 'electron-icon.png 应存在');
  assert.ok(fs.existsSync(OFFICIAL_ICO), 'electron-icon.ico 应存在');
});

t('官方图标 PNG：魔数 / 256x256', () => {
  const png = fs.readFileSync(OFFICIAL_PNG);
  assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 魔数');
  assert.strictEqual(png.readUInt32BE(16), 256, '宽度');
  assert.strictEqual(png.readUInt32BE(20), 256, '高度');
});

t('官方图标 ICO：头结构 / 多尺寸 / 256 为 PNG', () => {
  const ico = fs.readFileSync(OFFICIAL_ICO);
  assert.strictEqual(ico.readUInt16LE(0), 0, 'reserved');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'type=icon');
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 2, '应含多个尺寸，实际 ' + count);
  const sizes = [];
  let bigPng = false;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const w = ico[e], h = ico[e + 1];
    const off = ico.readUInt32LE(e + 12);
    const isPng = ico.subarray(off, off + 8).toString('hex') === '89504e470d0a1a0a';
    if (w === 0 && h === 0) { sizes.push(256); if (!isPng) bigPng = false; }
    else { sizes.push(w); if (w !== h) assert.fail('图标应正方形但见 ' + w + 'x' + h); }
    if (w === 0 && !isPng) assert.fail('256 条目应为 PNG 编码');
  }
  for (const want of [16, 32, 48, 256]) {
    assert.ok(sizes.includes(want), '应含 ' + want + 'px 条目，实际 [' + sizes.join(',') + ']');
  }
});

// —— 图标生成：PNG 结构 ——
t('icon：PNG 魔数 / IHDR 尺寸 / IDAT 可解压', () => {
  const png = iconPngBuffer(16, COLORS.brand);
  assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 魔数');
  assert.strictEqual(png.readUInt32BE(16), 16, '宽度');
  assert.strictEqual(png.readUInt32BE(20), 16, '高度');
  // 找 IDAT 并解压：原始数据长度 = 高度 × (1 + 宽度 × 4)
  let off = 8, idat = null;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') { idat = png.subarray(off + 8, off + 8 + len); break; }
    off += 12 + len;
  }
  assert.ok(idat, '应有 IDAT chunk');
  const raw = zlib.inflateSync(idat);
  assert.strictEqual(raw.length, 16 * (1 + 16 * 4), '原始像素数据长度');
});

t('icon：renderIcon 中心不透明、圆外透明、轨道存在白色', () => {
  const s = renderIcon(16, COLORS.brand);
  assert.strictEqual(s.width, 16);
  const at = (x, y) => s.buffer[(y * 16 + x) * 4 + 3];
  const isWhite = (x, y) => {
    const i = (y * 16 + x) * 4;
    return s.buffer[i + 3] === 255 && s.buffer[i] === 255 && s.buffer[i + 1] === 255 && s.buffer[i + 2] === 255;
  };
  assert.strictEqual(at(8, 8), 255, '中心应不透明');
  assert.strictEqual(at(0, 0), 0, '圆形外围应透明');
  // 水平轨道右段附近应有白色像素（轨道线）
  let trackWhite = false;
  for (let x = 10; x <= 15; x++) {
    for (let y = 6; y <= 10; y++) {
      if (isWhite(x, y)) { trackWhite = true; break; }
    }
    if (trackWhite) break;
  }
  assert.ok(trackWhite, '右侧轨道区域应有白色轨道路径');
});

t('icon：iconDataURL 前缀正确', () => {
  assert.ok(iconDataURL(16, COLORS.brand).startsWith('data:image/png;base64,'));
});

t('icon：ICO 结构（头/条目/嵌入 PNG 魔数）', () => {
  const ico = iconIcoBuffer(COLORS.brand, [16, 32, 256]);
  assert.strictEqual(ico.readUInt16LE(0), 0, 'reserved');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'type=icon');
  const count = ico.readUInt16LE(4);
  assert.strictEqual(count, 3);
  // 每条目应以 PNG 魔数开头（PNG-in-ICO）
  for (let i = 0; i < count; i++) {
    const off = ico.readUInt32LE(6 + i * 16 + 12);
    assert.strictEqual(ico.subarray(off, off + 8).toString('hex'), '89504e470d0a1a0a', '第 ' + i + ' 条应为 PNG');
  }
  // 尺寸字段：16/32/256（256 记 0）
  assert.strictEqual(ico[6], 16);
  assert.strictEqual(ico[6 + 16], 32);
  assert.strictEqual(ico[6 + 32], 0);
});

console.log('');
console.log('===== ' + passed + ' passed, 0 failed =====');