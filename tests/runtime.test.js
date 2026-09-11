// tests/runtime.test.js — 2026-09-10 审计修复的回归测试
//
// 覆盖对象（全部用桩/临时目录，不真启动子进程、不碰真实用户数据）：
//   1) launcher：stop() 必须复位 running；首次安装闸门（并发 start 只装一次）；
//      stop() 可取消安装；字节基线等契约
//   2) watchdog：安全模式下二次失败的**终态**（旧版静默 return → UI 永久"正在重启…"）；
//      Level 2 备份不被覆盖
//   3) market：install/remove 的包名校验（cmd broker 命令注入面）
//   4) gateway-manager：配置原子写；PowerShell 特征的引号转义；清理特征不退回裸兜底
//   5) main/preload/renderer：IPC 来源守卫接线、主窗口 preload 与 status.html 对齐
// 运行：node tests/runtime.test.js
'use strict';

process.noAsar = true;   // 与 integration.js 同理：Electron 运行时会拦截 .asar 路径

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const SRC = path.join(__dirname, '..', 'src');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-app-rt-'));

let passed = 0;
const __tests = [];
function t(name, fn) { __tests.push({ name, fn }); }

// 本机 shell 对 node 的 stdout 捕获偶发失效（Electron-as-node + 管道），
// 需要留痕时用 DSH_TEST_LOG=<文件> 追加一份同样的输出。
const LOG_FILE = process.env.DSH_TEST_LOG || '';
function report(line) {
  console.log(line);
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (_) { /* 忽略 */ } }
}

// ---------------- 子进程桩（必须在 require launcher/gateway-manager 之前） ----------------
const cp = require('child_process');
const spawnCalls = [];
const killCalls = [];
function fakeProc(cmd, args) {
  const p = new EventEmitter();
  p.pid = 50000 + spawnCalls.length;
  p.exitCode = null;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {
    killCalls.push(cmd);
    setImmediate(() => { p.exitCode = 0; p.emit('exit', 0); });
  };
  p.__cmd = cmd;
  p.__args = args || [];
  return p;
}
cp.spawn = (cmd, args) => { spawnCalls.push({ cmd, args: args || [] }); return fakeProc(cmd, args); };
cp.spawnSync = () => ({ status: 0, stdout: '', stderr: '' });

const { Launcher } = require(path.join(SRC, 'launcher.js'));
const { Watchdog } = require(path.join(SRC, 'watchdog.js'));
const market = require(path.join(SRC, 'market.js'));
const { GatewayManager } = require(path.join(SRC, 'gateway-manager.js'));
const { DEFAULTS } = require(path.join(SRC, 'settings.js'));

const noopLog = { appendLog() {} };
function mkLauncher(extra) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'l-'));
  const settings = { data: Object.assign({ port: 3080, safeMode: false, workDir: dir }, extra || {}), safePatchPath: path.join(dir, 'safe.yml') };
  const L = new Launcher({ settings, logger: noopLog, workDir: dir });
  L.nodeInfo = { exe: 'node', env: {}, embedded: false };
  L.nodePath = 'node';
  return { L, dir, settings };
}

// ================= 1. launcher =================

t('launcher：stop() 必须复位 running（旧版 running 永停 true）', async () => {
  const { L } = mkLauncher();
  L.found = { dir: tmpRoot, version: '9.9.9', bin: path.join(tmpRoot, 'bin.js') };
  L.start();
  assert.strictEqual(L.running, true, 'start 后应 running=true');
  await L.stop();
  assert.strictEqual(L.running, false, 'stop 后 running 必须为 false（否则升级/就绪判断全部失真）');
  assert.strictEqual(L.ready, false, 'stop 后 ready 必须为 false');
  assert.strictEqual(L.proc, null);
});

t('launcher：首次安装闸门——installing 期间的 start() 直接返回（不并发装第二份）', async () => {
  const { L } = mkLauncher();
  L.found = null;                                  // 模拟"本机未安装 dsh"
  L.start();                                       // 第 1 次：进入安装流程（同步置 installing）
  assert.strictEqual(L.installing, true, 'start() 必须同步置 installing（否则闸门无效）');
  const afterFirst = spawnCalls.length;
  L.start();                                       // 第 2 次（用户在"安装中"再点启动）
  assert.strictEqual(spawnCalls.length, afterFirst, '安装期间不得再 spawn 任何安装进程');
  await L.stop();                                  // 取消安装
  assert.strictEqual(L.installing, false, 'stop() 应清除安装闸门（允许重新启动）');
});

t('launcher：stop() 取消进行中的安装子进程（安装进程不在 this.proc 上）', async () => {
  const { L } = mkLauncher();
  L.found = null;
  L.start();
  const child = new EventEmitter();
  child.kill = () => killCalls.push('install-child');
  L.installChild = child;                          // 直接注入（不依赖走 npm 还是 npx 分支）
  await L.stop();
  assert.ok(killCalls.indexOf('install-child') >= 0, 'stop() 必须杀掉进行中的安装子进程');
  assert.strictEqual(L.installChild, null, '句柄应清空');
});

t('launcher：found 存在时 installing 闸门不影响正常启动', async () => {
  const { L } = mkLauncher();
  L.found = { dir: tmpRoot, version: '9.9.9', bin: path.join(tmpRoot, 'bin.js') };
  L.installing = true;
  L.start();
  assert.strictEqual(L.proc, null, '闸门生效时不 spawn');
  L.installing = false;
  L.start();
  assert.ok(L.proc, '闸门清除后应正常 spawn');
  await L.stop();
});

// ================= 2. watchdog =================

function mkWatchdog(opts) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'w-'));
  const updates = [];
  const logs = [];
  const settings = {
    data: Object.assign({ safeMode: false, safeModeLevel: 0, safeModeNames: '', port: 3080 }, (opts || {}).data || {}),
    dir,
    save() {},
    get safePatchPath() { return path.join(dir, 'safe.yml'); },
  };
  const wd = new Watchdog({
    settings,
    launcher: { nodePath: 'node', found: null, webLogBaseline: 0, ready: false, probeHealth: async () => false },
    state: { update: (p) => updates.push(p) },
    logger: { appendLog: (m) => logs.push(m) },
    workDir: dir,
  });
  return { wd, updates, logs, dir, settings };
}

t('watchdog：已触发且已在安全模式 → 必须给出失败终态（旧版静默 return 卡住 UI）', async () => {
  const { wd, updates } = mkWatchdog({ data: { safeMode: true, safeModeLevel: 1 } });
  wd.triggered = true;                 // Level1 重启后再次失败的时序
  await wd.tryRecover();
  assert.ok(updates.length > 0, '必须有状态更新（旧版此处 0 次更新 → UI 永久"正在重启…"）');
  const last = updates[updates.length - 1];
  assert.strictEqual(last.service, 'failed');
  assert.ok(/安全模式/.test(last.phase), 'phase 应说明安全模式也未能启动：' + last.phase);
});

t('watchdog：非安全模式且日志无插件特征 → 失败但不进安全模式（不误伤）', async () => {
  const { wd, updates, settings } = mkWatchdog();
  await wd.tryRecover();
  assert.strictEqual(updates[updates.length - 1].service, 'failed');
  assert.strictEqual(settings.data.safeMode, false, '不得进入安全模式');
});

t('watchdog：Level2 备份不被第二次覆盖（防原始配置被"已剥离版本"顶掉）', () => {
  const { wd, dir } = mkWatchdog();
  const profile = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true });
  const pj = path.join(profile, 'package.json');
  fs.writeFileSync(pj, 'ORIGINAL', 'utf8');
  wd.profileDir = profile;
  assert.strictEqual(wd.backupProfile(), true);
  fs.writeFileSync(pj, 'STRIPPED', 'utf8');       // 模拟已剥离后的 profile
  wd.backupProfile();                              // 第二次进入 Level 2
  assert.strictEqual(fs.readFileSync(pj + '.dshsafe.bak', 'utf8'), 'ORIGINAL', '备份必须保持原始内容');
});

// ================= 3. market 包名校验 =================

t('market：install/remove 拒绝非法包名（cmd broker 注入面）', async () => {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'm-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const ops = new market.MarketOps({
      nodeInfo: { exe: process.execPath, env: {}, embedded: true },
      dshBin: path.join(tmpRoot, 'fake-bin.js'),
      log: () => {},
    });
    const evil = 'pkg" & echo INJECTED & rem "';
    for (const fn of ['install', 'remove']) {
      const before = spawnCalls.length;
      const r = await ops[fn](evil, () => {});
      assert.strictEqual(r.ok, false, fn + ' 必须拒绝非法包名');
      assert.strictEqual(r.error, 'invalid-name');
      assert.strictEqual(spawnCalls.length, before, fn + ' 不得 spawn 任何进程');
    }
    // file: 规格默认拒绝，显式 allowFile 才放行（内部默认插件用）
    const r2 = await ops.install('file:vendor/dsh-email-bridge', () => {});
    assert.strictEqual(r2.ok, false, 'file: 规格默认应被拒绝');
    // 注意：allowFile 分支会进入真实安装流程（桩进程不会自行退出 → 不 await，只断言已 spawn）
    const before3 = spawnCalls.length;
    ops.install('file:vendor/dsh-email-bridge', () => {}, { allowFile: true }).catch(() => {});
    assert.ok(spawnCalls.length > before3, 'allowFile 时应通过校验并进入安装流程');
    // broker 脚本里不得出现注入串
    const broker = path.join(home, 'market', 'plugin-op.cmd');
    if (fs.existsSync(broker)) {
      assert.ok(!/INJECTED/.test(fs.readFileSync(broker, 'utf8')), 'broker 脚本不得含注入内容');
    }
    assert.strictEqual(market.isValidNpmName('@scope/pkg'), true);
    assert.strictEqual(market.isValidNpmName('pkg" & calc'), false);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});

t('market：无代理配置时不注入 127.0.0.1:7890 兜底', () => {
  const src = fs.readFileSync(path.join(SRC, 'market.js'), 'utf8');
  assert.ok(!/if \(!process\.env\.HTTPS_PROXY\) process\.env\.HTTPS_PROXY = 'http:\/\/127\.0\.0\.1:7890'/.test(src),
    '不得无条件兜底 7890（未开 clash 的机器上会让所有 fetch ECONNREFUSED）');
});

// ================= 4. gateway-manager =================

t('gateway：saveConfig 原子落盘（不留 .tmp、内容正确）', async () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'g-'));
  const gm = new GatewayManager({
    userDataDir: dir, nodePath: 'node', settings: { data: {} }, logger: noopLog,
  });
  gm.init();
  const good = JSON.stringify({
    port: 3091, apiKey: 'k',
    providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'sk-1', models: ['m'], priority: 1, enabled: true }],
  });
  const r = await gm.saveConfig(good);              // running=false → 不会 restart
  assert.strictEqual(r.ok, true, '保存应成功: ' + r.error);
  assert.strictEqual(gm.configText(), good, '内容应一致');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, [], '不得残留临时文件');
});

t('gateway：PowerShell 命令行特征转义单引号（路径含 \' 不再失效）', () => {
  const src = fs.readFileSync(path.join(SRC, 'gateway-manager.js'), 'utf8');
  assert.ok(/String\(marker\)\.replace\(\/'\/g, "''"\)/.test(src), '应把单引号翻倍转义后再拼 PowerShell');
});

t('gateway：killAllDshProcesses 不再退回裸 @deepseek-ai 兜底', () => {
  const src = fs.readFileSync(path.join(SRC, 'gateway-manager.js'), 'utf8');
  assert.ok(!/dataDir \|\| '@deepseek-ai'/.test(src), '缺 dataDir 时不得用裸特征（会误杀用户/桌面助手进程）');
});

t('gateway：writeDsh 不再用 spawnSync 阻塞主进程', () => {
  const src = fs.readFileSync(path.join(SRC, 'gateway-manager.js'), 'utf8');
  const body = src.slice(src.indexOf('writeDsh()'));
  assert.ok(/new Promise\(\(resolve\)/.test(body.slice(0, 400)), 'writeDsh 应改为异步 spawn');
  assert.ok(!/const r = spawnSync\(\s*this\.nodePath/.test(src), '不得再用 spawnSync 跑 write-dsh');
});

// ================= 5. 主进程接线与 IPC 来源守卫 =================

t('main.js：所有壳级 IPC 都经来源守卫注册（无逃逸的 ipcMain.handle）', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.ok(/function fromLocalPage\(event\)/.test(src), '必须有来源帧校验函数');
  assert.ok(/sender\.mainFrame/.test(src), '必须校验是主框架（防注入 iframe 绕过）');
  assert.ok(/\/renderer\/\[A-Za-z0-9\._-\]\+\\\.html\$/i.test(src) || /renderer\\?\//.test(src), '应校验路径属于本应用 renderer');
  const raw = src.match(/^\s*ipcMain\.handle\(/gm) || [];
  assert.strictEqual(raw.length, 0, '不得有绕过 handle() 包装的 ipcMain.handle（发现 ' + raw.length + ' 处）');
  const guarded = src.match(/^\s*handle\('/gm) || [];
  assert.ok(guarded.length >= 10, '应有多条经守卫注册的通道，实际 ' + guarded.length);
});

t('main.js：主窗口 preload 与 status.html 对齐（不能只挂窄桥）', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.ok(/createMainWindow[\s\S]*?preload: path\.join\(__dirname, 'preload\.js'\)/.test(main),
    '主窗口必须挂 preload.js（status.html 依赖 window.dshApp）');
  const status = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'status.html'), 'utf8');
  assert.ok(/window\.dshApp\./.test(status), 'status.html 仍使用 dshApp（改动 preload 时必须同步）');
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  assert.ok(/exposeInMainWorld\('dshApp'/.test(preload), 'preload 必须暴露 dshApp');
  assert.ok(/exposeInMainWorld\('__dshAppIh'/.test(preload), 'preload 必须暴露输入状态上报通道');
});

t('main.js：输入历史决策路径不含 await（preventDefault 必须同步）', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const start = src.indexOf('const onBeforeInput');
  const end = src.indexOf('win.webContents.on(\'before-input-event\'', start);
  assert.ok(start > 0 && end > start, '应能定位 onBeforeInput 处理器');
  const body = src.slice(start, end);
  assert.ok(!/await /.test(body), 'before-input-event 处理器内不得有 await（否则 preventDefault 失效）');
  assert.ok(/ihMirror/.test(body), '状态必须从主进程镜像同步读取');
  assert.ok(/preventDefault\(\)/.test(body), '应保留 preventDefault');
});

t('renderer：市场列表按"请求前游标"清空（旧版刷新/搜索会无限追加重复）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
  assert.ok(!/mkCursor === '' && list\.dataset\.fresh !== '1'/.test(html),
    '旧清空条件判断的是"响应后的游标"，永远不会成立');
  assert.ok(/const isFirstPage = mkCursor === '';/.test(html), '应在请求前记录是否首页');
});

t('renderer：编辑 JSON 后回填总览控件（旧版保存时静默回滚用户改动）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
  const i = html.indexOf("$('gwConfig').addEventListener('input'");
  const seg = html.slice(i, i + 400);
  assert.ok(/gwFillOverview\(\)/.test(seg), 'JSON 输入处理器必须回填总览控件');
});

t('renderer：加载管线与网关状态渲染有错误兜底（旧版一处抛错全页冻结）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
  assert.ok(/async function load\(\) \{[\s\S]{0,200}try \{/.test(html), 'load() 入口应有 try/catch');
  assert.ok(/function gwRender\(gs\) \{\s*\n\s*gs = gs \|\| \{\};/.test(html), 'gwRender 首行应兜底 gs');
});

t('renderer：核心 bundle 不提供「卸载」（防误卸 dsh 本体）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
  assert.ok(/item\.pkg && installed && !item\.core/.test(html), '核心包不得渲染卸载按钮');
  assert.ok(/core: \/\^@deepseek-ai\\\/\//.test(html), '已安装视图应标记核心包');
});

t('settings：新增默认项 trayBalloonShown（托盘气泡仅首次）', () => {
  assert.strictEqual(DEFAULTS.trayBalloonShown, false);
});

t('settings：端口越界在 update() 内被兜底（手改/异常输入不落到 spawn 参数）', () => {
  const { Settings } = require(path.join(SRC, 'settings.js'));
  const dir = fs.mkdtempSync(path.join(tmpRoot, 's-'));
  const s = new Settings(dir);
  s.load();
  s.update({ port: 99999 });
  assert.strictEqual(s.data.port, DEFAULTS.port, '越界端口应回退默认值');
  s.update({ port: 0 });
  assert.strictEqual(s.data.port, DEFAULTS.port);
  s.update({ port: 3100 });
  assert.strictEqual(s.data.port, 3100, '合法端口应保留');
});

// ================= 6. 2026-09-10 第二轮：src 其余修复 =================

t('gateway：probeHealth 只认 200（3xx/4xx 不再被当成"网关已就绪"）', async () => {
  const http = require('http');
  const gm = new GatewayManager({ userDataDir: fs.mkdtempSync(path.join(tmpRoot, 'ph-')), nodePath: 'node', settings: { data: {} }, logger: noopLog });
  const mk = (code) => new Promise((resolve) => {
    const srv = http.createServer((_q, r) => { r.writeHead(code).end('x'); });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const s404 = await mk(404);
  const s200 = await mk(200);
  try {
    gm.port = s404.address().port;
    assert.strictEqual(await gm.probeHealth(1000), false, '404 不能算健康');
    gm.port = s200.address().port;
    assert.strictEqual(await gm.probeHealth(1000), true, '200 才算健康');
  } finally { s404.close(); s200.close(); }
});

t('gateway：进程清理已改异步（不再用 spawnSync 冻结主进程）', () => {
  const src = fs.readFileSync(path.join(SRC, 'gateway-manager.js'), 'utf8');
  assert.ok(/async function killAllDshProcesses/.test(src), 'killAllDshProcesses 应为 async');
  assert.ok(/async function killProcessesByCommandline/.test(src), 'killProcessesByCommandline 应为 async');
  assert.ok(/async killStaleGatewayProcesses/.test(src), 'killStaleGatewayProcesses 应为 async');
  assert.ok(/function runPowerShell\(/.test(src), '应有异步 PowerShell 助手');
  assert.ok(/await killAllDshProcesses\(/.test(fs.readFileSync(path.join(SRC, 'main.js'), 'utf8')), 'main.js 退出清理应 await');
  assert.ok(/await this\.killStaleGatewayProcesses\(\)/.test(src), 'start/restart 应 await 清理');
});

t('gateway：自愈上限改滑动窗口（一次健康不再清零）', () => {
  const src = fs.readFileSync(path.join(SRC, 'gateway-manager.js'), 'utf8');
  assert.ok(/_healTimes/.test(src), '应使用自愈时间戳数组');
  assert.ok(!/_healFails\s*=\s*0/.test(src), '不应再有"健康即清零"');
});

t('logger：轮转用 rename（保留历史，不复制不丢段）', () => {
  const logger = require(path.join(SRC, 'logger.js'));
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'log-'));
  logger.init(dir);
  const chunk = 'x'.repeat(300 * 1024);
  for (let i = 0; i < 5; i++) logger.appendLog(chunk);
  const cur = path.join(dir, 'logs', 'app.log');
  const prev = cur + '.prev';
  assert.ok(fs.existsSync(prev), '超过 1MB 应轮转到 .prev');
  assert.ok(fs.statSync(cur).size < 1024 * 1024, '当前文件应在阈值内');
  assert.ok(fs.statSync(prev).size > 0, '历史不应为空（旧实现清空后崩溃即丢段）');
});

t('datadir：空 providers 但已有真实网关 Key 的配置不判为"模拟"（不被外部来源覆盖）', () => {
  const { isMockLikeConfig } = require(path.join(SRC, 'datadir.js'));
  const withKey = JSON.stringify({ port: 3091, apiKey: 'dsh-gateway-abcdef0123456789', providers: [] });
  assert.strictEqual(isMockLikeConfig(withKey), false, '已有真实 key 的空配置不该被覆盖');
  assert.strictEqual(isMockLikeConfig(JSON.stringify({ port: 3091, providers: [] })), true, '真正空的配置仍视为待初始化');
  assert.strictEqual(isMockLikeConfig('{broken'), true, '解析失败按模拟处理（保持旧行为）');
});

t('main.js：渲染进程崩溃有恢复入口 + 临时数据目录有告警', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.ok(/render-process-gone/.test(src), '应处理渲染进程崩溃（旧版永久白屏）');
  assert.ok(/已回到状态页/.test(src), '崩溃后应回到本地状态页并提示');
  assert.ok(/on\('unresponsive'/.test(src), '应记录界面无响应');
  assert.ok(/os\.tmpdir\(\)/.test(src) && /位于系统临时目录/.test(src), '数据目录落在临时目录时必须告警');
});

t('updater：系统 npm 回退路径对参数加引号（路径含空格不再拆断 --prefix）', () => {
  const src = fs.readFileSync(path.join(SRC, 'updater.js'), 'utf8');
  assert.ok(/function shellQuote\(/.test(src), '应有 shell 引用工具');
  assert.ok(/args\.map\(shellQuote\)/.test(src), 'shell 分支的参数必须逐个引用');
  assert.ok(!/spawn\('npm', args, \{ windowsHide: true, shell: true/.test(src), '不得再直接传数组走 shell');
});

t('gateway/renderer：逐请求日志走节流事件推送（日志框实时且不打断阅读）', () => {
  const gm = fs.readFileSync(path.join(SRC, 'gateway-manager.js'), 'utf8');
  assert.ok(/this\.emit\('log'\)/.test(gm), 'pushLog 应节流 emit log');
  assert.ok(/_logEmitAt/.test(gm), '应有节流时间戳');
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.ok(/gateway\.on\('log'/.test(main), 'main.js 应把 log 事件推给设置窗');
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  assert.ok(/onGwState/.test(preload), 'preload 应暴露 gw:state 订阅');
});

t('main.js：设置窗有导航守卫 + 卡片定位不再丢事件', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const sw = src.slice(src.indexOf('function createSettingsWindow'));
  assert.ok(/settingsWindow\.webContents\.on\('will-navigate'/.test(sw), '设置窗应拒绝外部导航');
  assert.ok(/isLoading\(\)/.test(src), 'focusSection 应处理页面未加载完的情况');
});

t('watchdog：dump-config 失败时退回 patch 索引定位条目（不再直接剥离全部插件）', () => {
  const { wd, dir } = mkWatchdog();
  const profile = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: other',
    '      name: other-plugin',
    '    - id: email',
    '      name: dsh-email-bridge',
    '',
  ].join('\n'), 'utf8');
  wd.profileDir = profile;
  const yaml = wd.patchEntryIndex();
  assert.ok(yaml, '应能从 patch 文件生成索引');
  const { resolveEntryIds } = require(path.join(SRC, 'watchdog.js'));
  assert.deepStrictEqual(resolveEntryIds(yaml, ['dsh-email-bridge']), ['email'],
    '索引应能被 resolveEntryIds 用于匹配故障插件名');
  assert.strictEqual(wd.patchEntryIndex.length >= 0, true);
});

t('scripts：PowerShell 脚本必须带 UTF-8 BOM（PS5.1 下缺 BOM 会解析失败）', () => {
  const dir = path.join(__dirname, '..', 'scripts');
  const ps1 = fs.readdirSync(dir).filter((f) => f.endsWith('.ps1'));
  assert.ok(ps1.length > 0, '应存在 .ps1 脚本');
  for (const f of ps1) {
    const b = fs.readFileSync(path.join(dir, f));
    assert.ok(b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF,
      f + ' 缺少 UTF-8 BOM——在 ACP=936 的 powershell.exe 5.1 下会整体解析失败（中文注释被按 GBK 解码）。'
      + '注意：某些编辑器/替换工具写回时会吞掉 BOM，改完必须补回。');
  }
});

t('scripts：便携版产物名已 ASCII 化，且发布脚本仍兼容旧中文名', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.build.portable.artifactName, 'DSHApp-Portable-${version}-x64.exe',
    '便携版产物名应为纯 ASCII（旧名含中文，编码差异会让查找静默失败）');
  const pub = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'publish.mjs'), 'utf8');
  assert.ok(/portableLocalPath/.test(pub), 'publish 应通过 portableLocalPath 定位（含旧名回退）');
  assert.ok(/DSHApp-Portable-' \+ ver \+ '-x64\.exe'/.test(pub), '应优先找 ASCII 产物名');
  const rel = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.ps1'), 'utf8');
  assert.ok(/DSHApp-Portable-" \+ \$ver \+ "-x64\.exe/.test(rel), 'release.ps1 应优先找 ASCII 产物名');
  assert.ok(!/DSHApp-release-v1\.5\.0/.test(rel));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'scripts', 'release-v1.5.0.ps1')),
    '陈旧的写死版本发布脚本应已删除（其引用的产物已不存在）');
});

// ================= 7. 2026-09-10 第三轮：模型发现实时化 + 输入历史按会话隔离 =================

t('launcher R28：模型发现补丁可应用、幂等、且产出合法 JS', () => {
  const { Launcher } = require(path.join(SRC, 'launcher.js'));
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'r28-'));
  const libDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const file = path.join(libDir, 'index.js');
  // 与 dsh 0.1.5-rc.1 中 discoverModels 的目录短路分支同形（TAB 缩进）
  const anchor = [
    '\tif (request.provider !== void 0) {',
    '\t\tconst installed = catalogModels(request.provider);',
    '\t\tif (installed.size > 0) return [...installed.values()].map((model) => ({',
    '\t\t\tid: model.id,',
    '\t\t\tname: model.name,',
    '\t\t\tcontextWindow: model.contextWindow,',
    '\t\t\tmaxTokens: model.maxTokens',
    '\t\t}));',
    '\t}',
  ].join('\n');
  fs.writeFileSync(file, 'async function discoverModels(request, storedProfile) {\n' + anchor + '\n\treturn [];\n}\n', 'utf8');
  const inst = new Launcher({
    settings: { data: { port: 3080, safeMode: false, workDir: dir }, safePatchPath: path.join(dir, 'safe.yml') },
    logger: noopLog, workDir: dir,
  });
  assert.strictEqual(inst.applyLiveModelDiscoveryPatch({ dir }), true, '应成功打补丁');
  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.includes('// R28 dsh-app'), '应有 R28 标记');
  assert.ok(/liveProviders\.has\(request\.provider\)/.test(patched), '应加入白名单判断');
  assert.ok(/provider: void 0/.test(patched), '递归调用必须清掉 provider（否则死循环）');
  assert.ok(/return catalogReply;/.test(patched), '实时失败必须回退目录');
  // 语法：改成 .mjs 让 node --check 按 ESM 解析
  const chk = path.join(libDir, 'chk.mjs');
  fs.writeFileSync(chk, patched, 'utf8');
  const r = require('child_process').spawnSync(process.execPath, ['--check', chk], { stdio: 'ignore' });
  assert.strictEqual(r.status, 0, '补丁后的文件必须语法合法');
  // 幂等
  assert.strictEqual(inst.applyLiveModelDiscoveryPatch({ dir }), true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), patched, '重复打补丁不得再改内容');
});

t('main.js：注入页面的输入辅助脚本语法合法，且含会话 id 侦测', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const m = src.match(/const INPUT_HELPER_JS = \[([\s\S]*?)\]\.join\('\\n'\);/);
  assert.ok(m, '应能定位 INPUT_HELPER_JS 数组');
  // 仅由字符串字面量与注释组成，可安全求值
  // eslint-disable-next-line no-eval
  const lines = eval('[' + m[1] + ']');
  const helper = lines.join('\n');
  assert.doesNotThrow(() => { new (require('vm').Script)(helper, { filename: 'input-helper.js' }); },
    '注入到 dsh 页面的辅助脚本必须是合法 JS（否则输入历史整体失效）');
  assert.ok(/WebSocket\.prototype\.send/.test(helper), '应钩住 WebSocket.send 以侦测当前会话');
  assert.ok(/__dshAppIhSid/.test(helper), '应维护会话 id');
  assert.ok(/sid:\(window\.__dshAppIhSid/.test(helper), '上报应带会话 id');
});

t('main.js：输入历史按会话隔离（不再全站一个桶）', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.ok(/if \(ihSid\) return port \+ '\|sid:' \+ ihSid;/.test(src), '会话已知时按会话 id 分桶');
  assert.ok(/\|pending\|/.test(src), '会话未知时用独立的 pending 桶（不混入其它会话）');
  assert.ok(/ihSessionHook/.test(src), '提交后才学到会话 id 时应补记到正确会话');
  assert.ok(/pendingTimer = setTimeout\(\(\) => \{ pendingValue = ''/.test(src),
    '超时未学到会话 id 应丢弃而不是写错桶');
  assert.ok(!/return port \+ '\|' \+ pathname \+ hash;/.test(src), '不应再回退到全站共享的 URL 桶');
});

t('main.js：会话 id 提取有优先级，且用会话库校验、旧历史一次性迁移', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.ok(/function knownSessionIds\(\)/.test(src), '应有会话库（~/.dsh/sessions）校验');
  assert.ok(/!ids\.has\(sid\) && ihSid && ids\.has\(ihSid\)/.test(src),
    '不因为一个查不到的候选 id 丢掉已验证的会话');
  assert.ok(/legacyMigrated/.test(src) && /一次性迁移/.test(src), '旧版全站历史应一次性并入会话桶');
  assert.ok(/histories\.delete\(lk\)/.test(src), '迁移后应移除旧桶（避免再次并入其它会话）');

  // 真跑一遍 pickSid：从注入脚本里抽出该函数，在 vm 里验证优先级
  const m = src.match(/const INPUT_HELPER_JS = \[([\s\S]*?)\]\.join\('\\n'\);/);
  // eslint-disable-next-line no-eval
  const lines = eval('[' + m[1] + ']');
  const from = lines.findIndex((l) => l.startsWith('function pickSid('));
  assert.ok(from >= 0, '应能定位 pickSid');
  const to = lines.indexOf('}', from);
  const fnSrc = lines.slice(from, to + 1).join('\n');
  const vm = require('vm');
  const ctx = { __out: '' };
  vm.createContext(ctx);
  vm.runInContext(fnSrc
    + '\n__out = [pickSid(\'{"sessionId":"session-a","childSessionId":"child-b"}\'),'
    + ' pickSid(\'{"agentId":"session-c"}\'),'
    + ' pickSid(\'{"childSessionId":"child-d"}\'),'
    + ' pickSid(\'{"other":1}\')];', ctx);
  // vm 里的数组来自另一个 realm，deepStrictEqual 会因原型不同而失败 → 比较 JSON
  assert.strictEqual(JSON.stringify(ctx.__out), JSON.stringify(['session-a', 'session-c', 'child-d', '']),
    'sessionId > agentId > childSessionId，无匹配返回空串；实际 ' + JSON.stringify(ctx.__out));
});

// ================= 执行 =================
(async () => {
  for (const { name, fn } of __tests) {
    await fn();
    passed++;
    report('PASS  ' + name);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  report('');
  report('===== ' + passed + ' passed, 0 failed =====');
  process.exit(0);   // 桩化的子进程/定时器可能悬挂 → 显式退出
})().catch((e) => {
  report('FAIL  ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
