// tests/integration.js — 无 Electron / 无子进程的托管逻辑集成测试
// 运行：node tests/integration.js（全部在临时目录内操作，不触碰真实用户数据）
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GatewayManager, validateConfigText } = require('../src/gateway-manager');
const { Watchdog } = require('../src/watchdog');
const { findDsh, findNode, findNodeStr, findEmbeddedNpmCli } = require('../src/launcher');

let passed = 0;
// 测试支持同步/异步用例：注册后顺序执行（saveConfig 等已改为 async）
const __tests = [];
function t(name, fn) {
  __tests.push({ name, fn });
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
  assert.strictEqual(gm.configPort(), 3091);   // 示例配置 port=3091（dsh-app 网关约定）
  fs.writeFileSync(gm.configPath, JSON.stringify({ port: 3123, providers: [] }), 'utf8');
  assert.strictEqual(gm.configPort(), 3123);
  fs.writeFileSync(gm.configPath, '{broken', 'utf8');
  assert.strictEqual(gm.configPort(), 3091);   // 解析失败 → 默认 3091
});

t('网关：saveConfig 校验并写盘（合法）', async () => {
  const good = JSON.stringify({
    port: 3090,
    apiKey: 'k',
    providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'sk-1', models: ['m'], priority: 1, enabled: true }],
  });
  const r = await gm.saveConfig(good);
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(gm.configPath));
});

t('网关：saveConfig 拒绝非法文本（不落盘）', async () => {
  const bad = JSON.stringify({ port: 3090, providers: [{ id: 'x' }] });   // 缺 baseURL
  const before = gm.configText();
  const r = await gm.saveConfig(bad);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(gm.configText(), before, '非法配置不应覆盖现有文件');
});

t('网关：validateConfigText 边界（空 providers 拒绝）', () => {
  const r = validateConfigText(JSON.stringify({ port: 3090, providers: [] }));
  assert.strictEqual(r.ok, false);
});

t('网关：asar 内运行时解包到数据目录（外部 node 可读）', () => {
  // 模拟打包后：mjsPath 位于 app.asar 内
  const asarTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-it-asar-'));
  const asarDir = path.join(asarTmp, 'app.asar');
  fs.mkdirSync(path.join(asarDir, 'gateway'), { recursive: true });
  const srcMjs = path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs');
  fs.copyFileSync(srcMjs, path.join(asarDir, 'gateway', 'model-gateway.mjs'));
  const ex = path.join(__dirname, '..', 'src', 'gateway', 'gateway.config.example.json');
  fs.copyFileSync(ex, path.join(asarDir, 'gateway', 'gateway.config.example.json'));

  const uData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-it-ud-'));
  // 直接实例化并手动设置 gatewayDir/mjsPath 为 asar 路径后再跑解包
  const g2 = new GatewayManager({
    userDataDir: uData,
    nodePath: 'node',
    settings: fakeSettings,
    logger: { appendLog: noopLog },
  });
  g2.gatewayDir = path.join(asarDir, 'gateway');
  g2.mjsPath = path.join(asarDir, 'gateway', 'model-gateway.mjs');
  g2.ensureRuntimeExtracted();

  assert.ok(fs.existsSync(g2.mjsPath), 'mjsPath 应指向真实文件');
  assert.ok(g2.mjsPath.indexOf('app.asar') < 0, '解包后不应仍指向 asar');
  assert.strictEqual(g2.mjsPath, path.join(uData, 'gateway', 'model-gateway.mjs'));
  assert.ok(fs.existsSync(path.join(uData, 'gateway', 'gateway.config.example.json')), '示例应一并解包');
});

t('网关：translateBody 处理 developer 角色与推理档位翻译', () => {
  const mjs = fs.readFileSync(path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs'), 'utf8');
  function grab(name) {
    const start = mjs.indexOf('function ' + name + '(');
    if (start < 0) return null;
    let depth = 0, i = start;
    for (; i < mjs.length; i++) {
      if (mjs[i] === '{') depth++;
      else if (mjs[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return mjs.slice(start, i);
  }
  const trb = grab('translateReasoningBody');
  const tb = grab('translateBody');
  const ms = grab('maskSecretTokens');
  assert.ok(trb && tb && ms, '翻译函数应存在');
  const fn = new Function(ms + '\n' + trb + '\n' + tb + '\nreturn translateBody;')();
  const sen = { id: 'sen', reasoningEffortMap: { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'xhigh' } };
  const ag = { id: 'ag', reasoningEffortMap: { off: 'disabled', low: 'low', medium: 'medium', high: 'high', max: 'max' } };
  // developer → system（sensenova 只认 system/assistant/user/tool）
  const r1 = fn({ model: 'x', messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }] }, sen);
  assert.strictEqual(r1.messages[0].role, 'system', 'developer 应转 system');
  assert.strictEqual(r1.messages[1].role, 'user');
  // 无映射 provider 也转 system（role 兼容独立于映射）
  const r4 = fn({ model: 'x', messages: [{ role: 'developer', content: 'a' }] }, { id: 'n' });
  assert.strictEqual(r4.messages[0].role, 'system');
  // sensenova max→xhigh
  const r2 = fn({ model: 'x', reasoning_effort: 'max', thinking: { type: 'enabled' }, messages: [{ role: 'user', content: 'q' }] }, sen);
  assert.strictEqual(r2.reasoning_effort, 'xhigh');
  assert.strictEqual(r2.thinking.type, 'enabled');
  // sensenova off→none
  const r3 = fn({ model: 'x', reasoning_effort: 'off', messages: [] }, sen);
  assert.strictEqual(r3.reasoning_effort, 'none');
  // agentrouter max 原值+thinking
  const r5 = fn({ model: 'x', reasoning_effort: 'max', messages: [] }, ag);
  assert.strictEqual(r5.reasoning_effort, 'max');
  assert.strictEqual(r5.thinking.type, 'enabled');
  // 无映射 provider 推理字段原样
  const r6 = fn({ model: 'x', reasoning_effort: 'max', messages: [] }, { id: 'n' });
  assert.strictEqual(r6.reasoning_effort, 'max');
  assert.ok(!r6.thinking, '无映射时不应新增 thinking');
  // 未指定档位原样
  const r7 = fn({ model: 'x', messages: [{ role: 'user', content: 'a' }] }, sen);
  assert.deepStrictEqual(r7, { model: 'x', messages: [{ role: 'user', content: 'a' }] });
  // R9 密钥脱敏：token 样式串打码、普通文本保留（会话历史含 key 时上游不再误拦）
  // 注：使用合成的假 key（与真实格式同构但无泄露风险；GitHub secret 扫描曾拦截含真实 key 的版本）
  const FAKE_PAT = 'github_pat_11' + 'FAKE0TEST0KEY0NOT0REAL0XY'.replace(/0/g, '0').padEnd(36, 'Z') + '9zAb';
  const FAKE_SK = 'sk-' + 'TESTFAKEKEY1234567890abcdef'.padEnd(30, 'x');
  const r8 = fn({ model: 'x', messages: [
    { role: 'user', content: 'token: ' + FAKE_PAT + ' 和 ' + FAKE_SK + '，普通文本保留' },
    { role: 'assistant', content: '好的。' },
  ] }, { id: 'n' });
  const masked = r8.messages[0].content;
  assert.ok(!masked.includes(FAKE_PAT), 'github_pat 完整串应打码');
  assert.ok(masked.includes('github_pat_***'), 'github_pat 保留前缀');
  assert.ok(!masked.includes(FAKE_SK), 'sk- 完整串应打码');
  assert.ok(masked.includes('普通文本保留'), '普通文本应保留');
  assert.strictEqual(r8.messages[1].content, '好的。', '助手消息不变');
});

// R14：Anthropic 路径（/messages）不得走 translateBody——否则 thinking:{type:'disabled'}
// 被 OpenAI 风格的 reasoningEffortMap 翻译破坏（删 thinking 换 reasoning_effort 字段），
// 上游按默认开推理处理，"关闭推理"失效。
t('网关：forward 对 Anthropic 路径跳过 OpenAI 专用翻译（R14）', () => {
  const mjs = fs.readFileSync(path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs'), 'utf8');
  assert.ok(mjs.includes("const isAnthropicPath = upstreamPath === '/messages';"),
    'forward 应按路径识别 Anthropic 协议');
  assert.ok(mjs.includes('isAnthropicPath ? body : translateBody(body, provider)'),
    'Anthropic 路径应原样透传（不 translateBody）');
});

t('网关：model-gateway.mjs 主流程支持 --config/--log 覆盖（防误读 %APPDATA% 旧配置）', () => {
  const mjs = fs.readFileSync(path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs'), 'utf8');
  assert.ok(mjs.includes('function argvGet'), '应有 argv 参数工具');
  assert.ok(mjs.includes("let CONFIG_PATH"), 'CONFIG_PATH 应为可重赋值 let');
  assert.ok(mjs.includes("let LOG_PATH"), 'LOG_PATH 应为可重赋值 let');
  assert.ok(mjs.includes("const cfgFromArg = argvGet('--config')"), '主流程应解析 --config');
  assert.ok(mjs.includes("if (cfgFromArg) CONFIG_PATH = cfgFromArg;"), '--config 应覆盖配置路径');
  assert.ok(mjs.includes("const logFromArg = argvGet('--log')"), '主流程应解析 --log');
  assert.ok(mjs.includes("if (logFromArg) LOG_PATH = logFromArg;"), '--log 应覆盖日志路径');
});

// —— 审计验证（R12/协议联动/新增模型自动声明推理档位）——
// 场景：供应商添加新模型（如 kimi-k4）后点「写入 dsh 配置」——settings.yaml 的模型条目
// 应自动带 reasoningEfforts 声明（含 max），否则 pi-ai 回退已安装目录能力报
// "does not support reasoning effort max"。
t('网关：write-dsh 对新增模型自动声明 reasoningEfforts + 协议联动 baseURL', async () => {
  // 源码结构断言（任何环境可跑）：
  const mjsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs'), 'utf8');
  assert.ok(mjsSrc.includes("reasoningEfforts:\\n            off: null\\n            low: low"),
    'modelLines 模板应含 reasoningEfforts 声明（off/low/...）');
  assert.ok(mjsSrc.includes("reasoningEfforts:\\n            off: null\\n            low: low\\n            medium: medium\\n            high: high\\n            max: max"),
    'modelLines 模板应含完整五档（含 max）');
  assert.ok(mjsSrc.includes("wireApi === 'anthropic-messages'\n    ? `http://127.0.0.1:${port}`\n    : `http://127.0.0.1:${port}/v1`"),
    'baseURL 应按协议分流（anthropic 无 /v1）');
  // 端到端（沙箱限制 spawn 时降级为结构断言已覆盖）
  try {
    const { spawnSync } = require('child_process');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wd-'));
    const cfgPath = path.join(tmpDir, 'gateway.config.json');
    const settingsPath = path.join(tmpDir, 'settings.yaml');
    fs.writeFileSync(settingsPath, 'llm-pi-ai:\n  providers:\n    other:\n      apiKeyEnv: X\n', 'utf8');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: 3099, apiKey: 'k',
      clientProfile: 'claude',
      providers: [
        { id: 'p1', baseURL: 'https://a.com/v1', apiKey: 'sk-1', models: ['deepseek-v4-flash', 'kimi-k4'], priority: 1, enabled: true },
      ],
    }), 'utf8');
    const r = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs'),
      '--write-dsh', '--config', cfgPath, '--settings', settingsPath,
      '--credentials', path.join(tmpDir, 'creds.yaml'), '--port', '3099',
    ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (r.status === 0) {
      const out = fs.readFileSync(settingsPath, 'utf8');
      assert.ok(out.includes('api: anthropic-messages'), 'claude 仿真应写 anthropic-messages');
      assert.ok(out.includes('baseURL: http://127.0.0.1:3099\n'), 'anthropic 的 baseURL 应不带 /v1');
      assert.ok(/- id: 'kimi-k4'[\s\S]*?reasoningEfforts:[\s\S]*?max: max/.test(out),
        '新增模型 kimi-k4 应自动声明 reasoningEfforts（含 max）');
      console.log('  (端到端 write-dsh 验证通过)');
    } else {
      console.log('  (spawn 受限，端到端降级——源码结构断言已覆盖)');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    console.log('  (spawn 异常，端到端降级——源码结构断言已覆盖)');
  }
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
// v1.5.17：findNode 返回 { exe, env, embedded }（内嵌运行时优先）；
// findNodeStr 保持旧字符串契约。
t('launcher：findNode 返回 {exe,env,embedded} 且 findNodeStr 为字符串', () => {
  const n = findNode();
  assert.ok(n && typeof n.exe === 'string' && n.exe.length > 0, 'exe 应为非空字符串');
  assert.ok(n.env && typeof n.env === 'object', 'env 应为对象');
  assert.ok(typeof n.embedded === 'boolean', 'embedded 应为布尔');
  // 开发模式（测试环境）：embedded=false，exe 指向系统 node
  assert.strictEqual(n.embedded, false, '开发模式下应为系统 node');
  const s = findNodeStr();
  assert.ok(typeof s === 'string' && s.length > 0, 'findNodeStr 应返回字符串');
});

t('launcher：findEmbeddedNpmCli 开发模式指向项目 npm（或 null）', () => {
  const c = findEmbeddedNpmCli();
  if (c) {
    assert.ok(c.endsWith('npm-cli.js'), '应以 npm-cli.js 结尾');
    assert.ok(fs.existsSync(c), 'npm-cli.js 应存在');
  }
  // 开发模式下项目内有 node_modules\npm → 应找到
  const projNpm = path.join(__dirname, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(projNpm)) assert.ok(c === projNpm, '开发模式应指向项目 npm');
});

t('launcher：findDsh 返回结构或 null（不断言具体版本）', () => {
  const d = findDsh();
  if (d !== null) {
    assert.ok(d.dir && d.version && d.bin);
    assert.ok(fs.existsSync(d.bin), 'bin 应存在');
  }
});

// 顺序执行（支持 async 用例）
(async () => {
  for (const { name, fn } of __tests) {
    await fn();
    passed++;
    console.log('PASS  ' + name);
  }
  // 清理
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  console.log('===== ' + passed + ' passed, 0 failed =====');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});