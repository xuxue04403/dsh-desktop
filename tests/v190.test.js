// tests/v190.test.js — v1.9.0 新增能力的回归测试
// 运行：node tests/v190.test.js
//
// 覆盖四项新增能力（全部不依赖 Electron，可在受限环境运行）：
//   1) crash-report  致命错误现场落盘（脱敏 / 保留份数 / 撞名不覆盖）
//   2) quit-guard    退出前任务确认的旁路信号判定
//   3) web-auth      启动令牌换 cookie 的目标 URL 计算
//   4) plugin-snapshot.verify  迁移快照可迁移性校验
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const crashReport = require('../src/crash-report');
const quitGuard = require('../src/quit-guard');
const webAuth = require('../src/web-auth');
const pluginSnapshot = require('../src/plugin-snapshot');

let passed = 0;
// 支持同步与异步两种用例：异步失败必须能被捕获到（否则断言失败会被静默吞掉、
// 而用例照样计入 passed —— 这正是"空转绿灯"的成因）。
const pending = [];
function t(name, fn) {
  let r;
  try {
    r = fn();
  } catch (err) {
    console.log('FAIL  ' + name);
    throw err;
  }
  if (r && typeof r.then === 'function') {
    pending.push(r.then(
      () => { passed++; console.log('PASS  ' + name); },
      (err) => { console.log('FAIL  ' + name); throw err; },
    ));
    return;
  }
  passed++;
  console.log('PASS  ' + name);
}

function mkTemp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v190-' + tag + '-'));
  return dir;
}
function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
}

// ============ 1. crash-report ============

// 必须最先跑：此刻模块尚未 init，正是"未初始化"的真实状态
// （不用 delete require.cache 之类的花招——那会把已初始化的单例也一起丢掉）
t('crash-report：未初始化时安全降级（返回 null、不抛）', () => {
  assert.strictEqual(crashReport.record('main', new Error('x'), {}), null, '未 init 的 record 必须返回 null');
  assert.deepStrictEqual(crashReport.list(), [], '未 init 的 list 必须为空');
  assert.strictEqual(crashReport.prune(), 0, '未 init 的 prune 必须是 0');
  assert.strictEqual(crashReport.ready(), false, '未 init 时 ready 为 false');
});

t('crash-report：脱敏覆盖 5 类凭据形态，且不误伤正常文本', () => {
  // 刻意使用一眼可辨的假值：绝不能在测试里放真实凭据——email-scrub 闸门会（正确地）拦下
  const fakeKey = 'sk_FAKEKEYFORTESTSONLY0123456789abcdefghijklmnopqrstuvwxyz';
  const dirty = 'key=' + fakeKey + ' '
    + 'Bearer abcdefghijklmnop DSH_GATEWAY_API_KEY=deadbeefcafe1234 '
    + 'apiKey: "verylongsecretvalue123" hex=0123456789abcdef0123456789abcdef01234567 normal-text-here';
  const out = crashReport.redact(dirty);
  assert.ok(!out.includes(fakeKey), 'sk_ 密钥必须被脱敏');
  assert.ok(!/abcdefghijklmnop/.test(out), 'Bearer 令牌必须被脱敏');
  assert.ok(!/deadbeefcafe1234/.test(out), 'DSH_*_KEY 值必须被脱敏');
  assert.ok(!/verylongsecretvalue123/.test(out), 'apiKey 赋值必须被脱敏');
  assert.ok(!/0123456789abcdef0123456789abcdef/.test(out), '长 hex 必须被脱敏');
  assert.ok(out.includes('normal-text-here'), '正常文本不得被改动');
});

t('crash-report：写入报告含头部/阶段/错误栈，文件名可排序', () => {
  const dir = mkTemp('cr');
  try {
    crashReport.init(dir);
    const err = new Error('boom-marker');
    const file = crashReport.record('web', err, { phase: '测试阶段', version: '1.9.0', uptimeMs: 1500 });
    assert.ok(file && fs.existsSync(file), '报告必须落盘');
    const base = path.basename(file);
    assert.ok(/^crash-\d{8}-\d{6}-\d{3}-web\.log$/.test(base), '文件名应为 crash-<时间>-<来源>.log，实得 ' + base);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('DSH-App 崩溃报告'), '必须含头部');
    assert.ok(text.includes('测试阶段'), '必须含阶段');
    assert.ok(text.includes('boom-marker'), '必须含错误信息');
    assert.ok(text.includes('1.9.0'), '必须含应用版本');
  } finally { rm(dir); }
});

t('crash-report：保留最近 10 份（prune）', () => {
  const dir = mkTemp('prune');
  try {
    crashReport.init(dir);
    for (let i = 0; i < 14; i++) crashReport.record('main', new Error('e' + i), { phase: 'p' + i });
    const files = crashReport.list();
    assert.strictEqual(files.length, crashReport.MAX_KEEP,
      '应只保留 ' + crashReport.MAX_KEEP + ' 份，实得 ' + files.length);
  } finally { rm(dir); }
});

t('crash-report：同毫秒多次记录不互相覆盖（撞名加序号）', () => {
  const dir = mkTemp('collide');
  try {
    crashReport.init(dir);
    // 连写 5 份：毫秒级时间戳极可能重复，旧实现会互相覆盖
    const paths = [];
    for (let i = 0; i < 5; i++) paths.push(crashReport.record('renderer', new Error('c' + i), {}));
    const uniq = new Set(paths);
    assert.strictEqual(uniq.size, 5, '5 次记录必须得到 5 个不同文件，实得 ' + uniq.size);
    paths.forEach((p) => assert.ok(fs.existsSync(p), '文件必须存在：' + p));
  } finally { rm(dir); }
});

t('crash-report：init 后 ready 为 true，且能写出首份报告', () => {
  const dir = mkTemp('ready');
  try {
    crashReport.init(dir);
    assert.strictEqual(crashReport.ready(), true, 'init 后 ready 应为 true');
    const f = crashReport.record('main', new Error('after-init'), {});
    assert.ok(f && fs.existsSync(f), 'init 后必须能落盘');
  } finally { rm(dir); }
});

// ============ 2. quit-guard ============

function mkHomeWithSession(dir, mtimeMs) {
  const s = path.join(dir, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(s, { recursive: true });
  const f = path.join(s, 'a.json');
  fs.writeFileSync(f, '{}');
  if (mtimeMs !== undefined) fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  return f;
}

t('quit-guard：窗口期内的会话写入 → busy，且信号为 session', () => {
  const dir = mkTemp('qg1');
  try {
    const now = Date.now();
    mkHomeWithSession(dir, now - 1000);
    const r = quitGuard.assess({ dshHome: dir, now });
    assert.strictEqual(r.busy, true);
    assert.deepStrictEqual(r.signals.map((s) => s.kind), ['session']);
  } finally { rm(dir); }
});

t('quit-guard：陈旧会话 + 无网关活动 → 不 busy', () => {
  const dir = mkTemp('qg2');
  try {
    const now = Date.now();
    mkHomeWithSession(dir, now - 10 * 60 * 1000);
    const r = quitGuard.assess({ dshHome: dir, now });
    assert.strictEqual(r.busy, false);
    assert.deepStrictEqual(r.signals, []);
  } finally { rm(dir); }
});

t('quit-guard：网关流量可单独触发 busy（覆盖"模型正在思考、会话未落盘"）', () => {
  const dir = mkTemp('qg3');
  try {
    const now = Date.now();
    mkHomeWithSession(dir, now - 10 * 60 * 1000);   // 会话陈旧
    const r = quitGuard.assess({ dshHome: dir, now, gatewayLastActivityAt: now - 2000 });
    assert.strictEqual(r.busy, true);
    assert.deepStrictEqual(r.signals.map((s) => s.kind), ['gateway']);
  } finally { rm(dir); }
});

t('quit-guard：窗口边界为闭区间（=窗口算活动，超出不算）', () => {
  const dir = mkTemp('qg4');
  try {
    const now = Date.now();
    const W = quitGuard.DEFAULT_WINDOW_MS;
    mkHomeWithSession(dir, now - W);
    assert.strictEqual(quitGuard.assess({ dshHome: dir, now }).busy, true, '恰好在窗口上应算活动');
    fs.utimesSync(path.join(dir, 'storages', 'session_projcache', 'sessions', 'a.json'),
      new Date(now - W - 1), new Date(now - W - 1));
    assert.strictEqual(quitGuard.assess({ dshHome: dir, now }).busy, false, '超出窗口 1ms 应算空闲');
  } finally { rm(dir); }
});

t('quit-guard：DSH_HOME 不存在时安全降级（不 busy、不抛）', () => {
  const dir = mkTemp('qg5');
  try {
    const r = quitGuard.assess({ dshHome: path.join(dir, 'missing'), now: Date.now() });
    assert.strictEqual(r.busy, false);
    assert.deepStrictEqual(r.signals, []);
  } finally { rm(dir); }
});

t('quit-guard：resolveDshHome 尊重显式值与 DSH_HOME 环境变量', () => {
  const saved = process.env.DSH_HOME;
  try {
    assert.strictEqual(quitGuard.resolveDshHome('X:\\explicit'), 'X:\\explicit');
    process.env.DSH_HOME = 'X:\\from-env';
    assert.strictEqual(quitGuard.resolveDshHome(), 'X:\\from-env');
    delete process.env.DSH_HOME;
    assert.ok(quitGuard.resolveDshHome().endsWith('.dsh'), '缺省应回退 ~/.dsh');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
  }
});

// ============ 3. web-auth ============

t('web-auth.targetUrl：primed 时去掉令牌，未 primed 时原样返回', () => {
  const url = 'http://127.0.0.1:3080/?token=secret';
  assert.strictEqual(webAuth.targetUrl(true, url), 'http://127.0.0.1:3080/');
  assert.strictEqual(webAuth.targetUrl(false, url), url);
});

t('web-auth.targetUrl：非法 URL 一律回退原值（绝不构造猜出来的地址）', () => {
  assert.strictEqual(webAuth.targetUrl(true, 'not-a-url'), 'not-a-url');
  assert.strictEqual(webAuth.targetUrl(false, 'not-a-url'), 'not-a-url');
});

t('web-auth.parseSetCookie：解析真实 dsh Set-Cookie（含 SameSite 取值域转换）', () => {
  const real = 'dsh-auth-ABC=v1.payload.sig; Max-Age=2592000; Path=/; '
    + 'Expires=Sun, 25 Oct 2026 11:12:06 GMT; HttpOnly; SameSite=Strict';
  const c = webAuth.parseSetCookie(real);
  assert.strictEqual(c.name, 'dsh-auth-ABC');
  assert.strictEqual(c.value, 'v1.payload.sig');
  assert.strictEqual(c.path, '/');
  assert.strictEqual(c.httpOnly, true);
  assert.strictEqual(c.secure, undefined, '响应无 Secure 属性 → 不得臆造');
  assert.strictEqual(c.sameSite, 'strict');
  assert.strictEqual(c.domain, undefined, 'host-only cookie 不得带 domain');
  const days = Math.round((c.expirationDate - Math.floor(Date.now() / 1000)) / 86400);
  assert.strictEqual(days, 30, 'Max-Age=2592000 应为 30 天，实得 ' + days);

  // Electron 只认 no_restriction / lax / strict / unspecified，不认 Set-Cookie 的 None
  assert.strictEqual(webAuth.parseSetCookie('a=b; SameSite=None').sameSite, 'no_restriction');
  assert.strictEqual(webAuth.parseSetCookie('a=b; SameSite=Lax').sameSite, 'lax');
  assert.strictEqual(webAuth.parseSetCookie('a=b; SameSite=Weird').sameSite, 'unspecified');
  // 边界
  assert.strictEqual(webAuth.parseSetCookie('k=v').name, 'k');
  assert.strictEqual(webAuth.parseSetCookie(''), null);
  assert.strictEqual(webAuth.parseSetCookie('novalue'), null);
});

t('web-auth.primeSessionCookie：无令牌 / 无 session 时返回 ok:false 而不抛', async () => {
  const a = await webAuth.primeSessionCookie({ fetch: () => {} }, 'http://127.0.0.1:3080/', () => {});
  assert.strictEqual(a.ok, false);
  assert.ok(/不含令牌/.test(a.detail), '应说明无需换发，实得：' + a.detail);
  const b = await webAuth.primeSessionCookie(null, 'http://127.0.0.1:3080/?token=t', () => {});
  assert.strictEqual(b.ok, false);
  const c = await webAuth.primeSessionCookie({}, 'http://127.0.0.1:3080/?token=t', () => {});
  assert.strictEqual(c.ok, false);
  assert.ok(/不支持 cookie 操作/.test(c.detail), '应说明 session 能力缺失，实得：' + c.detail);
});

// 真实 HTTP 端到端：本地起 303 服务器 + mock cookie jar，验证换发与写入的完整链路。
// 这条用例同时守住"必须用全局 fetch"这个修复点——session.fetch 对 redirect:'manual'
// 会以 "Redirect was cancelled" 拒绝，而这里走的正是全局 fetch。
t('web-auth.primeSessionCookie：303 + Set-Cookie → 写入 jar 且参数正确（真实 HTTP）', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url.includes('token=')) {
      res.writeHead(303, {
        location: '/',
        'set-cookie': 'dsh-auth-TEST=v1.payload.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict',
      });
      res.end();
      return;
    }
    res.writeHead(401);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const store = new Map();
  const session = {
    cookies: {
      set: async (spec) => { store.set(spec.name, spec); },
      get: async () => [...store.values()].map((s) => ({ name: s.name, value: s.value })),
    },
  };
  try {
    const r = await webAuth.primeSessionCookie(session, `http://127.0.0.1:${port}/?token=abc`, () => {});
    assert.strictEqual(r.ok, true, '换发应成功：' + r.detail);
    const spec = store.get('dsh-auth-TEST');
    assert.ok(spec, 'cookie 必须写进 jar');
    assert.strictEqual(spec.value, 'v1.payload.sig');
    assert.strictEqual(spec.path, '/');
    assert.strictEqual(spec.httpOnly, true);
    assert.strictEqual(spec.sameSite, 'strict');
    assert.ok(spec.expirationDate > Math.floor(Date.now() / 1000), '必须带过期时间');
    assert.strictEqual(spec.domain, undefined, '不得硬塞 domain');

    // 非 303（无令牌路径直接 401）→ 必须失败而不是写错 cookie
    const r2 = await webAuth.primeSessionCookie(session, `http://127.0.0.1:${port}/?token=x`, () => {});
    assert.strictEqual(r2.ok, true, '第二次仍应成功（服务器行为未变）');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

t('web-auth.primeSessionCookie：上游返回非 303 → ok:false（不写 cookie）', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('nope'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const store = new Map();
  const session = { cookies: { set: async (s) => store.set(s.name, s), get: async () => [] } };
  try {
    const r = await webAuth.primeSessionCookie(session, `http://127.0.0.1:${port}/?token=abc`, () => {});
    assert.strictEqual(r.ok, false);
    assert.ok(/预期 303/.test(r.detail), '应说明状态码不符，实得：' + r.detail);
    assert.strictEqual(store.size, 0, '失败时不得写入任何 cookie');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ============ 4. plugin-snapshot.verify ============

t('plugin-snapshot.verify：无快照 → snapshotExists=false，不抛', () => {
  const dir = mkTemp('pv1');
  try {
    const v = pluginSnapshot.verify(dir);
    assert.strictEqual(v.snapshotExists, false);
    assert.strictEqual(v.ok, false);
  } finally { rm(dir); }
});

t('plugin-snapshot.verify：缺少数据目录（null/空串）安全降级', () => {
  assert.strictEqual(pluginSnapshot.verify(null).ok, false);
  assert.strictEqual(pluginSnapshot.verify('').ok, false);
  assert.ok(/缺少数据目录/.test(pluginSnapshot.verify(null).message));
});

t('plugin-snapshot.verify：随包插件包体缺失必须被报出', () => {
  const dir = mkTemp('pv2');
  try {
    fs.writeFileSync(pluginSnapshot.snapshotPath(dir), JSON.stringify({
      capturedAt: '2026-09-25T00:00:00.000Z',
      plugins: [{ name: 'p-alpha', spec: '1.0.0' }, { name: 'p-beta', spec: '2.0.0' }],
      bundles: ['p-alpha', 'p-beta'],
      dshConfig: { files: [], dirs: [] },
    }), 'utf8');
    // 只把 p-alpha 的包体放进去
    const d = pluginSnapshot.bundleDirFor(dir, 'p-alpha');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"p-alpha"}', 'utf8');

    const v = pluginSnapshot.verify(dir);
    assert.strictEqual(v.snapshotExists, true);
    assert.strictEqual(v.ok, false, '缺包体时不得判为完整');
    assert.deepStrictEqual(v.missingBundles, ['p-beta']);
    assert.ok(/p-beta/.test(v.message), 'message 必须点名缺失项');
  } finally { rm(dir); }
});

t('plugin-snapshot.verify：配置文件缺失必须被报出，齐全时判为完整', () => {
  const dir = mkTemp('pv3');
  try {
    fs.writeFileSync(pluginSnapshot.snapshotPath(dir), JSON.stringify({
      capturedAt: '2026-09-25T00:00:00.000Z',
      plugins: [], bundles: [],
      dshConfig: { files: ['settings.yaml', '.credentials.yaml'], dirs: [] },
    }), 'utf8');
    const root = pluginSnapshot.dshConfigRoot(dir);
    fs.mkdirSync(root, { recursive: true });

    let v = pluginSnapshot.verify(dir);
    assert.strictEqual(v.ok, false);
    assert.deepStrictEqual(v.missingConfig.sort(), ['.credentials.yaml', 'settings.yaml']);

    // 补齐两个文件（非空）
    fs.writeFileSync(path.join(root, 'settings.yaml'), 'a: 1', 'utf8');
    fs.writeFileSync(path.join(root, '.credentials.yaml'), 'b: 2', 'utf8');
    v = pluginSnapshot.verify(dir);
    assert.strictEqual(v.ok, true, '齐全后应判为完整，实得：' + v.message);
    assert.deepStrictEqual(v.missingConfig, []);

    // 空文件同样算缺失（复制过程中被截断的情形）
    fs.writeFileSync(path.join(root, 'settings.yaml'), '', 'utf8');
    assert.strictEqual(pluginSnapshot.verify(dir).ok, false, '空文件应算缺失');
  } finally { rm(dir); }
});

t('plugin-snapshot.verify：无随包的插件被列为"需联网安装"而非缺陷', () => {
  const dir = mkTemp('pv4');
  try {
    fs.writeFileSync(pluginSnapshot.snapshotPath(dir), JSON.stringify({
      capturedAt: '2026-09-25T00:00:00.000Z',
      plugins: [{ name: 'p-inline', spec: '1.0.0' }, { name: 'p-remote', spec: '3.0.0' }],
      bundles: ['p-inline'],
      dshConfig: { files: [], dirs: [] },
    }), 'utf8');
    const d = pluginSnapshot.bundleDirFor(dir, 'p-inline');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"p-inline"}', 'utf8');

    const v = pluginSnapshot.verify(dir);
    assert.strictEqual(v.ok, true, '缺随包不算缺陷（可联网装），实得：' + v.message);
    assert.deepStrictEqual(v.plugins.registry, ['p-remote']);
  } finally { rm(dir); }
});

// ============ 5. 接线冒烟（防止"写了模块但没接上"） ============

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

t('接线：main.js 的主界面加载统一走 loadWebUI（不再直接 loadURL 带令牌地址）', () => {
  const src = read('main.js');
  const hits = src.match(/\.loadURL\(/g) || [];
  assert.strictEqual(hits.length, 1, '应只剩 loadWebUI 内一处 loadURL，实得 ' + hits.length + ' 处');
  assert.ok(/win\.loadURL\(webAuth\.targetUrl\(webAuthPrimed, launcher\.authUrl\)\)/.test(src),
    'loadURL 必须经 webAuth.targetUrl 计算目标');
  assert.ok(src.includes('loadWebUI(mainWindow);'), '就绪路径必须调用 loadWebUI');
});

t('接线：startService 复位 cookie 引导状态（新令牌需重换）', () => {
  const src = read('main.js');
  assert.ok(/readyHandled = false;\s*\n\s*\/\/ v1\.9\.0[\s\S]{0,200}webAuthTried = false;/.test(src),
    'startService 必须随 readyHandled 一起复位 webAuthTried');
});

t('接线：退出路径调用 quit-guard，且可在设置里关闭', () => {
  const src = read('main.js');
  assert.ok(src.includes('quitGuard.assess('), 'quitAll 必须做活动判定');
  assert.ok(src.includes('confirmQuitWhenBusy === false'), '必须支持用户关闭该确认');
  assert.ok(/let quitConfirming = false;/.test(src), '必须有"确认框已在等"的闸，避免叠加弹框');
  const st = read('settings.js');
  assert.ok(/confirmQuitWhenBusy: true/.test(st), '设置默认值必须存在');
});

t('接线：崩溃报告在 bootstrap 初始化并接入三类现场', () => {
  const src = read('main.js');
  assert.ok(src.includes('crashReport.init(logger.logDirPath())'), '必须在 logger 之后初始化');
  assert.ok(src.includes("crashReport.record('main'"), '主进程未捕获异常/拒绝');
  assert.ok(src.includes("crashReport.record('renderer'"), '渲染进程异常退出');
  assert.ok(src.includes("crashReport.record('web'"), 'dsh 服务意外退出');
  const gw = read('gateway-manager.js');
  assert.ok(gw.includes("crashReport.record('gateway'"), '网关放弃自愈时固化现场');
  assert.ok(gw.includes('this.lastActivityAt = Date.now()'), 'pushLog 必须记账最近活动');
});

t('接线：迁移自检在快照采集后被调用，且结果进入状态快照', () => {
  const src = read('main.js');
  assert.ok(src.includes('selfCheckSnapshot(reason)'), '采集后必须自检');
  assert.ok(src.includes('pluginSnapshot.verify(APP_USERDATA)'), '必须调用 verify');
  const st = read('state.js');
  assert.ok(st.includes('migrationCheck: this.migrationCheck'), '状态快照必须暴露自检结果');
});

// 2026-09-25：dsh 自动升级报 `'npm' 不是内部或外部命令` —— 根因是产物从未内嵌 npm
// （本机没有独立 Node.js，原先的候选源全部落空，而 build-uat 还是**静默跳过**）。
t('接线：三个构建脚本的 npm 候选都含 out/_npm，且缺失时不再静默', () => {
  const scripts = path.join(__dirname, '..', 'scripts');
  for (const f of ['build-uat.mjs', 'build-portable.mjs', 'prepare-extra.mjs']) {
    const src = fs.readFileSync(path.join(scripts, f), 'utf8');
    assert.ok(src.includes("'_npm'"), f + ' 的 npm 候选必须包含 out/_npm（本机唯一可行的内嵌来源）');
    assert.ok(src.includes("'bin', 'npm-cli.js'"), f + ' 必须按 bin/npm-cli.js 的存在性判定（目录存在不代表是 npm）');
  }
  const uat = fs.readFileSync(path.join(scripts, 'build-uat.mjs'), 'utf8');
  assert.ok(uat.includes('未找到内嵌 npm'), 'build-uat.mjs 在缺失内嵌 npm 时必须明确告警（此前静默）');
  assert.ok(fs.existsSync(path.join(scripts, 'fetch-npm.mjs')), 'fetch-npm.mjs 必须存在（获取自包含 npm 的唯一途径）');
});

t('接线：cookie 引导用全局 fetch（session.fetch 对 manual redirect 不可用）', () => {
  const src = read('web-auth.js');
  assert.ok(!/session\.fetch\(/.test(src),
    'web-auth.js 不得使用 session.fetch —— 它对 redirect:manual 报 "Redirect was cancelled"');
  assert.ok(/await fetch\(authUrl, \{ redirect: 'manual' \}\)/.test(src),
    '必须用全局 fetch 拿 303 + Set-Cookie');
  assert.ok(/jar\.set\(/.test(src), '必须显式把 cookie 写入 session jar');
  assert.ok(src.includes('parseSetCookie'), '必须解析 Set-Cookie 属性后写入');
});

t('G1 安全修复：release.ps1 与 publish.mjs 都排除 *.bak 变体（对称）', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.ps1'), 'utf8');
  const pj = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'publish.mjs'), 'utf8');
  // 用 includes 而非正则字面量：这些模式里同时含 / \ ( ) | $，正则写法极易转义出错
  assert.ok(ps.includes("$rel -match '(^|/)[^/]*\\.bak($|-)'"),
    'release.ps1 必须有 *.bak 变体排除规则（G1：此前缺失 → 脱敏前备份可经该链路外泄）');
  assert.ok(pj.includes('\\.bak($|-)'),
    'publish.mjs 的规则必须放宽到覆盖 .bak-scrub / .bak-nobom-* 等变体');
  // 反向验证：旧的窄规则不得再出现（它漏掉带后缀的变体）
  assert.ok(!pj.includes('if (/\\.bak-scrub$/i.test(e.name) || /\\.bak$/i.test(e.name))'),
    'publish.mjs 不应再保留只认 .bak / .bak-scrub 的窄规则');
});

// 2026-09-25：构建清空目录后 PATH 上的 `node` 突然消失 —— 因为「应用根目录\node.exe」
// 是 launcher 在 exe 旁建的硬链接，而它此前**只在安装/升级 dsh 时**才会被创建。
t('接线：启动时幂等确保内嵌 node.exe（构建清空目录后可自愈）', () => {
  const src = read('main.js');
  assert.ok(src.includes('prepareEmbeddedInstallEnv(null, process.env)'),
    'bootstrap 必须在启动时调用 prepareEmbeddedInstallEnv 以确保 node.exe 存在');
  assert.ok(src.includes('内嵌运行时入口就绪'), '必须记录就绪或明确告警');
  // 必须真的在启动路径上（紧跟 launcher.detect()），不是死代码
  assert.ok(/launcher\.detect\(\);\s*\n\s*\/\/ v1\.9\.0：每次启动幂等确保/.test(src),
    '确保 node.exe 的调用必须紧跟 launcher.detect()');
});

// 2026-09-26：一键使用 zip 里混进了应用根目录的 node.exe。它正是上面那条测试说的
// 「启动时由 DSH-App.exe 硬链接再生」的内嵌运行期入口，与 app exe 同为约 237 MB 的
// Electron 二进制——留着等于白背一份（实测 372.5 MB → 269.4 MB，省 103 MB）。
// publish.mjs 的绿色包早已排除它（ZIP_SKIP_FILES），pack-slim 必须对齐。
t('pack-slim：排除启动时再生的 node.exe（否则 zip 白涨约 103 MB）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pack-slim.mjs'), 'utf8');
  assert.ok(/rm\(path\.join\(work, 'node\.exe'\)/.test(src),
    'pack-slim.mjs 必须删除应用根目录的 node.exe');
  assert.ok(src.includes('硬链接再生'),
    '删除处必须写明它是启动时硬链接再生的产物（否则后人会以为是随包文件又加回去）');
});

// 2026-09-25：dsh 0.1.7-rc.2 起目录模型的字段多了一个 inputModalities（多模态输入能力）。
// R28 补丁靠字符串锚点改写该函数——锚点与替换体必须**成对**匹配：只改锚点不改替换体，
// 会把新字段从补丁后的代码里吃掉，表现为「获取模型」列出的模型悄悄丢掉图片能力。
// 这是静默降级（比打不上补丁更糟），所以两种上游写法都要有回归。
t('launcher 补丁：R28 同时适配 0.1.5 与 0.1.7 两种写法，且不吃掉 inputModalities', () => {
  const { Launcher } = require('../src/launcher');
  const HEAD = [
    '\tif (request.provider !== void 0) {',
    '\t\tconst installed = catalogModels(request.provider);',
    '\t\tif (installed.size > 0) return [...installed.values()].map((model) => ({',
    '\t\t\tid: model.id,',
    '\t\t\tname: model.name,',
    '\t\t\tcontextWindow: model.contextWindow,',
  ];
  const TAIL = ['\t\t}));', '\t}', ''];
  const cases = [
    { label: '0.1.5-rc.x', body: HEAD.concat(['\t\t\tmaxTokens: model.maxTokens'], TAIL).join('\n'), expectInputMod: false },
    { label: '0.1.7-rc.x', body: HEAD.concat(['\t\t\tmaxTokens: model.maxTokens,', '\t\t\tinputModalities: [...model.input]'], TAIL).join('\n'), expectInputMod: true },
  ];
  for (const c of cases) {
    const dir = mkTemp('r28');
    try {
      const rel = path.join('node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, c.body, 'utf8');

      const fake = Object.create(Launcher.prototype);   // 不跑构造函数：补丁只用 this.log
      fake.log = () => { /* 静音 */ };
      assert.strictEqual(fake.applyLiveModelDiscoveryPatch({ dir }), true, c.label + ' 应能打上补丁');

      const after = fs.readFileSync(f, 'utf8');
      assert.ok(after.includes('// R28 dsh-app'), c.label + ' 应写入 R28 标记');
      assert.ok(after.includes('liveProviders'), c.label + ' 应含「实时优先」逻辑');
      assert.ok(after.includes('catalogReply'), c.label + ' 应含目录回退');
      assert.strictEqual(after.includes('inputModalities: [...model.input]'), c.expectInputMod,
        c.label + ' 的 inputModalities 保留情况不符（吃掉新字段 = 静默降级）');
      // 幂等：已含标记时直接返回 true，不重复改写
      assert.strictEqual(fake.applyLiveModelDiscoveryPatch({ dir }), true, c.label + ' 第二轮应跳过');
    } finally { rm(dir); }
  }
});

t('launcher 补丁：R19 在 0.1.7 上识别「上游已自带」而不是误报版本变化', () => {
  const src = read('launcher.js');
  assert.ok(src.includes('上游已自带 STARTF_USESHOWWINDOW+SW_HIDE（无需补丁）'),
    'R19 补丁2 必须区分「上游已修」与「锚点意外变化」');
  assert.ok(src.includes('上游已自带 windowsHide（无需补丁）'),
    'R19 补丁1 同上');
  // 0.1.7-rc.2 的 win32-process 实测就是 dwFlags: 257 + wShowWindow: 0
  assert.ok(/src\.includes\('dwFlags: 257'\)/.test(src), '判定上游已修的依据必须写进代码');
});

console.log('');
Promise.all(pending).then(() => {
  console.log('===== ' + passed + ' passed, 0 failed =====');
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  console.error('===== ' + passed + ' passed, ' + pending.length + ' async pending, FAILED =====');
  process.exit(1);
});
