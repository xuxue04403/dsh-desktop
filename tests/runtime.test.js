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
// 失败注入开关（可移植性用例用）：为 true 时，任何以 cmd 启动的"broker"桩进程都会异步
// 抛出 ENOENT——复现"克隆机 ComSpec 指向不存在的 cmd.exe"这一真实故障。
let cmdSpawnFails = false;
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
cp.spawn = (cmd, args) => {
  spawnCalls.push({ cmd, args: args || [] });
  const p = fakeProc(cmd, args);
  if (cmdSpawnFails && /cmd(\.exe)?$/i.test(String(cmd))) {
    setImmediate(() => p.emit('error', Object.assign(new Error('spawn ' + cmd + ' ENOENT'), { code: 'ENOENT' })));
  }
  return p;
};
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

t('gateway：PowerShell 命令行特征转义单引号（路径含 \' 不再失效）+ 只按映像名过滤', () => {
  const src = fs.readFileSync(path.join(SRC, 'gateway-manager.js'), 'utf8');
  assert.ok(/replace\(\/'\/g, "''"\)/.test(src), '应把单引号翻倍转义后再拼 PowerShell');
  assert.ok(/Get-CimInstance Win32_Process -Filter/.test(src),
    '进程枚举必须带服务端 -Filter（全量枚举在进程多的机器上单次 5-20 秒，退出会卡几十秒）');
  assert.ok(!/Get-CimInstance Win32_Process \|/.test(src), '不得再无过滤地枚举全部进程');
  assert.ok(/killProcessesByCommandlines\(markers/.test(src),
    '退出清理的三个特征应一次枚举完成（旧版逐个调用 = 3 次全量查询）');
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

t('gateway：computeNoProxy 按供应商 proxy:false + 全局 proxy.noProxy 生成直连清单（2026-09-16 抗抖动）', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'nop-'));
  const gm = new GatewayManager({
    userDataDir: dir, nodePath: 'node', settings: { data: {} }, logger: noopLog,
  });
  gm.init();
  const cfg = {
    port: 3091, apiKey: 'k',
    proxy: { enabled: true, url: 'http://127.0.0.1:7890', noProxy: ['api.tokenrouter.com', 'https://token.sensenova.cn'] },
    providers: [
      { id: 'air-outer', baseURL: 'https://ps.air-outer.com/', apiKey: 'sk-1', models: ['m'], priority: 1, enabled: true, proxy: false },
      { id: 'chiyi-ds', baseURL: 'https://api.chiyi.cc', apiKey: 'sk-2', models: ['m'], priority: 2, enabled: true, noProxy: true },
      { id: 'x666', baseURL: 'https://x666.me', apiKey: 'sk-3', models: ['m'], priority: 3, enabled: true },  // 未设 → 走代理
      { id: 'off', baseURL: 'https://off.example.org', apiKey: 'sk-4', models: ['m'], priority: 4, enabled: false, proxy: false },  // disabled → 忽略
    ],
  };
  fs.writeFileSync(path.join(dir, 'gateway.config.json'), JSON.stringify(cfg), 'utf8');
  const out = gm.computeNoProxy();
  assert.ok(out.includes('ps.air-outer.com'), 'provider.proxy:false 应加入直连清单：' + out);
  assert.ok(out.includes('api.chiyi.cc'), 'provider.noProxy:true 应加入直连清单：' + out);
  assert.ok(out.includes('api.tokenrouter.com'), '全局 proxy.noProxy 数组项应加入：' + out);
  assert.ok(out.includes('token.sensenova.cn'), '全局 proxy.noProxy 里的 URL 应取 hostname：' + out);
  assert.ok(!out.includes('x666.me'), '未设 proxy:false 的家不得直连（保持走代理）：' + out);
  assert.ok(!out.includes('off.example.org'), 'disabled 供应商不得加入：' + out);
  // v1.8.2：回环**永远**直连 + 国内端点默认直连（事故修复，见下一条用例）
  assert.ok(out.includes('127.0.0.1') && out.includes('localhost'), '回环必须永远直连：' + out);
  assert.ok(out.includes('copilot.tencent.com') && out.includes('workbuddy.cn'), 'WorkBuddy 国内端点默认直连：' + out);
  // 清空 proxy 块：仍须保留回环直连（旧实现返回 '' → 回环被塞进代理 → 自检自杀）
  const cfg2 = { port: 3091, apiKey: 'k', providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'sk-1', models: ['m'], priority: 1, enabled: true }] };
  fs.writeFileSync(path.join(dir, 'gateway.config.json'), JSON.stringify(cfg2), 'utf8');
  const bare = gm.computeNoProxy();
  assert.ok(/127\.0\.0\.1/.test(bare) && /localhost/.test(bare), '无 proxy 配置也必须保住回环直连：' + bare);
});

t('gateway：NO_PROXY 加固（v1.8.2 事故）——回环恒直连、forceProxy 可剔国内端点但剔不掉回环', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'nop2-'));
  const gm = new GatewayManager({
    userDataDir: dir, nodePath: 'node', settings: { data: {} }, logger: noopLog,
  });
  gm.init();
  const cfg = {
    port: 3091, apiKey: 'k',
    proxy: {
      enabled: true, url: 'http://127.0.0.1:7890',
      // 用户明确要求 workbuddy 走端口代理（例如海外网络直连不通）
      forceProxy: ['copilot.tencent.com'],
    },
    providers: [{ id: 'workbuddy', baseURL: 'https://copilot.tencent.com/v2', apiKey: 'sk-1', models: ['m'], priority: 1, enabled: true }],
  };
  fs.writeFileSync(path.join(dir, 'gateway.config.json'), JSON.stringify(cfg), 'utf8');
  const out = gm.computeNoProxy();
  assert.ok(!out.includes('copilot.tencent.com'), 'forceProxy 应能剔除默认直连的国内端点：' + out);
  assert.ok(out.includes('127.0.0.1'), 'forceProxy 不得剔掉回环（本机自检绝不允许被代理）：' + out);
  // 配置非法（JSON 坏）时也必须返回回环清单，不能返回空串
  fs.writeFileSync(path.join(dir, 'gateway.config.json'), '{ 坏 JSON', 'utf8');
  const bad = gm.computeNoProxy();
  assert.ok(/127\.0\.0\.1/.test(bad), '配置解析失败时仍须保住回环直连：' + JSON.stringify(bad));
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

// ================= 8. 2026-09-11：模型映射（上游真实 ID ↔ 逻辑模型名） =================

t('网关：模型映射解析（modelEntries/upstreamIdFor）覆盖同义字段与脏数据', () => {
  const src = fs.readFileSync(path.join(SRC, 'gateway', 'model-gateway.mjs'), 'utf8');
  const grab = (name) => {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, '应能定位 ' + name);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('未闭合：' + name);
  };
  const vm = require('vm');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab('modelEntries') + '\n' + grab('upstreamIdFor') + '\n' + grab('logicalModelNames')
    + '\n__e = modelEntries; __u = upstreamIdFor; __n = logicalModelNames;', ctx);
  const J = (v) => JSON.stringify(v);

  // 字符串 / 对象 / 同义字段 / 脏数据
  assert.strictEqual(J(ctx.__e({ models: ['a', ' b '] })), J([{ up: 'a', as: 'a' }, { up: 'b', as: 'b' }]),
    '字符串项：上游 ID 与逻辑名相同（并 trim）');
  assert.strictEqual(J(ctx.__e({ models: [{ id: 'u/v', as: 'l' }] })), J([{ up: 'u/v', as: 'l' }]), '{id,as}');
  assert.strictEqual(J(ctx.__e({ models: [{ id: 'u/v', alias: 'l' }] })), J([{ up: 'u/v', as: 'l' }]), 'alias 同义');
  assert.strictEqual(J(ctx.__e({ models: [{ id: 'u/v', model: 'l' }] })), J([{ up: 'u/v', as: 'l' }]), 'model 同义（逻辑名）');
  assert.strictEqual(J(ctx.__e({ models: [{ up: 'u/v', name: 'l' }] })), J([{ up: 'u/v', as: 'l' }]), 'up / name 同义键');
  // 两侧（网关 modelEntries 与配置页 gwNormalizeModels）语义必须一致：缺 id 时 model 兜底为上游 ID
  assert.strictEqual(J(ctx.__e({ models: [{ model: 'x', as: 'y' }] })), J([{ up: 'x', as: 'y' }]), '仅 model+as：model 作上游 ID');
  assert.strictEqual(J(ctx.__e({ models: [{ model: 'x' }] })), J([{ up: 'x', as: 'x' }]), '仅 model：等价于字符串写法');
  assert.strictEqual(J(ctx.__e({ models: [{ id: 'u/v' }] })), J([{ up: 'u/v', as: 'u/v' }]), 'as 缺省 = id');
  assert.strictEqual(J(ctx.__e({ models: [{ as: 'no-id' }, 123, null, '', {}] })), '[]', '无 id / 非字符串非对象一律忽略');
  assert.strictEqual(J(ctx.__e({})), '[]', '无 models 字段 → 空');
  assert.strictEqual(J(ctx.__e({ models: 'not-an-array' })), '[]', 'models 非数组 → 空（不抛错）');

  // 路由解析：同一逻辑名在不同供应商对应不同上游 ID（本需求的核心场景）
  const p1 = { models: [{ id: 'deepseek-ai/deepseek-v4-flash', as: 'deepseek-v4-flash' }] };
  const p2 = { models: [{ id: 'deepseek-v4-flash0731', as: 'deepseek-v4-flash' }] };
  assert.strictEqual(ctx.__u(p1, 'deepseek-v4-flash'), 'deepseek-ai/deepseek-v4-flash');
  assert.strictEqual(ctx.__u(p2, 'deepseek-v4-flash'), 'deepseek-v4-flash0731');
  assert.strictEqual(ctx.__u(p1, 'unknown-model'), null, '未声明 → null（原样透传）');
  assert.strictEqual(ctx.__u({ models: [{ id: 'v1', as: 'm' }, { id: 'v2', as: 'm' }] }, 'm'), 'v1', '同一逻辑名多条映射取第一条');
  assert.strictEqual(J(ctx.__n({ models: ['a', { id: 'x', as: 'a' }, { id: 'y', as: 'b' }] })), J(['a', 'b']), '逻辑名去重');
});

t('网关：配置校验接受映射条目、拒绝非法条目', () => {
  const { validateConfigText } = require(path.join(SRC, 'gateway-manager.js'));
  const ok = (models) => validateConfigText(JSON.stringify({ port: 3091, providers: [{ id: 'a', baseURL: 'https://a/v1', models }] })).ok;
  assert.strictEqual(ok(undefined), true, '无 models 字段仍合法');
  assert.strictEqual(ok([]), true);
  assert.strictEqual(ok(['x', { id: 'u', as: 'l' }, { id: 'u2' }]), true, '映射条目合法');
  assert.strictEqual(ok([123]), false, '数字条目非法');
  assert.strictEqual(ok([{ as: 'l' }]), false, '缺少 id 的映射非法');
  assert.strictEqual(ok('x'), false, 'models 非数组非法');
});

t('网关：配置校验覆盖 WorkBuddy 新字段（protocol/quirks/headers/accounts/auth）', () => {
  const { validateConfigText } = require(path.join(SRC, 'gateway-manager.js'));
  const check = (extra) => validateConfigText(JSON.stringify({
    port: 3091, apiKey: 'k',
    providers: [Object.assign({ id: 'p', baseURL: 'https://copilot.tencent.com/v2', apiKey: 'sk-x', models: ['m'] }, extra)],
  }));
  // 合法：完整的 WorkBuddy 形态
  assert.strictEqual(check({
    protocol: 'openai-chat', auth: 'workbuddy', quirks: ['force-stream', 'stringify-tool-choice'],
    headers: { 'X-Product': 'SaaS' }, accounts: [{ id: 'a1', authFile: 'C:/x.info' }, { id: 'a2', apiKey: 'sk-y' }],
  }).ok, true, '完整 WorkBuddy 配置应合法');
  // 非法：拼错的字段名/取值必须在保存前拦下（否则网关静默忽略 → 上游 404，极难排查）
  assert.strictEqual(check({ protocol: 'openai_chat' }).ok, false, 'protocol 拼错应被拒（下划线）');
  assert.strictEqual(check({ protocol: 'anthropic-messages' }).ok, true, 'anthropic-messages 合法');
  assert.strictEqual(check({ quirks: ['force_strem'] }).ok, false, '未知 quirk 应被拒');
  assert.strictEqual(check({ quirks: 'force-stream,prepend-system' }).ok, true, '逗号分隔字符串形式合法');
  assert.strictEqual(check({ headers: ['a'] }).ok, false, 'headers 非对象应被拒');
  assert.strictEqual(check({ accounts: { id: 'a1' } }).ok, false, 'accounts 非数组应被拒');
  assert.strictEqual(check({ accounts: [{ id: 'a1' }] }).ok, false, '非 workbuddy 供应商的 accounts 条目缺 authFile/apiKey 应被拒');
  // 免路径（2026-09-16 实测踩到的坑）：auth=workbuddy 时 accounts 只写 { id } 在**运行期是合法的**
  //（凭据按平台默认位置自动发现），校验器必须一致，否则设置页保存会误拒合法配置。
  assert.strictEqual(check({ auth: 'workbuddy', accounts: [{ id: 'a1' }] }).ok, true,
    'auth=workbuddy 时 accounts 只写 { id } 应合法（凭据自动发现）');
  assert.strictEqual(check({ auth: 'workbuddy', accounts: [{ id: 'a1' }, { id: 'a2', authFile: 'C:/x.info' }] }).ok, true,
    '免路径与显式路径可混用');
  assert.strictEqual(check({ auth: 'whatever' }).ok, false, '未知 auth 应被拒');
  // 2026-09-17 新增：同一供应商多把 Key（设置页「多 Key」→ apiKeys）。校验必须放行，
  // 否则保存被误拒（同类事故：workbuddy 免路径条目曾被误拒）。
  assert.strictEqual(check({ apiKeys: ['sk-a', 'sk-b'] }).ok, true, 'apiKeys 字符串数组应合法');
  assert.strictEqual(check({ apiKeys: 'sk-a, sk-b' }).ok, true, 'apiKeys 逗号分隔字符串也接受（运行期会切分）');
  assert.strictEqual(check({ apiKeys: ['sk-a', 123] }).ok, false, 'apiKeys 含非字符串应被拒');
  assert.strictEqual(check({ apiKeys: { k: 1 } }).ok, false, 'apiKeys 非数组/字符串应被拒');
});

t('renderer：设置页左侧分区导航（快速定位 + 滚动高亮，2026-09-17）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');

  // ① 导航项与分区 id 一一对应（顺序即页面顺序）
  const anchors = [...html.matchAll(/class="nav-item" href="#([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(anchors, ['card-service', 'card-window', 'card-gateway', 'card-market', 'card-diag'],
    '导航项应为 服务/窗口/模型网关/插件市场/更新与诊断，实际 ' + JSON.stringify(anchors));
  for (const id of anchors) assert.ok(html.includes('id="' + id + '"'), '分区容器必须存在：' + id);

  // ② 每个配置块都必须带 id —— 否则新增区块时导航会漏（这条断言就是防漏的）
  const cards = [...html.matchAll(/<div class="card"([^>]*)>\s*<h2>([^<]+)<\/h2>/g)];
  assert.strictEqual(cards.length, 5, '应有 5 个配置块，实际 ' + cards.length);
  for (const m of cards) {
    assert.ok(/id="card-[a-z-]+"/.test(m[1]), '配置块「' + m[2] + '」必须带 id="card-…"（供左侧导航定位）');
  }

  // ③ 布局包裹与闭合顺序（内容区必须在 <script> 之前闭合）
  assert.ok(/<div class="layout">[\s\S]{0,400}<nav class="sidenav"/.test(html), '应有 .layout 两列布局与 .sidenav');
  assert.ok(/<main class="content">/.test(html), '应有用例内容区 <main class="content">');
  assert.ok(/<\/main>\s*<\/div>\s*<script>/.test(html), '内容区必须在 <script> 之前闭合');

  // ④ 样式与交互（二稿：宽度自适应内容 + 字号加大，与右侧表单同体量）
  assert.ok(/\.sidenav\s*\{[^}]*position:\s*sticky/.test(html), '左侧导航应 sticky 固定');
  assert.ok(/\.sidenav\s*\{[^}]*min-width:\s*1\d\dpx/.test(html), '导航宽度应自适应内容（min-width 而非定宽 150px）');
  assert.ok(/\.nav-item\s*\{[^}]*font-size:\s*14/.test(html), '导航字号应与表单同体量（≥14px，首版 13px 被反馈"不搭"）');
  assert.ok(/\.nav-item\.active\s*\{/.test(html), '应有当前分区高亮样式');
  assert.ok(/scroll-behavior:\s*smooth/.test(html), '应有平滑滚动');
  assert.ok(/function initSideNav/.test(html), '应有导航初始化函数');
  assert.ok(/scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/.test(html), '点击导航项应平滑滚动到分区');
  assert.ok(/addEventListener\('scroll', spy/.test(html), '应监听滚动更新高亮');
  assert.ok(/offsetParent !== null/.test(html), '隐藏的分区不得参与高亮判定（否则 rect.top 恒 0）');
  assert.ok(/@media \(max-width: 820px\)[\s\S]{0,300}\.sidenav\s*\{[^}]*position:\s*static/.test(html),
    '窄窗口/大缩放应退化为横向药丸标签条（不遮挡内容）');
  assert.ok(/border-radius:\s*999px/.test(html), '窄窗口下导航项应为药丸形态');
});

t('renderer：供应商「API Key」合一框（每行一把）与明文开关（2026-09-17 二稿）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');

  // ① 控件形态：不再有独立的单 Key password 输入框（用户反馈：支持多 Key 后它没存在意义）；
  //    一个 textarea 吃下所有 Key（第 1 行 = 主 Key），配 👁 明文开关；统一 Key 也有 👁。
  assert.ok(!/id="eKey"/.test(html), '旧的单 Key 输入框 #eKey 应已移除（合一到 #eKeys）');
  assert.ok(/<textarea id="eKeys"[^>]*class="keys masked"/.test(html), 'API Key 应是掩码 textarea（每行一把）');
  assert.ok(/id="eKeysEye"/.test(html), 'API Key 应有明文开关按钮');
  assert.ok(/id="gwApiKeyEye"/.test(html), '统一 Key 也应有明文开关');
  assert.ok(!/id="eKeyEye"/.test(html), '旧 #eKeyEye 绑定应已移除');
  assert.ok(/-webkit-text-security:\s*disc/.test(html), 'textarea 掩码样式必须存在');
  assert.ok(/bindEyeToggle\('eKeysEye', 'eKeys'\)/.test(html), '明文开关必须绑定到 API Key 框');
  // textarea 必须吃暗色样式（用户截图反馈：此前渲染成系统白底）
  assert.ok(/\.row input\[type=text\],\s*\.row textarea\s*\{/.test(html), '.row textarea 必须与 text 输入共用暗色样式');

  // ② 序列化语义：每行一把、原顺序保留；≥2 把写 apiKeys，1 把删除该字段（真跑页面函数）
  const grab = (name) => {
    const start = html.indexOf('function ' + name + '(');
    assert.ok(start >= 0, '未找到函数 ' + name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
    }
    throw new Error('未闭合：' + name);
  };
  const vm = require('vm');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab('gwMergeKeys') + '\n' + grab('gwKeysText')
    + '\n__m = gwMergeKeys; __t = gwKeysText;', ctx);
  const J = (v) => JSON.stringify(v);
  assert.strictEqual(J(ctx.__m('sk-1\nsk-2\nsk-3')), J(['sk-1', 'sk-2', 'sk-3']), '每行一把，原顺序保留');
  assert.strictEqual(J(ctx.__m('sk-1,sk-2 ; sk-3')), J(['sk-1', 'sk-2', 'sk-3']), '逗号/分号/空白分隔');
  assert.strictEqual(J(ctx.__m('sk-1\nsk-1\nsk-2')), J(['sk-1', 'sk-2']), '重复 Key 去重');
  assert.strictEqual(J(ctx.__m('\n\n')), J([]), '全空 → 空数组（清空 apiKey）');
  // 回填：主 Key 永远第 1 行（即便 apiKeys 里顺序不同），其余按 apiKeys 顺序
  assert.strictEqual(ctx.__t({ apiKey: 'sk-1', apiKeys: ['sk-1', 'sk-2', 'sk-3'] }), 'sk-1\nsk-2\nsk-3', '回填：主 Key 第 1 行');
  assert.strictEqual(ctx.__t({ apiKey: 'sk-1', apiKeys: ['sk-2', 'sk-1'] }), 'sk-1\nsk-2', '回填：主 Key 提前且去重');
  assert.strictEqual(ctx.__t({ apiKey: 'sk-only' }), 'sk-only', '回填：只有主 Key');
  assert.strictEqual(ctx.__t({}), '', '回填：无 Key → 空串');
  assert.ok(/if \(all\.length > 1\) p\.apiKeys = all; else delete p\.apiKeys;/.test(html),
    'gwApplyEditor：≥2 把写 apiKeys，1 把清除该字段');
  assert.ok(/const all = gwMergeKeys\(\$\('eKeys'\)\.value\)/.test(html),
    'gwApplyEditor 必须从合一框读取全部 Key');
  assert.ok(/\$\('eKeys'\)\.value = gwKeysText\(p\)/.test(html), 'gwOpenEditor 必须用 gwKeysText 回填');
  assert.ok(/多 Key ' \+ p\.apiKeys\.length/.test(html), '高级摘要应显示多 Key 数量');
});

t('renderer：供应商编辑不丢高级字段（protocol/auth/accounts），并在界面显示摘要', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
  // ① 就地修改已有对象 —— 否则保存后 protocol/auth/accounts/quirks/headers 会被静默抹掉
  assert.ok(/const p = gwCfg\.providers\[gwSel\] \|\| \(gwCfg\.providers\[gwSel\] = \{\}\)/.test(html),
    'gwApplyEditor 必须就地修改已有供应商对象（不能整体替换，否则丢高级字段）');
  const applySeg = html.slice(html.indexOf('function gwApplyEditor()'), html.indexOf('function gwApplyEditor()') + 1400);
  // 唯一允许删的是编辑器**自己拥有**的 apiKeys（多 Key 降到 1 把时必须清掉，否则旧 Key 会残留继续轮换）；
  // protocol/auth/accounts/quirks/headers 等高级字段一律不得删（历史事故：保存后被静默抹掉）。
  assert.ok(!/delete p\.(?!apiKeys\b)/.test(applySeg), 'gwApplyEditor 不得删除供应商的其它字段：\n' + applySeg);
  assert.ok(/if \(all\.length > 1\) p\.apiKeys = all; else delete p\.apiKeys;/.test(applySeg),
    '多 Key 序列化：≥2 把写 apiKeys，1 把时清空该字段');
  // ② 高级能力摘要必须在编辑器里可见（否则用户困惑"为什么不走我的 Key / 为什么有账户池"）
  assert.ok(/id="gwAdv"/.test(html), '编辑器应有 #gwAdv 高级摘要容器');
  for (const kw of ['协议=', '凭据=', '账户池 ', 'quirks=', '自定义头 ']) {
    assert.ok(html.includes(kw), '高级摘要应包含 ' + kw);
  }
  // ③ 无高级字段的普通供应商不应显示该行（避免噪声）
  assert.ok(/\$\('gwAdv'\)\.style\.display = adv\.length \? '' : 'none'/.test(html),
    '无高级字段时应隐藏摘要行');
});

t('renderer：配置页的模型映射表读写与网关语义一致（真跑页面函数）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
  // 结构：旧的一行式 models 输入已替换为映射表
  assert.ok(/id="eModelRows"/.test(html), '应有映射表容器 #eModelRows');
  assert.ok(/id="btnModelAddRow"/.test(html), '应有「添加一行」按钮');
  assert.ok(/id="eModelPaste"/.test(html), '应有批量粘贴输入框');
  assert.ok(!/id="eModels"/.test(html), '旧的一行式模型输入应已移除');
  assert.ok(/gwFillModelRows\(p\.models\)/.test(html), 'gwOpenEditor 应把 models 填进映射表');
  assert.ok(/gwSerializeModels\(gwReadModelRows\(\)\)/.test(html), 'gwApplyEditor 应从映射表写回 models');

  // 行为：抽出页面里的三个纯函数，在 vm 里跑（读入/写出/批量解析）
  const grab = (name) => {
    const start = html.indexOf('function ' + name + '(');
    assert.ok(start >= 0, '应能定位 ' + name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
    }
    throw new Error('未闭合：' + name);
  };
  const vm = require('vm');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab('gwFirstStr') + '\n' + grab('gwNormalizeModels') + '\n'
    + grab('gwSerializeModels') + '\n' + grab('gwParseModelPaste')
    + '\n__n = gwNormalizeModels; __s = gwSerializeModels; __p = gwParseModelPaste;', ctx);
  const J = (v) => JSON.stringify(v);

  // 读入：字符串 + 映射对象
  assert.strictEqual(J(ctx.__n(['glm-5.3', { id: 'a/b', as: 'c' }])),
    J([{ up: 'glm-5.3', as: 'glm-5.3' }, { up: 'a/b', as: 'c' }]), '读入：字符串与映射对象');
  assert.strictEqual(J(ctx.__n([{ model: 'x', as: 'y' }])), J([{ up: 'x', as: 'y' }]), '读入：仅 model+as（与网关一致）');
  assert.strictEqual(J(ctx.__n([null, 1, '', { as: 'no-id' }, {}])), '[]', '读入：脏数据跳过且不抛错');
  // 写出：同名写字符串、异名写对象、空 up 丢弃
  assert.strictEqual(J(ctx.__s([{ up: 'x', as: 'x' }, { up: 'a/b', as: 'c' }, { up: '', as: 'z' }])),
    J(['x', { id: 'a/b', as: 'c' }]), '写出：同名压缩为字符串、异名写 {id,as}、空 up 丢弃');
  // 往返：读入 → 写出 保持原形态
  assert.strictEqual(J(ctx.__s(ctx.__n(['x', { id: 'a/b', as: 'c' }]))), J(['x', { id: 'a/b', as: 'c' }]),
    '往返幂等');
  // 2026-09-16 实测踩到：旧版写出只保留 vision，配置页保存一次就把 contextWindow/maxTokens 抹掉
  //（dsh 于是退回 1M 默认上下文 → 长对话在上游超限）
  assert.strictEqual(J(ctx.__s([{ up: 'hy3', as: 'hy3', vision: true, contextWindow: 192000, maxTokens: 64000 }])),
    J([{ id: 'hy3', as: 'hy3', vision: true, contextWindow: 192000, maxTokens: 64000 }]),
    '上限字段必须随行写出');
  assert.strictEqual(J(ctx.__s([{ up: 'm', as: 'm', contextWindow: 512000 }])),
    J([{ id: 'm', as: 'm', contextWindow: 512000 }]), '仅上限（无 vision）也写对象形态');
  assert.strictEqual(J(ctx.__n([{ id: 'hy3', vision: true, contextWindow: 192000, maxTokens: 64000 }])),
    J([{ up: 'hy3', as: 'hy3', vision: true, contextWindow: 192000, maxTokens: 64000 }]), '读入带回上限字段');
  assert.strictEqual(J(ctx.__s(ctx.__n([{ id: 'hy3', vision: true, contextWindow: 192000, maxTokens: 64000 }]))),
    J([{ id: 'hy3', as: 'hy3', vision: true, contextWindow: 192000, maxTokens: 64000 }]), '读入→写出 往返保持上限');
  assert.strictEqual(J(ctx.__n([{ id: 'x', maxOutputTokens: 32000 }])), J([{ up: 'x', as: 'x', maxTokens: 32000 }]),
    'maxOutputTokens 同义键（与网关 modelEntries 一致）');
  // 批量解析：支持 => / -> / =，跳过空行与注释
  assert.strictEqual(J(ctx.__p('a=>b\nc -> d\n# 注释\n\ne=f\ng')),
    J([{ up: 'a', as: 'b' }, { up: 'c', as: 'd' }, { up: 'e', as: 'f' }, { up: 'g', as: '' }]),
    '批量粘贴解析');
});

// ================= 9. 2026-09-11：OpenAI Responses 协议（体翻译 + response.id 嗅探） =================

t('网关：Responses 体翻译（打码 / developer→system / reasoning.effort）与 response.id 嗅探', () => {
  const src = fs.readFileSync(path.join(SRC, 'gateway', 'model-gateway.mjs'), 'utf8');
  const grab = (name) => {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, '应能定位 ' + name);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('未闭合：' + name);
  };
  const grabConst = (name) => {
    const m = new RegExp('^const ' + name + ' = .*;$', 'm').exec(src);
    assert.ok(m, '应能定位常量 ' + name);
    return m[0];
  };
  const vm = require('vm');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([
    grab('maskSecretTokens'),
    grab('desensitizeLongTokens'),
    grab('translateResponsesBody'),
    grab('maskResponsesItems'),
    grab('desensitizeResponsesBody'),
    grabConst('RESP_ID_RE'),
    grabConst('RESP_NESTED_ID_RE'),
    grabConst('RESP_OBJECT_ID_RE'),
    grab('sniffResponseId'),
    '__t = translateResponsesBody; __d = desensitizeResponsesBody; __s = sniffResponseId;',
  ].join('\n'), ctx);
  const J = (v) => JSON.stringify(v);
  const hex40 = 'a1b2c3d4'.repeat(5);
  const skKey = 'sk-' + 'A1b2C3d4E5f6G7h8'.repeat(2);

  // —— response.id 嗅探：三种形态认得，output item 的 id 不认 ——
  assert.strictEqual(ctx.__s('{"id":"resp_ab12","object":"response"}'), 'resp_ab12', '① resp_ 前缀');
  assert.strictEqual(ctx.__s('data: {"type":"response.created","response":{"id":"resp-9x"}}'), 'resp-9x', '② SSE response.created');
  assert.strictEqual(ctx.__s('{"id":"legacyid1","object":"response","status":"completed"}'), 'legacyid1', '③ object:response');
  assert.strictEqual(ctx.__s('{"type":"response.output_item.added","item":{"id":"msg_123456"}}'), null,
    '不得把 output item 的 msg_ id 当成 response id');
  assert.strictEqual(ctx.__s('{"id":"chatcmpl-1","object":"chat.completion"}'), null, 'chat 完成体不认');
  assert.strictEqual(ctx.__s(''), null);
  assert.strictEqual(ctx.__s(null), null);

  // —— 体翻译：打码 + role + reasoning ——
  const body = {
    model: 'm',
    instructions: 'sys ' + hex40,
    input: [
      { type: 'message', role: 'developer', content: 'dev text ' + hex40 },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'key ' + skKey }] },
      { type: 'function_call_output', call_id: 'c1', output: 'out ' + hex40 },
    ],
    reasoning: { effort: 'max' },
  };
  const snapshot = J(body);
  const out = ctx.__t(body, { reasoningEffortMap: { max: 'xhigh', off: 'disabled' } });
  assert.strictEqual(out.instructions, 'sys [sha256:40]', 'instructions 应打码：' + out.instructions);
  assert.strictEqual(out.input[0].role, 'system', 'developer → system：' + J(out.input[0]));
  assert.strictEqual(out.input[1].content[0].text, 'key sk-***G7h8', 'input_text 应打码：' + J(out.input[1]));
  assert.strictEqual(out.input[2].output, 'out [sha256:40]', 'function_call_output 应打码：' + out.input[2].output);
  assert.strictEqual(out.reasoning.effort, 'xhigh', 'reasoning.effort 按 reasoningEffortMap 改写');
  assert.strictEqual(J(body), snapshot, '翻译必须返回新对象，不得就地改动原请求体（failover 会重发原体）');
  // off 档位：Responses 无"关闭"枚举 → 移除 reasoning 字段
  assert.ok(!('reasoning' in ctx.__t({ reasoning: { effort: 'off' } }, { reasoningEffortMap: { off: 'disabled' } })),
    'off → 移除 reasoning');
  assert.ok(!('reasoning' in ctx.__t({ reasoning: { effort: 'high' } }, { reasoningEffortMap: { high: { thinking: 'disabled' } } })),
    '对象映射 thinking:disabled → 移除 reasoning');
  assert.strictEqual(ctx.__t({ reasoning: { effort: 'low' } }, { reasoningEffortMap: { low: { effort: 'medium' } } }).reasoning.effort,
    'medium', '对象映射 effort 值应被采用');
  const keep = { reasoning: { effort: 'high' } };
  assert.strictEqual(ctx.__t(keep, {}), keep, '无 reasoningEffortMap → 原样返回（不复制、不加戏）');
  assert.strictEqual(ctx.__t({ input: 'plain', instructions: 'plain' }, {}).input, 'plain', '无密钥/无映射时保持原值');

  // —— 降敏重试（R9c 的 Responses 版）——
  const de = ctx.__d({ instructions: hex40, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: hex40 }] }] });
  assert.strictEqual(de.instructions, '[sha256:40]');
  assert.strictEqual(de.input[0].content[0].text, '[sha256:40]', '降敏应作用于 input 文本块：' + J(de.input));
  assert.strictEqual(ctx.__d({ input: [{ type: 'function_call', arguments: '{"a":1}' }] }).input[0].arguments, '{"a":1}',
    '工具调用 arguments 不得被降敏（会破坏 JSON）');
});

// ================= 9. 2026-09-11：可移植性（复制到其它电脑开箱即用）=================
// 真实故障：out\DSH-App 整体复制到另一台电脑后双击只弹空白窗口，日志停在
//   [启动进程失败: spawn C:\WINDOWS\system32\cmd.exe ENOENT]
// 两个根因：① cmd 路径取自 process.env.ComSpec（克隆机残留旧系统盘路径）；
//          ② spawn 的 ENOENT 是**异步** error，外层 try/catch 抓不到 → "回退直接启动"是死代码。

t('可移植性：cmd.exe 解析不认坏掉的 ComSpec；workDir 不存在时回退主目录', () => {
  const { resolveCmdExe, comSpecIsStale } = require(path.join(SRC, 'winutil.js'));
  const { workDirOrHome, dirUsable } = require(path.join(SRC, 'paths.js'));
  const saved = process.env.ComSpec;
  try {
    process.env.ComSpec = 'C:\\no\\such\\dir\\cmd.exe';
    const r = resolveCmdExe();
    assert.notStrictEqual(String(r).toLowerCase(), 'c:\\no\\such\\dir\\cmd.exe',
      'ComSpec 指向不存在的文件时不得原样使用（克隆机的典型故障）：' + r);
    assert.ok(r === 'cmd.exe' || fs.existsSync(r), '应回退到真实存在的 cmd 或 PATH 兜底：' + r);
    assert.strictEqual(comSpecIsStale(), true, '应能识别出坏掉的 ComSpec（用于日志提示）');
    const real = 'C:\\Windows\\system32\\cmd.exe';
    if (fs.existsSync(real)) {
      process.env.ComSpec = real;
      assert.strictEqual(resolveCmdExe().toLowerCase(), real.toLowerCase(), 'ComSpec 有效时应优先使用');
      assert.strictEqual(comSpecIsStale(), false, '有效的 ComSpec 不得被误判为失效');
    }
  } finally {
    if (saved === undefined) delete process.env.ComSpec; else process.env.ComSpec = saved;
  }
  // workDir：来自另一台电脑的绝对路径必须回退
  assert.strictEqual(workDirOrHome('C:\\definitely\\not\\here\\at\\all'), os.homedir(), '无效 workDir 应回退主目录');
  assert.strictEqual(workDirOrHome(tmpRoot), tmpRoot, '有效目录应原样返回');
  assert.strictEqual(dirUsable(tmpRoot), true);
  assert.strictEqual(dirUsable('C:\\nope-not-here'), false);
  let seen = null;
  workDirOrHome('C:\\nope-not-here', (bad) => { seen = bad; });
  assert.strictEqual(seen, 'C:\\nope-not-here', '回退时应回调（供写日志）');
});

t('可移植性：settings.json 里旧机器的 workDir → load 时回退并落盘（否则 spawn cwd 无效）', () => {
  const { Settings } = require(path.join(SRC, 'settings.js'));
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'stale-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ port: 3080, workDir: 'C:\\Users\\someone-else' }), 'utf8');
  const d = new Settings(dir).load();
  assert.strictEqual(d.workDir, os.homedir(), '不存在的 workDir 应回退主目录：' + d.workDir);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.strictEqual(onDisk.workDir, os.homedir(), '应落盘修正（避免每次启动重复判定）');
  // 有效目录不得被改写
  const dir2 = fs.mkdtempSync(path.join(tmpRoot, 'keep-'));
  fs.writeFileSync(path.join(dir2, 'settings.json'), JSON.stringify({ workDir: dir2 }), 'utf8');
  assert.strictEqual(new Settings(dir2).load().workDir, dir2, '有效 workDir 必须原样保留');
});

t('可移植性：cmd broker 异步 ENOENT → 自动回退直接启动 dsh（旧版卡在空白窗口）', async () => {
  const { L, dir } = mkLauncher();
  // broker 脚本写到数据目录：portablePrefix() 认 DSH_DATA_DIR（真实运行时=应用目录\data）
  const savedDataDir = process.env.DSH_DATA_DIR;
  process.env.DSH_DATA_DIR = dir;
  L.nodeInfo = { exe: 'node', env: {}, embedded: true };   // 内嵌模式才走 cmd broker 分支
  L.nodePath = 'node';
  L.found = { dir: tmpRoot, version: '9.9.9', bin: path.join(tmpRoot, 'bin.js') };
  const before = spawnCalls.length;
  cmdSpawnFails = true;
  try {
    L.start();
    const first = spawnCalls[before];
    assert.ok(first && /cmd/i.test(first.cmd), '应先尝试 cmd broker：' + (first && first.cmd));
    await new Promise((r) => setTimeout(r, 50));           // 等异步 error 传播
    const added = spawnCalls.slice(before);
    assert.strictEqual(added.length, 2, 'broker 失败后必须再启动一次（直接 spawn node）：'
      + JSON.stringify(added.map((c) => c.cmd)));
    assert.ok(!/cmd/i.test(added[1].cmd), '第二次必须是直接启动 node（不经 cmd）：' + added[1].cmd);
    assert.strictEqual(L.running, true, '回退成功后应处于 running（旧版会停在失败态）');
    assert.ok(L.proc && L.proc.__cmd === added[1].cmd, 'this.proc 应指向回退后的子进程');
  } finally {
    cmdSpawnFails = false;
    if (savedDataDir === undefined) delete process.env.DSH_DATA_DIR; else process.env.DSH_DATA_DIR = savedDataDir;
    await L.stop();
  }
});

t('可移植性：源码不得再直接使用 process.env.ComSpec 启动 cmd', () => {
  for (const f of ['launcher.js', 'market.js']) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/spawn\(\s*process\.env\.ComSpec/.test(src),
      f + ' 不得直接用 process.env.ComSpec（克隆机上可能指向不存在的路径）');
    assert.ok(/resolveCmdExe\(\)/.test(src), f + ' 应经 resolveCmdExe() 解析 cmd.exe');
  }
  assert.ok(/cmd broker 启动失败/.test(fs.readFileSync(path.join(SRC, 'launcher.js'), 'utf8')),
    'launcher 必须有 broker 异步失败的显式回退');
});

// ================= 10. 2026-09-11：日志时间口径（缺省北京时间）=================

t('日志时间戳：缺省北京时间（与机器时区无关），DSH_LOG_TZ 可覆盖', () => {
  const tsPath = require.resolve(path.join(SRC, 'timestamp.js'));
  const fresh = (env) => {
    delete require.cache[tsPath];
    if (env === undefined) delete process.env.DSH_LOG_TZ; else process.env.DSH_LOG_TZ = env;
    return require(tsPath);
  };
  // 把时间戳字符串当作"钟面"解析成毫秒，再与期望的墙钟比较（容忍 1 分钟跨秒）
  const wall = (s) => new Date(s.replace(' ', 'T') + 'Z').getTime();
  const near = (s, expectMs, label) => {
    const d = Math.abs(wall(s) - expectMs);
    assert.ok(d <= 60000, label + '：实际 ' + s + '（偏差 ' + Math.round(d / 1000) + 's）');
  };
  try {
    near(fresh(undefined).stamp(), Date.now() + 480 * 60000, '缺省应为北京时间 UTC+8');
    assert.strictEqual(fresh(undefined).tzLabel(), 'UTC+08:00 (Asia/Shanghai)', '应能说明当前口径');
    near(fresh('local').stamp(), Date.now() - new Date().getTimezoneOffset() * 60000, 'DSH_LOG_TZ=local 应跟随系统时区');
    near(fresh('+09:00').stamp(), Date.now() + 540 * 60000, '+09:00 应生效');
    near(fresh('-05:30').stamp(), Date.now() - 330 * 60000, '-05:30 应生效');
    near(fresh('+0530').stamp(), Date.now() + 330 * 60000, '+0530（无冒号）应生效');
    assert.strictEqual(fresh('乱填的值').tzOffsetMin(), 480, '非法取值应回退北京时间');
    // 毫秒格式（网关日志）
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(fresh(undefined).stampMs()), 'stampMs 应带毫秒');
  } finally {
    delete process.env.DSH_LOG_TZ;
    delete require.cache[tsPath];
  }
  // 网关（零依赖单文件）必须同一口径：抽出真实函数在 vm 里跑
  const mjs = fs.readFileSync(path.join(SRC, 'gateway', 'model-gateway.mjs'), 'utf8');
  const grab = (name) => {
    const start = mjs.indexOf('function ' + name + '(');
    assert.ok(start >= 0, '应能定位 ' + name);
    let depth = 0;
    for (let i = mjs.indexOf('{', start); i < mjs.length; i++) {
      if (mjs[i] === '{') depth++;
      else if (mjs[i] === '}') { depth--; if (depth === 0) return mjs.slice(start, i + 1); }
    }
    throw new Error('未闭合：' + name);
  };
  const vm = require('vm');
  const ctx = { process: { env: {} } };
  vm.createContext(ctx);
  vm.runInContext(grab('logTzOffsetMin') + '\nconst LOG_TZ_MIN = logTzOffsetMin();\n' + grab('localStamp')
    + '\n__s = localStamp; __tz = LOG_TZ_MIN;', ctx);
  assert.strictEqual(ctx.__tz, 480, '网关缺省应为 UTC+8（旧版跟随系统时区 → 在 UTC 机器上差 8 小时）');
  near(ctx.__s(), Date.now() + 480 * 60000, '网关时间戳应为北京时间');
  ctx.process.env.DSH_LOG_TZ = 'local';
  vm.runInContext('__tz2 = logTzOffsetMin();', ctx);
  assert.strictEqual(ctx.__tz2, null, '网关 DSH_LOG_TZ=local 应跟随系统时区');
});

// ================= 11. 2026-09-11：插件迁移快照（复制目录到新电脑自动装回插件）=================

t('插件快照：采集只收"用户自己装的插件"（排除宿主/默认插件），并随包复制插件目录', () => {
  const ps = require(path.join(SRC, 'plugin-snapshot.js'));
  const home = fs.mkdtempSync(path.join(tmpRoot, 'snap-home-'));
  const prof = path.join(home, 'profiles', 'web');
  fs.mkdirSync(path.join(prof, 'node_modules', 'dsh-web-search-free'), { recursive: true });
  fs.mkdirSync(path.join(prof, 'node_modules', 'dsh-email-bridge'), { recursive: true });
  fs.writeFileSync(path.join(prof, 'node_modules', 'dsh-web-search-free', 'package.json'), '{"name":"dsh-web-search-free","version":"1.3.0"}');
  fs.writeFileSync(path.join(prof, 'node_modules', 'dsh-web-search-free', 'index.js'), '// x');
  fs.writeFileSync(path.join(prof, 'node_modules', 'dsh-email-bridge', 'package.json'), '{"name":"dsh-email-bridge","version":"0.1.0"}');
  fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-web-search-free'], patchReload: 'live' } },
    dependencies: { 'dsh-web-search-free': '^1.3.0', 'dsh-email-bridge': 'file:vendor/dsh-email-bridge', '@deepseek-ai/schemastery': '^3.0.0' },
  }, null, 2));
  fs.writeFileSync(path.join(prof, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: email',
    '      name: dsh-email-bridge',
    '      config:',
    "        smtp: { user: 'me@example.com' }",
    '',
    '- id: web-search-deepseek',
    '  disabled: true',
    '',
  ].join('\n'));
  // dsh 自身配置（在 ~/.dsh 根下，不在 profile 里）
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    gateway:\n      baseURL: http://127.0.0.1:3091\n');
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# 全局指令\n');
  fs.writeFileSync(path.join(home, 'pet.json'), '{"pet":"cat"}\n');
  fs.mkdirSync(path.join(home, '.agent-presets'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent-presets', 'a.json'), '{"x":1}\n');

  const dataDir = fs.mkdtempSync(path.join(tmpRoot, 'snap-data-'));
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const r = ps.capture({ dataDir, profile: 'web' });
    assert.strictEqual(r.ok, true, '采集应成功：' + r.message);
    const snap = JSON.parse(fs.readFileSync(ps.snapshotPath(dataDir), 'utf8'));
    assert.deepStrictEqual(snap.plugins.map((p) => p.name), ['dsh-web-search-free'],
      '只采集用户自己装的注册表插件（排除 file: 的默认插件与 @deepseek-ai 宿主包）');
    assert.strictEqual(snap.plugins[0].bundled, true, '插件目录应随包复制（离线可装）');
    assert.ok(fs.existsSync(path.join(ps.bundleDirFor(dataDir, 'dsh-web-search-free'), 'package.json')), '随包目录应含插件包');
    assert.ok(fs.existsSync(path.join(ps.bundleDirFor(dataDir, 'dsh-web-search-free'), 'index.js')), '随包目录应含插件文件');
    assert.deepStrictEqual(snap.bundles, ['dsh-web-search-free'], 'bundle 挂载只收非宿主条目');
    assert.strictEqual(snap.patchEntries.length, 2,
      '应全量采集顶层 patch 条目（间接配置如 web-search-deepseek 禁用条目不能被漏掉）');
    assert.ok(snap.patchEntries.some((b) => /web-search-deepseek/.test(b)), '间接配置条目应在快照里');
    assert.ok(snap.capturedAtLocal && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(snap.capturedAtLocal),
      '应带人类可读的北京时间戳：' + snap.capturedAtLocal);
    // dsh 自身配置（模型路由/凭据/全局指令）也应随目录走——否则新机器上 dsh 不认识任何模型
    assert.ok(snap.dshConfig.files.includes('settings.yaml') && snap.dshConfig.files.includes('.credentials.yaml'),
      'dsh 配置应纳入快照：' + JSON.stringify(snap.dshConfig));
    assert.ok(fs.existsSync(path.join(ps.dshConfigRoot(dataDir), 'settings.yaml')), '配置副本应写入数据目录');
    assert.ok(snap.dshConfig.dirs.includes('.agent-presets'), '小体积配置目录也应随包');

    // 卸载后的插件不应继续随包（清理陈旧随包目录）
    fs.rmSync(path.join(prof, 'node_modules', 'dsh-web-search-free'), { recursive: true, force: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8'));
    delete pkg.dependencies['dsh-web-search-free'];
    fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify(pkg, null, 2));
    ps.capture({ dataDir, profile: 'web' });
    assert.ok(!fs.existsSync(ps.bundleDirFor(dataDir, 'dsh-web-search-free')),
      '已卸载插件的陈旧随包目录应被清理');
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
  }
});

t('插件快照：新机器首次启动装回插件 + 补挂 bundle + 用真配置替换同 id 占位（幂等、备份、换机重装）', async () => {
  const ps = require(path.join(SRC, 'plugin-snapshot.js'));
  const home = fs.mkdtempSync(path.join(tmpRoot, 'snap2-home-'));
  const srcProf = path.join(home, 'profiles', 'web');
  fs.mkdirSync(path.join(srcProf, 'node_modules', 'dsh-web-search-free'), { recursive: true });
  fs.writeFileSync(path.join(srcProf, 'node_modules', 'dsh-web-search-free', 'package.json'), '{"name":"dsh-web-search-free","version":"1.3.0"}');
  fs.writeFileSync(path.join(srcProf, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-web-search-free'], patchReload: 'live' } },
    dependencies: { 'dsh-web-search-free': '^1.3.0' },
  }, null, 2));
  fs.writeFileSync(path.join(srcProf, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: email',
    '      name: dsh-email-bridge',
    '      config:',
    "        smtp: { user: 'real@example.com', password: 'secret' }",
    '',
  ].join('\n'));

  const dataDir = fs.mkdtempSync(path.join(tmpRoot, 'snap2-data-'));
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    fs.writeFileSync(path.join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    gateway: {}\n');
    fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrecords: {}\n');
    ps.capture({ dataDir, profile: 'web' });

    // 换到"新机器"的家目录（~/.dsh 是空的，只有 dsh 刚建的 profile）
    // 且「默认插件」机制已先写入一份占位邮箱配置（真实启动顺序）
    const newHome = fs.mkdtempSync(path.join(tmpRoot, 'snap2-newhome-'));
    process.env.DSH_HOME = newHome;
    fs.writeFileSync(path.join(newHome, 'pet.json'), '{"pet":"my-own"}\n');   // 目标机自己的个性化配置
    const prof = path.join(newHome, 'profiles', 'fresh');
    fs.mkdirSync(prof, { recursive: true });
    const writePkg = (p, obj) => fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify(obj, null, 2));
    writePkg(prof, { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } }, dependencies: {} });
    fs.writeFileSync(path.join(prof, 'cordis.patch.yml'), [
      '- insert:', '    - id: email', '      name: dsh-email-bridge', '      config:', '        imap: { host: "" }', '',
    ].join('\n'));

    const calls = [];
    const marketOps = {
      install: async (spec) => {
        calls.push(spec);
        // 必须是**相对**规格 file:vendor/<name>（绝对路径带盘符会被 MarketOps 白名单拒掉）
        if (!String(spec).startsWith('file:vendor/')) return { ok: false, error: '应优先用随包本地目录的相对规格' };
        const name = String(spec).slice('file:vendor/'.length);
        const vendorSrc = path.join(prof, 'vendor', name);
        if (!fs.existsSync(path.join(vendorSrc, 'package.json'))) return { ok: false, error: 'profile\\vendor 副本缺失' };
        const dst = path.join(prof, 'node_modules', name);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(vendorSrc, dst, { recursive: true });
        const pkg = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8'));
        pkg.dependencies[name] = '^1.3.0';
        writePkg(prof, pkg);
        return { ok: true };
      },
    };

    const a = await ps.applyIfNeeded({ dataDir, profile: 'fresh', marketOps });
    assert.strictEqual(a.action, 'applied', '首次在新机器上应执行安装：' + a.message);
    assert.deepStrictEqual(a.installed, ['dsh-web-search-free']);
    assert.ok(calls.length === 1 && calls[0] === 'file:vendor/dsh-web-search-free',
      '应优先用随目录带过来的本地包（相对规格）：' + JSON.stringify(calls));
    assert.ok(fs.existsSync(path.join(prof, 'vendor', 'dsh-web-search-free', 'package.json')),
      '插件源码应常驻 profile\\vendor（pnpm 之后可自愈重装）');
    const after = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8'));
    assert.deepStrictEqual(after.dependencies, { 'dsh-web-search-free': '^1.3.0' }, '插件依赖应写进 profile');
    assert.ok(after.dsh.profile.bundles.includes('dsh-web-search-free'), '应补挂 bundle：' + JSON.stringify(after.dsh.profile.bundles));
    // dsh 自身配置：目标机缺失的补齐、已有的不动
    assert.strictEqual(fs.readFileSync(path.join(newHome, 'settings.yaml'), 'utf8'), 'llm-pi-ai:\n  providers:\n    gateway: {}\n',
      '新机器缺失的 settings.yaml（模型路由）应被恢复');
    assert.ok(fs.existsSync(path.join(newHome, '.credentials.yaml')), '供应商密钥文件应被恢复');
    assert.strictEqual(fs.readFileSync(path.join(newHome, 'pet.json'), 'utf8'), '{"pet":"my-own"}\n',
      '目标机已有的配置文件不得被覆盖（尊重新机器自己的设置）');
    const patch = fs.readFileSync(path.join(prof, 'cordis.patch.yml'), 'utf8');
    assert.ok(/real@example\.com/.test(patch) && /secret/.test(patch), '应用户真配置覆盖本机占位条目：\n' + patch);
    assert.strictEqual((patch.match(/id:\s*email/g) || []).length, 1, '同 id 不得出现重复条目：\n' + patch);
    assert.ok(fs.readdirSync(prof).some((f) => f.includes('.bak-pluginsnapshot')), '改写 patch 前应留备份');

    // 幂等：同机再次启动不再安装、不再改写
    const b = await ps.applyIfNeeded({ dataDir, profile: 'fresh', marketOps });
    assert.strictEqual(b.action, 'ready', '同机第二次应直接 ready：' + b.message);
    assert.strictEqual(calls.length, 1, '不得重复安装');
    assert.strictEqual(fs.readFileSync(path.join(prof, 'cordis.patch.yml'), 'utf8'), patch, '不得重复改写 patch');

    // 用户在新机器上手工卸载后：不得被下次启动装回
    const off = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8'));
    delete off.dependencies['dsh-web-search-free'];
    writePkg(prof, off);
    fs.rmSync(path.join(prof, 'node_modules', 'dsh-web-search-free'), { recursive: true, force: true });
    await ps.applyIfNeeded({ dataDir, profile: 'fresh', marketOps });
    assert.strictEqual(calls.length, 1, '用户手工卸载后不得自动装回（尊重人工改动）');

    // 再换一台电脑（机器指纹变了）+ 全新 profile → 应再次装回
    const marker = JSON.parse(fs.readFileSync(ps.appliedPath(dataDir), 'utf8'));
    marker.machine = 'ANOTHER-PC|someone-else';
    fs.writeFileSync(ps.appliedPath(dataDir), JSON.stringify(marker));
    const prof2 = path.join(newHome, 'profiles', 'fresh2');
    fs.mkdirSync(prof2, { recursive: true });
    writePkg(prof2, { name: 'dsh-profile-web', private: true, dependencies: {} });
    const c = await ps.applyIfNeeded({ dataDir, profile: 'fresh2', marketOps });
    assert.strictEqual(c.action, 'applied', '换机器后应重新应用：' + c.message);
    assert.strictEqual(calls.length, 2, '换机器后应再次安装');
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
  }
});

t('插件快照：迁移后再采集仍认得"本地 vendor 安装"的插件（规格取自随包元数据，不被误删）', () => {
  const ps = require(path.join(SRC, 'plugin-snapshot.js'));
  const home = fs.mkdtempSync(path.join(tmpRoot, 'snap3-home-'));
  const prof = path.join(home, 'profiles', 'web');
  fs.mkdirSync(path.join(prof, 'node_modules', 'dsh-web-search-free'), { recursive: true });
  fs.writeFileSync(path.join(prof, 'node_modules', 'dsh-web-search-free', 'package.json'),
    '{"name":"dsh-web-search-free","version":"1.3.0","dependencies":{"@deepseek-ai/schemastery":"^3.18.1"}}');
  // 迁移后的形态：依赖规格是 file:vendor/<名>（本地安装），而不是注册表版本范围
  fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-web-search-free'], patchReload: 'live' } },
    dependencies: { 'dsh-web-search-free': 'file:vendor/dsh-web-search-free', 'dsh-email-bridge': 'file:vendor/dsh-email-bridge' },
  }, null, 2));
  const dataDir = fs.mkdtempSync(path.join(tmpRoot, 'snap3-data-'));
  // 模拟"上一跳"留下的随包目录 + 原始规格元数据
  const bundleDir = ps.bundleDirFor(dataDir, 'dsh-web-search-free');
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'package.json'), '{"name":"dsh-web-search-free","version":"1.3.0"}');
  fs.writeFileSync(path.join(bundleDir, 'dsh-app-bundle.json'), JSON.stringify({ name: 'dsh-web-search-free', spec: '^1.3.0' }));
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const r = ps.capture({ dataDir, profile: 'web' });
    assert.strictEqual(r.ok, true, r.message);
    const snap = JSON.parse(fs.readFileSync(ps.snapshotPath(dataDir), 'utf8'));
    assert.deepStrictEqual(snap.plugins.map((p) => p.name), ['dsh-web-search-free'],
      '本地 vendor 安装的插件必须仍在快照里（否则第二次复制就丢插件）：' + JSON.stringify(snap.plugins));
    assert.strictEqual(snap.plugins[0].spec, '^1.3.0', '原始注册表规格应从随包元数据恢复（供注册表回退）');
    assert.ok(fs.existsSync(path.join(bundleDir, 'package.json')), '随包目录不得被清理（曾因误判而删除）');
    // 元数据里没有 spec（老快照）也不能丢插件
    fs.rmSync(path.join(bundleDir, 'dsh-app-bundle.json'), { force: true });
    ps.capture({ dataDir, profile: 'web' });
    const snap2 = JSON.parse(fs.readFileSync(ps.snapshotPath(dataDir), 'utf8'));
    assert.deepStrictEqual(snap2.plugins.map((p) => p.name), ['dsh-web-search-free'], '无元数据时仍应识别为插件');
    assert.ok(fs.existsSync(bundleDir), '随包目录仍应保留');
    // 默认插件（邮箱桥接）依旧不纳入快照
    assert.ok(!snap2.plugins.some((p) => p.name === 'dsh-email-bridge'), '默认插件由独立机制负责，不重复纳入');
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
  }
});

// ================= 12. 2026-09-14：安全模式 --patch 参数顺序（真实事故）=================
// 事故：DSH-App 复制到新电脑后"启动失败，等待用户处理"且再也起不来。
// web.log: error: unknown option '--patch'
// 根因：`dsh web` 用 commander 的 passThroughOptions()——第一个不认识的 token 之后的所有参数
// 都交给"内层 app 解析器"。旧顺序 `web --no-open --port <n> --patch <safe.yml>` 把 --patch
// 放在了 --no-open 之后 → app 解析器不认识 → 启动必然失败（安全模式 = 永久死锁）。

t('launcher：安全模式的 --patch 必须排在 app 标志之前（否则 dsh 报 unknown option）', async () => {
  spawnCalls.length = 0;
  const { L, dir } = mkLauncher();
  const safe = path.join(dir, 'safe.yml');
  fs.writeFileSync(safe, '- id: web-search-deepseek\n  disabled: true\n');
  L.settings.data.safeMode = true;
  L.settings.safePatchPath = safe;
  L.nodeInfo = { exe: 'node', env: {}, embedded: false };
  L.nodePath = 'node';
  L.found = { dir: tmpRoot, version: '9.9.9', bin: path.join(tmpRoot, 'bin.js') };
  L.start();
  const call = spawnCalls[spawnCalls.length - 1];
  const a = call.args;
  const iPatch = a.indexOf('--patch');
  const iNoOpen = a.indexOf('--no-open');
  assert.ok(iPatch > 0 && iNoOpen > 0, '应同时带 --patch 与 --no-open：' + JSON.stringify(a));
  assert.ok(iPatch < iNoOpen, '--patch 必须在 --no-open 之前（dsh 的 passThroughOptions 会把后者之后的参数全当 app 参数）：' + JSON.stringify(a));
  assert.strictEqual(a[iPatch + 1], safe, '--patch 后应跟补丁文件路径：' + JSON.stringify(a));
  assert.strictEqual(a[a.indexOf('web') + 1], '--patch',
    '子命令 web 之后必须紧跟 --patch（dsh 的 launcher 标志要先于任何 app 标志）：' + JSON.stringify(a));
  await L.stop();
});

t('launcher：dsh 仍报 unknown option \'--patch\' 时 → 标记不支持并发出 patch-unsupported（只发一次）', async () => {
  const { L, dir } = mkLauncher();
  const safe = path.join(dir, 'safe.yml');
  fs.writeFileSync(safe, '- id: x\n  disabled: true\n');
  L.settings.data.safeMode = true;
  L.settings.safePatchPath = safe;
  L.nodeInfo = { exe: 'node', env: {}, embedded: false };
  L.nodePath = 'node';
  L.found = { dir: tmpRoot, version: '9.9.9', bin: path.join(tmpRoot, 'bin.js') };
  let fired = 0;
  L.on('patch-unsupported', () => { fired++; });
  L.start();
  const p = L.proc;
  assert.ok(p && p.stdout, '应有 stdout 桩');
  p.stdout.emit('data', Buffer.from("error: unknown option '--patch'\n"));
  assert.strictEqual(fired, 1, '应发出 patch-unsupported（main 据此退出安全模式重试）');
  assert.strictEqual(L.patchUnsupported, true, '应标记为不支持');
  p.stdout.emit('data', Buffer.from("error: unknown option '--patch'\n"));
  assert.strictEqual(fired, 1, '只应发一次（避免反复重启）');
  await L.stop();
});

t('main.js：收到 patch-unsupported 时自动退出安全模式（死锁逃生）', () => {
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.ok(/launcher\.on\('patch-unsupported'/.test(src), '应监听 patch-unsupported');
  assert.ok(/settings\.update\(\{ safeMode: false/.test(src), '应把 safeMode 置回 false 再重试');
  const wd = fs.readFileSync(path.join(SRC, 'watchdog.js'), 'utf8');
  assert.ok(/--patch|patch/.test(wd), '看门狗应仍能识别安全模式相关状态');
});

// ================= 13. 2026-09-15：配置页布局与供应商重排 =================

t('renderer：供应商 ▲▼ 只改先后顺序、不改优先级字段（2026-09-16 用户要求）；映射表含图片列', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings.html'), 'utf8');
  // ① 重排按钮 + 逻辑
  assert.ok(/id="btnGwUp"/.test(html) && /id="btnGwDown"/.test(html), '应有 ▲上移 / ▼下移 按钮');
  assert.ok(/gw-tools/.test(html), '应有列表工具条容器');
  assert.ok(/function gwMoveSel\(delta\)/.test(html), '应有 gwMoveSel 重排函数');
  assert.ok(/function gwSyncMoveButtons\(\)/.test(html), '应有按钮可用状态同步（首/尾禁用）');
  // ② 2026-09-16 用户要求：移动**不得**改写 priority（旧实现重编号 1…N，静默覆盖用户配置）
  assert.ok(!/arr\.forEach\(\(p, n\) => \{ p\.priority = n \+ 1; \}\)/.test(html),
    '重排不得再重编号 priority（移动只改先后顺序）');
  // 行内徽标（2026-09-17 改）：网关先按 priority 升序取候选、同 priority 内按列表顺序，
  // 所以必须**同时**显示 P<优先级> 与 #<列表位置>（旧版两者只显示其一，都会误导）
  assert.ok(/const ordText = 'P' \+ pri \+ ' #' \+ \(i \+ 1\)/.test(html),
    '行内应同时显示 P<优先级> 与 #<列表位置>');
  assert.ok(/const pri = \(Number\(p\.priority\) > 0 \? Number\(p\.priority\) : 1\)/.test(html),
    '优先级徽标应把缺省/非法视为 1（与网关 providerPriority 一致）');
  assert.ok(/优先级 P' \+ pri \+ '（数值小者先尝试）· 列表位置 #'/.test(html),
    '徽标 title 应说明两者的含义');
  assert.ok(/gwMoveSel\(-1\)/.test(html) && /gwMoveSel\(1\)/.test(html), '按钮应绑定 ±1 位移');
  // 文案必须与"priority 优先"的新规则一致（旧文案写"保留字段/不再参与排序"，会误导）
  assert.ok(/先按优先级（数字小者先试）· 同一优先级内按列表顺序/.test(html),
    '工具条提示应说明"先按优先级、同级按列表顺序"');
  assert.ok(!/保留字段（不再参与排序）/.test(html), '编辑器不应再写"保留字段/不再参与排序"');
  assert.ok(/数值小者先尝试；同一优先级内按左侧列表顺序/.test(html), '优先级字段旁应说明真实语义');
  // ③ 两栏比例：左 44% / 右 56%（旧版 1.15:1，右侧被挤窄）
  assert.ok(/\.gw-left \{ flex: 1 1 44%/.test(html) && /\.gw-right \{ flex: 1 1 56%/.test(html),
    '两栏应改为 44% : 56%（左侧收窄、右侧加宽）');
  // ④ 模型映射表：4 列（上游 ID 1.3fr / 映射为 1fr / 图片 52px / 操作 64px），表头同为 4 格
  assert.ok(/\.gw-map \.map-hd,[\s\S]{0,120}grid-template-columns: minmax\(0, 1\.3fr\) minmax\(0, 1fr\) 52px 64px;/.test(html),
    '映射表应为 1.3fr / 1fr / 52px / 64px 四列（图片能力列）');
  const hd = /<div class="map-hd">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(hd, '应能定位映射表表头');
  assert.strictEqual((hd[1].match(/<span/g) || []).length, 4,
    '表头必须与内容同为 4 列');
  assert.ok(!/wrap\.appendChild\(tail\)/.test(html), '映射行不应再挂多余的空 span');
  // ⑤ 图片能力：编辑行有复选框、读表回填、序列化保留 vision（否则勾选后保存丢失）
  assert.ok(/iVis\.type = 'checkbox'/.test(html) && /className = 'm-vision'/.test(html), '映射行应有图片复选框');
  assert.ok(/vision: !!\(vis && vis\.checked\)/.test(html), '读表应带上 vision');
  assert.ok(/if \(vision \|\| hasCtx \|\| hasMax\)/.test(html) && /if \(vision\) entry\.vision = true/.test(html),
    'vision/上限存在时必须写对象形态（字符串表达不了）');
  assert.ok(/const vision = m\.vision === true/.test(html), 'normalize 应识别 vision');
  // 上限字段：读入带回、行内 dataset 携带、写出保留（2026-09-16 数据丢失回归）
  assert.ok(/row\.contextWindow = ctxWin/.test(html) && /row\.maxTokens = maxTok/.test(html), 'normalize 应带回上限字段');
  assert.ok(/wrap\.dataset\.ctx/.test(html) && /wrap\.dataset\.max/.test(html), '行内应以 dataset 携带上限字段');
  assert.ok(/out\.contextWindow = Number\(row\.dataset\.ctx\)/.test(html), '读表应取回上限字段');
  assert.ok(/if \(hasCtx\) entry\.contextWindow = ctxWin/.test(html) && /if \(hasMax\) entry\.maxTokens = maxTok/.test(html),
    '写出必须保留上限字段（否则配置页保存一次即静默丢失）');
  // ⑥ 说明折叠、标签加宽（长标签不再折行）
  assert.ok(/class="gw-hint-more"/.test(html) && /<summary>说明：/.test(html), '长说明应折叠为可展开块');
  assert.ok(/\.row label \{ width: 165px;/.test(html), '行标签宽度应加到 165px（130px 时"启动应用时自动启动服务"折行）');
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
