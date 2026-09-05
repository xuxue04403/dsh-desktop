// tests/integration.js — 无 Electron / 无子进程的托管逻辑集成测试
// 运行：node tests/integration.js（全部在临时目录内操作，不触碰真实用户数据）
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GatewayManager, validateConfigText } = require('../src/gateway-manager');
const { Watchdog } = require('../src/watchdog');
const { findDsh, findNode } = require('../src/launcher');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-app-it-'));
const noopLog = () => {};
const fakeSettings = {
  data: {},
  save() {},
  get safePatchPath() { return path.join(tmp, 'safe.yml'); },
};

// —— 模型网关：配置读写与端口提取 ——
const gm = new GatewayManager({
  userDataDir: tmp,
  nodePath: 'node',
  settings: fakeSettings,
  logger: { appendLog: noopLog },
});
gm.init();

t('网关：首次使用从示例生成配置', () => {
  assert.ok(fs.existsSync(gm.configPath), '应生成 gateway.config.json');
});

t('网关：configPort 读取配置内端口', () => {
  assert.strictEqual(gm.configPort(), 3090);   // 示例配置 port=3090
  fs.writeFileSync(gm.configPath, JSON.stringify({ port: 3123, providers: [] }), 'utf8');
  assert.strictEqual(gm.configPort(), 3123);
  fs.writeFileSync(gm.configPath, '{broken', 'utf8');
  assert.strictEqual(gm.configPort(), 3090);   // 解析失败 → 默认
});

t('网关：saveConfig 校验并写盘（合法）', () => {
  const good = JSON.stringify({
    port: 3090,
    apiKey: 'k',
    providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'sk-1', models: ['m'], priority: 1, enabled: true }],
  });
  const r = gm.saveConfig(good);
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(gm.configPath));
});

t('网关：saveConfig 拒绝非法文本（不落盘）', () => {
  const bad = JSON.stringify({ port: 3090, providers: [{ id: 'x' }] });   // 缺 baseURL
  const before = gm.configText();
  const r = gm.saveConfig(bad);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(gm.configText(), before, '非法配置不应覆盖现有文件');
});

t('网关：validateConfigText 边界（空 providers 拒绝）', () => {
  const r = validateConfigText(JSON.stringify({ port: 3090, providers: [] }));
  assert.strictEqual(r.ok, false);
});

// —— 安全模式：profile 备份 / 最小配置 / 还原 ——
const wd = new Watchdog({
  settings: fakeSettings,
  launcher: { nodePath: 'node', found: null },
  state: { update() {} },
  logger: { appendLog: noopLog },
  workDir: tmp,
});
const profileDir = path.join(tmp, 'profiles', 'web');
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), '{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dshmarket"]}', 'utf8');
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: dshmarket\n  config: {}\n', 'utf8');
wd.profileDir = profileDir;

t('安全模式：Level2 备份 → 最小配置 → 还原（数据无损）', () => {
  const origPkg = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8');
  const origPatch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');

  assert.strictEqual(wd.backupProfile(), true, '备份应成功');
  assert.strictEqual(wd.writeMinimalProfile(), true, '写最小配置应成功');
  assert.ok(fs.existsSync(path.join(profileDir, 'package.json.dshsafe.bak')), '应有备份文件');

  // 最小配置：仅官方 bundles、空 patch
  const minPkg = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8');
  assert.ok(minPkg.includes('@deepseek-ai/dsh-base') && minPkg.includes('@deepseek-ai/dsh-web-app'));
  assert.ok(!minPkg.includes('dshmarket'), '第三方插件应从最小配置消失');

  wd.restoreProfile();
  assert.strictEqual(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), origPkg, 'package.json 应还原');
  assert.strictEqual(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), origPatch, 'cordis.patch.yml 应还原');
  assert.ok(!fs.existsSync(path.join(profileDir, 'package.json.dshsafe.bak')), '备份文件应已清理');
});

t('安全模式：无插件特征日志 → parseFailedPlugins 为空（不误伤）', () => {
  const { parseFailedPlugins } = require('../src/watchdog');
  assert.deepStrictEqual(parseFailedPlugins('dsh: Error: listen EADDRINUSE 3080\n at Server...'), []);
});

// —— 运行时发现（本机探测，只做类型断言）——
t('launcher：findNode 返回 node 路径字符串', () => {
  const n = findNode();
  assert.ok(typeof n === 'string' && n.length > 0);
});

t('launcher：findDsh 返回结构或 null（不断言具体版本）', () => {
  const d = findDsh();
  if (d !== null) {
    assert.ok(d.dir && d.version && d.bin);
    assert.ok(fs.existsSync(d.bin), 'bin 应存在');
  }
});

// 清理
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log('===== ' + passed + ' passed, 0 failed =====');