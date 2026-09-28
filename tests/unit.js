// tests/unit.js — 无 Electron 依赖的纯逻辑单测
// 运行：node tests/unit.js（脚本内部不捕获子进程输出，适合受限环境）
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseFailedPlugins, resolveEntryIds, classifyDidNotActivate, isolationCandidates } = require('../src/watchdog');
const { compareVersions, REGEX_URL_LINE } = require('../src/launcher');
const { validateConfigText } = require('../src/gateway-manager');
const { migrateGatewayConfig, isMockLikeConfig } = require('../src/datadir');
const { pngFromPixels, renderIcon, iconDataURL, iconPngBuffer, iconIcoBuffer, COLORS } = require('../src/icon');
const zlib = require('zlib');

let passed = 0;
let failed = 0;
// 异步用例的待决 promise（v1.9.2：多标签择优是 async 逻辑，必须真等到它跑完再统计）。
// 旧实现 `fn()` 不 await —— 异步用例会先打印 PASS、断言却还没执行，失败变成未处理拒绝，
// 等于"看起来通过、其实没测"。这与 v190.test.js 修过的"一个失败掩盖后续全部"是同类问题。
const pending = [];
function t(name, fn) {
  let r;
  try { r = fn(); } catch (e) { throw e; }   // 同步用例沿用原语义：抛出即整体失败
  if (r && typeof r.then === 'function') {
    pending.push(r.then(
      () => { passed++; console.log('PASS  ' + name); },
      (e) => { failed++; console.error('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e)); },
    ));
    return;
  }
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

// 审计修复回归：旧实现把预发布标识当普通段比较 → `0.1.3-alpha.1` 被判为高于 `0.1.3`
// （与 semver 相反，会导致 findDsh 选错版本 / 对最新稳定版反复提示升级）
t('compareVersions 符合 semver 预发布规则', () => {
  assert.ok(compareVersions('0.1.3', '0.1.3-alpha.1') > 0, '正式版 > 同号预发布版');
  assert.ok(compareVersions('0.1.5-rc.1', '0.1.5') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0, '段数少者更小');
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0, '数字标识符 < 字母标识符');
  assert.ok(compareVersions('v0.1.5-rc.1', '0.1.4') > 0, '容忍 v 前缀');
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
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
  // 第四轮：顶层统一 Key 必须 ≥16 字符（网关 authorized() 的门槛，见 validateConfigText 注释）
  apiKey: 'dsh-gateway-testkey-0123456789',
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
// "真实"配置（非模拟特征：无 mock id / 127.0.0.1:319x / provider-a / example.com）
const GATEWAY_CFG = JSON.stringify({
  port: 3090,
  apiKey: 'dsh-gw-fixture-000',
  clientUA: 'claude-cli/2.0.0 (external, cli)',
  routing: 'round-robin',
  providers: [
    { id: 'agentrouter', baseURL: 'https://agentrouter.org/', apiKey: 'sk-real-1', models: ['deepseek-v4-flash', 'glm-5.3'], priority: 1, enabled: true },
    { id: 'air-outer', baseURL: 'https://ps.air-outer.com/', apiKey: 'sk-real-2', models: ['deepseek-v4-flash'], priority: 2, enabled: true },
  ],
});
// "模拟"配置（桌面助手自带 mock 源 / 示例文件特征）
const MOCK_CFG = JSON.stringify({
  port: 3090,
  apiKey: 'dsh-gw-fixture-000',
  providers: [
    { id: 'mockA', baseURL: 'http://127.0.0.1:3190/v1', apiKey: 'k-a', models: ['deepseek-v4-flash', 'glm-5.2'], priority: 1, enabled: true },
    { id: 'mockB', baseURL: 'http://127.0.0.1:3191/v1', apiKey: 'k-b', models: ['deepseek-v4-flash'], priority: 2, enabled: true },
  ],
});

t('isMockLikeConfig 识别模拟/示例/真实', () => {
  assert.strictEqual(isMockLikeConfig(MOCK_CFG), true, 'mockA/B 应判为模拟');
  assert.strictEqual(isMockLikeConfig(GATEWAY_CFG), false, '真实供应商不应判为模拟');
  assert.strictEqual(isMockLikeConfig('{"providers":[{"id":"provider-a","baseURL":"https://api.example.com/v1"}]}'), true, '示例应判为模拟');
  assert.strictEqual(isMockLikeConfig(''), true, '空内容应判为模拟');
  assert.strictEqual(isMockLikeConfig('not json'), true, '非法 JSON 应判为模拟');
});

t('migrateGatewayConfig 从已有真实来源复制到空目录（R25：3090 归一为 3091）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const src = path.join(base, 'legacy', 'gateway.config.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, GATEWAY_CFG, 'utf8');   // GATEWAY_CFG.port = 3090
  const out = path.join(base, 'data');
  const r = migrateGatewayConfig(out, [src]);
  assert.ok(r && r.action === 'migrated', '应迁移');
  const migrated = JSON.parse(fs.readFileSync(path.join(out, 'gateway.config.json'), 'utf8'));
  assert.strictEqual(migrated.port, 3091, '迁移应把 3090 归一为 3091（R22 约定）');
  assert.strictEqual(migrated.apiKey, 'dsh-gw-fixture-000', '其余字段原样保留');
  assert.strictEqual(migrated.providers.length, 2, '供应商原样保留');
});

t('migrateGatewayConfig 模拟来源 → 跳过（真实源 3090 同样归一 3091）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const srcMock = path.join(base, 'mock', 'gateway.config.json');
  const srcReal = path.join(base, 'real', 'gateway.config.json');
  fs.mkdirSync(path.dirname(srcMock), { recursive: true });
  fs.mkdirSync(path.dirname(srcReal), { recursive: true });
  fs.writeFileSync(srcMock, MOCK_CFG, 'utf8');
  fs.writeFileSync(srcReal, GATEWAY_CFG, 'utf8');
  const out = path.join(base, 'data');
  const r = migrateGatewayConfig(out, [srcMock, srcReal]);
  assert.ok(r && r.from === srcReal, '应跳过模拟源、命中真实源');
  const migrated = JSON.parse(fs.readFileSync(path.join(out, 'gateway.config.json'), 'utf8'));
  assert.strictEqual(migrated.port, 3091, '3090 → 3091');
  assert.strictEqual(migrated.providers.length, 2);
});

t('migrateGatewayConfig 非 3090 端口原样保留', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const src = path.join(base, 'legacy', 'gateway.config.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  const custom = JSON.stringify({ port: 3105, apiKey: 'k', providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'sk', models: ['m'] }] });
  fs.writeFileSync(src, custom, 'utf8');
  const out = path.join(base, 'data');
  const r = migrateGatewayConfig(out, [src]);
  assert.ok(r && r.action === 'migrated');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'gateway.config.json'), 'utf8')).port, 3105, '非 3090 不改写');
});

t('migrateGatewayConfig 目标为真实配置 → 不覆盖', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const src = path.join(base, 'legacy', 'gateway.config.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, GATEWAY_CFG, 'utf8');
  const out = path.join(base, 'data');
  fs.mkdirSync(out, { recursive: true });
  const custom = JSON.stringify({ port: 3091, providers: [{ id: 'my-own', baseURL: 'https://my.api/v1', apiKey: 'sk', models: ['m'] }] });
  fs.writeFileSync(path.join(out, 'gateway.config.json'), custom, 'utf8');
  const r = migrateGatewayConfig(out, [src]);
  assert.strictEqual(r, null, '真实配置不应被覆盖');
  assert.strictEqual(fs.readFileSync(path.join(out, 'gateway.config.json'), 'utf8'), custom);
});

t('migrateGatewayConfig 目标为模拟数据 → 升级覆盖（保留备份；R25：3090 归一 3091）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const src = path.join(base, 'real', 'gateway.config.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, GATEWAY_CFG, 'utf8');
  const out = path.join(base, 'data');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'gateway.config.json'), MOCK_CFG, 'utf8');
  const r = migrateGatewayConfig(out, [src]);
  assert.ok(r && r.action === 'upgraded', '应升级');
  const upgraded = JSON.parse(fs.readFileSync(path.join(out, 'gateway.config.json'), 'utf8'));
  assert.strictEqual(upgraded.port, 3091, '3090 → 3091');
  assert.strictEqual(upgraded.providers.length, 2, '真实供应商替换模拟配置');
  assert.strictEqual(fs.readFileSync(path.join(out, 'gateway.config.json.bak-mock'), 'utf8'), MOCK_CFG, '旧模拟配置应备份');
});

t('migrateGatewayConfig 来源缺失 → null', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const out = path.join(base, 'data');
  fs.mkdirSync(out, { recursive: true });
  const r = migrateGatewayConfig(out, [path.join(base, 'missing', 'gateway.config.json')]);
  assert.strictEqual(r, null);
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

// —— v1.7.0/R24：看门狗识别「loader entry 导入/应用失败」（2026-09-10 事故形态）——
t('parseFailedPlugins 形态3：loader entry 导入失败（包被清理）→ 捕获包名', () => {
  const log =
    'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): ' +
    "failed to import loader entry email (dsh-email-bridge): Cannot find package 'dsh-email-bridge' imported from C:\\x\\profiles\\web\\\r\n";
  const names = parseFailedPlugins(log);
  assert.deepStrictEqual(names, ['dsh-email-bridge'], '应捕获括号里的包名（与 dump-config 的 name 字段配对）');
});

t('parseFailedPlugins 形态3：无包名时退回条目 id', () => {
  const names = parseFailedPlugins('failed to apply loader entry email: invalid config');
  assert.deepStrictEqual(names, ['email']);
});

t('parseFailedPlugins 形态3：仅 cordis:include 包装 → 空（不可隔离核心插件）', () => {
  const names = parseFailedPlugins('failed to apply loader entry include (cordis:include): inner error');
  assert.deepStrictEqual(names, [], 'cordis:* 必须被过滤');
});

t('parseFailedPlugins 形态3：双插件同时故障 → 全部收集', () => {
  const log = 'failed to import loader entry email (dsh-email-bridge): not found\r\n'
    + 'failed to import loader entry qqbot (dsh-qqbot): not found\r\n';
  const names = parseFailedPlugins(log);
  assert.deepStrictEqual(names, ['dsh-email-bridge', 'dsh-qqbot']);
});

// —— 2026-09-22 新电脑事故：安全模式把"依赖受害者"当故障隔离，导致结构性启动失败 ——
// 现场日志（web.log）：13 条 pending 全是「等依赖」，而生成的 safe.yml 却禁用了
// typert / settings / credentials / llm-pi-ai / connection / sandbox-policy 等**服务提供者**，
// 安全模式自身必然起不来（用户被锁死在无法自愈的状态）。
const DID_NOT_ACTIVATE_LOG = [
  'dsh: 13 entries did not activate',
  '@deepseek-ai/dsh-typert-loader: pending (waiting for service: typert)',
  '@deepseek-ai/dsh-api-gateway: pending (waiting for service: typert)',
  '@deepseek-ai/dsh-pwsh-sandbox: pending (waiting for service: sandboxPolicy)',
  '@deepseek-ai/dsh-session-log-export: pending (waiting for service: connection)',
  '@deepseek-ai/dsh-api-workspace-files: pending (waiting for services: fs, sandboxPolicy, typert)',
  '',
].join('\r\n');

t('classifyDidNotActivate：pending(等依赖) 与真 Error 必须分开', () => {
  const r = classifyDidNotActivate(DID_NOT_ACTIVATE_LOG);
  assert.deepStrictEqual(r.faults, [], '待依赖行不是真故障：' + JSON.stringify(r.faults));
  assert.strictEqual(r.dependents.length, 5, '应识别出 5 条受害者：' + r.dependents.length);
  const mixed = classifyDidNotActivate(
    'dsh: 2 entries did not activate\r\n'
    + '@linxin666/dsh-web-ui-all: Error: Cannot find module \'x\'\r\n'
    + '@deepseek-ai/dsh-typert-loader: pending (waiting for service: typert)\r\n',
  );
  assert.deepStrictEqual(mixed.faults.map((f) => f.name), ['@linxin666/dsh-web-ui-all']);
  assert.deepStrictEqual(mixed.dependents.map((d) => d.name), ['@deepseek-ai/dsh-typert-loader']);
});

t('isolationCandidates：纯"等依赖"级联 → 一个都不隔离（旧版会把核心服务也禁掉）', () => {
  const v = isolationCandidates(DID_NOT_ACTIVATE_LOG, { thirdParty: new Set() });
  assert.deepStrictEqual(v.names, [], '不得隔离任何条目：' + JSON.stringify(v.names));
  assert.ok(/等依赖|受害者/.test(v.reason), '原因应说明是依赖级联：' + v.reason);
});

t('isolationCandidates：真故障是第三方插件 → 可隔离；核心 dsh-* 故障 → 不隔离', () => {
  const tp = new Set(['@linxin666/dsh-web-ui-all']);
  const v1 = isolationCandidates(
    'dsh: 1 entry did not activate\r\n@linxin666/dsh-web-ui-all: Error: Cannot find module \'x\'\r\n',
    { thirdParty: tp },
  );
  assert.deepStrictEqual(v1.names, ['@linxin666/dsh-web-ui-all'], '第三方真故障应可隔离：' + JSON.stringify(v1.names));
  const v2 = isolationCandidates(
    'dsh: 1 entry did not activate\r\n@deepseek-ai/dsh-llm-pi-ai: Error: boom\r\n',
    { thirdParty: tp },
  );
  assert.deepStrictEqual(v2.names, [], '核心服务故障不得隔离（禁了就没有服务提供者）：' + JSON.stringify(v2.names));
  assert.ok(/核心/.test(v2.reason), '原因应点明核心条目：' + v2.reason);
});

t('isolationCandidates：故障条目过多 → 判定系统性故障，不做 Level 1 隔离', () => {
  const tp = new Set(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  const lines = ['dsh: 8 entries did not activate'];
  for (const n of tp) lines.push(n + ': Error: boom');
  const v = isolationCandidates(lines.join('\r\n') + '\r\n', { thirdParty: tp });
  assert.deepStrictEqual(v.names, [], '过多故障不应逐个隔离：' + JSON.stringify(v.names));
  assert.ok(/系统性/.test(v.reason), '原因应说明系统性：' + v.reason);
});

t('validateConfigText R22 端口校验：缺/非法端口拒绝', () => {
  const mk = (port) => JSON.stringify({ port, apiKey: 'dsh-gateway-testkey-0123456789', providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'sk', models: ['m'] }] });
  assert.strictEqual(validateConfigText(mk(3091)).ok, true, '3091 合法');
  assert.strictEqual(validateConfigText(mk(3090)).ok, true, '3090 也合法（只是约定不同）');
  const noPort = JSON.stringify({ apiKey: 'k', providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'sk', models: ['m'] }] });
  assert.strictEqual(validateConfigText(noPort).ok, false, '缺 port 拒绝');
  assert.strictEqual(validateConfigText(mk('abc')).ok, false, 'port=abc 拒绝');
  assert.strictEqual(validateConfigText(mk(0)).ok, false, 'port=0 拒绝');
  assert.strictEqual(validateConfigText(mk(70000)).ok, false, 'port=70000 拒绝');
  assert.strictEqual(validateConfigText(mk(3091.5)).ok, false, 'port=3091.5 拒绝');
});

t('main.js 接线冒烟（B1 回归）：verifyDefaultPlugins 必须导入且在启动前调用', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(/const\s*\{[^}]*verifyDefaultPlugins[^}]*\}\s*=\s*require\('\.\/default-plugins'\)/.test(src),
    'require 解构必须包含 verifyDefaultPlugins（B1：漏导入曾使 R24 自检静默失效）');
  assert.ok(src.includes('await verifyDefaultPluginsBeforeStart();'), 'startService 必须在启动前 await 自检');
});

// ================= 2026-09-27：dsh 版本分叉导致"历史会话丢失"的根因回归 =================
// 事故链：安装/升级写死 @latest → 主目录手工装了 next(0.1.7-rc.2)、UAT 重装回 latest(0.1.5-rc.3)
// → 两个绿色目录共用同一个 ~/.dsh（本应用不设 DSH_HOME）→ 旧版 dsh 把共享的 settings.yaml
// 改名为 settings.yaml.imported、重写会话索引 → 另一侧"历史会话丢失"。
// 因此这两条必须锁死：① 安装/升级标签可配置且同一处决策；② 版本变化必须留下告警。

t('dsh-tag：缺省同时评估 latest + next（不写死单标签）；DSH_DSH_TAG 可钉住；非法值回退', () => {
  const dshTag = require('../src/dsh-tag');
  const saved = process.env.DSH_DSH_TAG;
  const reload = () => { delete require.cache[require.resolve('../src/dsh-tag')]; return require('../src/dsh-tag'); };
  try {
    delete process.env.DSH_DSH_TAG;
    let m = reload();
    // v1.9.2 核心：缺省不是"跟随 latest"，而是"评估 latest 与 next，取高者"
    assert.deepStrictEqual(m.dshCandidateTags(), ['latest', 'next'],
      '缺省候选必须是 latest + next —— 只跟 latest 会永远看不到发在 next 上的新版本');
    assert.strictEqual(m.dshDistTag(), 'latest', '无显式指定时，首次安装仍走稳定通道');
    assert.strictEqual(m.dshInstallSpec(), '@deepseek-ai/dsh@latest');
    assert.ok(m.dshVersionUrl().endsWith('/@deepseek-ai/dsh/latest'), '查询端点应跟随标签：' + m.dshVersionUrl());
    assert.strictEqual(m.dshUpgradeCommand(), 'npm i -g @deepseek-ai/dsh@latest');
    // 按标签/按确切版本取端点与规格
    assert.ok(m.dshVersionUrlFor('next').endsWith('/@deepseek-ai/dsh/next'));
    assert.strictEqual(m.dshInstallSpecFor('0.2.0-rc.1'), '@deepseek-ai/dsh@0.2.0-rc.1');
    assert.strictEqual(m.dshUpgradeCommandFor('0.2.0-rc.1'), 'npm i -g @deepseek-ai/dsh@0.2.0-rc.1');

    // 显式钉住：只评估这一个（不再自动取高者）
    process.env.DSH_DSH_TAG = 'next';
    m = reload();
    assert.deepStrictEqual(m.dshCandidateTags(), ['next'], '显式钉住时不应再自动比较其它标签');
    assert.strictEqual(m.dshDistTag(), 'next', 'DSH_DSH_TAG 应生效');
    assert.strictEqual(m.dshInstallSpec(), '@deepseek-ai/dsh@next', '安装规格必须跟随标签');
    assert.ok(m.dshVersionUrl().endsWith('/@deepseek-ai/dsh/next'), '查询端点必须跟随标签');
    assert.strictEqual(m.dshUpgradeCommand(), 'npm i -g @deepseek-ai/dsh@next');

    // 精确版本号也应被接受（用户可钉死版本）
    process.env.DSH_DSH_TAG = '0.1.7-rc.2';
    m = reload();
    assert.strictEqual(m.dshInstallSpec(), '@deepseek-ai/dsh@0.1.7-rc.2');
    assert.deepStrictEqual(m.dshCandidateTags(), ['0.1.7-rc.2']);

    // 含空格/分号等可疑字符的值一律当作"未指定"，绝不拼进 npm 命令行
    for (const bad of ['bad; rm -rf /', 'a b', '$(whoami)', 'x&y']) {
      process.env.DSH_DSH_TAG = bad;
      m = reload();
      assert.strictEqual(m.dshDistTag(), 'latest', '非法标签必须回退 latest：' + bad);
      assert.deepStrictEqual(m.dshCandidateTags(), ['latest', 'next'], '非法值应按"未指定"处理：' + bad);
    }
  } finally {
    if (saved === undefined) delete process.env.DSH_DSH_TAG; else process.env.DSH_DSH_TAG = saved;
    delete require.cache[require.resolve('../src/dsh-tag')];
  }
});

// v1.9.2 回归：多标签"取版本最高者"的判定逻辑（不联网——直接喂假的标签查询结果）
// 事故背景：2026-09-29 用户报"0.2.0-rc1 已发布，启动时为什么没有自动更新"——
// latest 追平到 0.1.7-rc.2 的同时 next 前进到 0.2.0-rc.1，只查 latest 的实现永远看不到它。
t('updater.bestRelease：同时查多个标签并取版本最高者；单标签失败降级、全失败返回 null', async () => {
  const updaterPath = require.resolve('../src/updater');
  const tagPath = require.resolve('../src/dsh-tag');
  const saved = process.env.DSH_DSH_TAG;
  delete process.env.DSH_DSH_TAG;

  // 用假的 dsh-tag 顶替真实模块：候选固定，端点无关紧要
  const realTag = require('../src/dsh-tag');
  const fakeTag = Object.assign({}, realTag, {
    dshCandidateTags: () => ['latest', 'next'],
    dshVersionUrlFor: (t) => 'fake://' + t,
  });
  require.cache[tagPath] = { id: tagPath, filename: tagPath, loaded: true, exports: fakeTag };
  delete require.cache[updaterPath];
  const updater = require('../src/updater');

  const scenarios = {
    // next 更高 → 选 next（注入点收到的是**标签名**，不是 URL）
    'next': '0.2.0-rc.1',
    'latest': '0.1.7-rc.2',
  };
  const stub = (map) => {
    updater.__setFetchForTest(async (tag) => (tag in map ? map[tag] : null));
  };
  assert.strictEqual(typeof updater.__setFetchForTest, 'function',
    'updater 必须暴露测试用的查询注入点（否则多标签择优逻辑无法离线回归）');

  try {
    stub(scenarios);
    let best = await updater.bestRelease();
    assert.strictEqual(best.version, '0.2.0-rc.1', '应选版本更高的 next');
    assert.strictEqual(best.tag, 'next');
    assert.strictEqual(best.tags.length, 2, '应带回两个标签各自的查询结果');
    assert.strictEqual(await updater.latestVersion(), '0.2.0-rc.1', '兼容入口应返回候选中的最高版本');

    // latest 更高 → 选 latest（不能因为 next 存在就无脑选 next）
    stub({ 'latest': '0.3.0', 'next': '0.2.0-rc.1' });
    best = await updater.bestRelease();
    assert.strictEqual(best.tag, 'latest', '版本更高的是 latest 时应选 latest');

    // 相等 → 保留先出现的那个（候选顺序 latest 在前），且版本仍是它
    stub({ 'latest': '0.2.0-rc.1', 'next': '0.2.0-rc.1' });
    best = await updater.bestRelease();
    assert.strictEqual(best.version, '0.2.0-rc.1');

    // next 查询失败 → 只用 latest，不整体失败
    stub({ 'latest': '0.1.7-rc.2' });
    best = await updater.bestRelease();
    assert.strictEqual(best.tag, 'latest', '一个标签失败不应拖垮整体');
    assert.strictEqual(best.tags.find((t) => t.tag === 'next').version, null, '失败标签应记为 null');

    // 全部失败 → null（调用方按"无法判断"处理，不阻断启动）
    stub({});
    assert.strictEqual(await updater.bestRelease(), null, '全部失败应返回 null');
    assert.strictEqual(await updater.latestVersion(), null);

    // evaluate：本地已是最新 → needed=false，但仍带回比较明细；本地更低 → needed=true 且给出确切版本
    stub({ 'latest': '0.1.7-rc.2', 'next': '0.2.0-rc.1' });
    let ev = await updater.evaluate('0.2.0-rc.1');
    assert.strictEqual(ev.needed, false, '本地等于最高版本时不应升级');
    assert.strictEqual(ev.tags.length, 2, '无需升级也要能说清比过哪些标签');

    ev = await updater.evaluate('0.1.7-rc.2');
    assert.strictEqual(ev.needed, true, '本地低于最高版本时应升级');
    assert.strictEqual(ev.best.version, '0.2.0-rc.1');
    assert.strictEqual(ev.spec, '@deepseek-ai/dsh@0.2.0-rc.1',
      '安装规格必须钉在**确切版本**上（检查与安装之间标签可能被上游移动）');
    assert.strictEqual(ev.command, 'npm i -g @deepseek-ai/dsh@0.2.0-rc.1');

    // 本地比两端都新（手工装过更新版）→ 不降级
    stub({ 'latest': '0.1.7-rc.2', 'next': '0.2.0-rc.1' });
    ev = await updater.evaluate('0.3.0');
    assert.strictEqual(ev.needed, false, '本地更高时绝不能"升级"成更低的版本');

    // 全部查不到 → best=null、needed=false、spec=null
    stub({});
    ev = await updater.evaluate('0.1.7-rc.2');
    assert.strictEqual(ev.best, null);
    assert.strictEqual(ev.needed, false);
    assert.strictEqual(ev.spec, null);
  } finally {
    updater.__setFetchForTest(null);
    delete require.cache[updaterPath];
    delete require.cache[tagPath];
    if (saved === undefined) delete process.env.DSH_DSH_TAG; else process.env.DSH_DSH_TAG = saved;
  }
});

t('dsh-home-guard：同一 home 换了 dsh 版本必须告警并记下来（静默损坏 → 可解释现象）', () => {
  const guard = require('../src/dsh-home-guard');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-'));
  try {
    const logs = [];
    const log = (s) => logs.push(String(s));

    // 首次：只记录，不告警
    const r1 = guard.checkAndRecord({ dshVersion: '0.1.5-rc.3', dataDir: 'D:/UAT', dshHome: home, log });
    assert.strictEqual(r1.checked, true, '应完成检查');
    assert.strictEqual(r1.versionChanged, false, '首次不应告警');
    assert.ok(fs.existsSync(path.join(home, guard.MARKER_NAME)), '应写入标记文件');
    assert.strictEqual(logs.length, 0, '首次不应产生日志');

    // 同版本再来一次：仍不告警
    const r2 = guard.checkAndRecord({ dshVersion: '0.1.5-rc.3', dataDir: 'D:/UAT', dshHome: home, log });
    assert.strictEqual(r2.versionChanged, false, '同版本不应告警');

    // 版本变了：必须告警，且指明两侧目录与处置建议
    const r3 = guard.checkAndRecord({ dshVersion: '0.1.7-rc.2', dataDir: 'D:/main', dshHome: home, log });
    assert.strictEqual(r3.versionChanged, true, '版本变化必须告警');
    assert.strictEqual(r3.previous, '0.1.5-rc.3', '应带出上一版本');
    const text = logs.join('\n');
    assert.ok(/版本守卫/.test(text), '日志应带守卫前缀：' + text);
    assert.ok(/0\.1\.5-rc\.3 → 0\.1\.7-rc\.2/.test(text), '应写出前后版本：' + text);
    assert.ok(text.includes('D:/UAT') && text.includes('D:/main'), '应指明两侧是哪个目录在用：' + text);
    assert.ok(/DSH_DSH_TAG|DSH_HOME/.test(text), '应给出可执行的处置建议：' + text);

    // 没检测到 dsh（空版本）→ 跳过，且不写标记
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard2-'));
    const r4 = guard.checkAndRecord({ dshVersion: '', dataDir: 'D:/x', dshHome: home2, log });
    assert.strictEqual(r4.checked, false, '无版本信息时应跳过');
    assert.ok(!fs.existsSync(path.join(home2, guard.MARKER_NAME)), '跳过时不应写标记');
    fs.rmSync(home2, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('接线回归：安装/升级路径不得再写死 @latest（否则版本分叉会再次改坏共享的 dsh home）', () => {
  const root = path.join(__dirname, '..', 'src');
  for (const f of ['launcher.js', 'updater.js', 'main.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    // 允许注释里出现（说明历史），但**代码行**不得再硬编码该包规格
    const codeLines = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const bad = codeLines.filter((l) => l.includes("'@deepseek-ai/dsh@latest'") || l.includes('"@deepseek-ai/dsh@latest"'));
    assert.strictEqual(bad.length, 0, f + ' 仍有硬编码 latest 的代码行：' + JSON.stringify(bad));
  }
  const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(/dshTag\.dshUpgradeCommand\(\)/.test(mainSrc), '升级提示应使用 dshTag.dshUpgradeCommand()');
  assert.ok(/dshHomeGuard\.checkAndRecord\(/.test(mainSrc), '启动流程应调用版本守卫');
  // v1.9.2：启动检查必须走"多标签取高者"的 evaluate，而不是单标签的 checkForUpdate
  assert.ok(/updater\.evaluate\(/.test(mainSrc), '启动更新检查应调用 updater.evaluate()（多标签择优）');
  assert.ok(/已是候选通道中的最高版本/.test(mainSrc), '“无需升级”也必须留日志（否则无法分辨是否检查过）');
  assert.ok(/已比较 ' \+ detail/.test(mainSrc), '日志必须列出**每个候选标签各自**的查询结果');
  assert.ok(/upgradeDsh\('启动自动', r\.spec\)/.test(mainSrc),
    '自动升级必须把判定出的**确切版本规格**传给 upgradeDsh（避免检查与安装之间标签被移动）');
  const updSrc = fs.readFileSync(path.join(root, 'updater.js'), 'utf8');
  assert.ok(/bestRelease/.test(updSrc) && /CANDIDATE|dshCandidateTags/.test(updSrc),
    'updater 必须实现多候选择优');
  assert.ok(/const spec = String\(o\.spec \|\| ''\)\.trim\(\) \|\| dshInstallSpec\(\)/.test(updSrc),
    'performUpgrade 必须优先使用调用方判定的确切版本规格');
});

// 等所有异步用例结束后再出汇总，并把真实失败数写进退出码（旧版恒为 "0 failed" 且恒 exit 0）
(async () => {
  await Promise.all(pending);
  console.log('');
  console.log('===== ' + passed + ' passed, ' + failed + ' failed =====');
  if (failed > 0) process.exit(1);
})();