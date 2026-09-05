// main.js — DSH App 主进程：装配 launcher/watchdog/window/tray/settings
//
// 架构（参考 anywhere-labs/dsh-desktop 的薄宿主思想，自行轻量实现）：
//   Electron 壳（窗口/托盘/设置/看门狗） + 进程外 `dsh web` 子进程（稳定契约调用）
//   好处：壳与 dsh 完全解耦（升级 dsh 不影响壳）；坏插件导致的服务故障由壳层安全模式兜底。
'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');
const path = require('path');
const os = require('os');

const { AppState } = require('./state');
const { Settings } = require('./settings');
const logger = require('./logger');
const { Launcher } = require('./launcher');
const { Watchdog } = require('./watchdog');
const { TrayController } = require('./tray');
const updater = require('./updater');
const { GatewayManager } = require('./gateway-manager');
const { resolveDataDir } = require('./datadir');

// 窗口/任务栏图标：与 DSH-App.exe 内嵌图标一致（从 electron.exe 官方资源提取的
// electron-icon.png，详见 scripts/extract-exe-icon.mjs；createFromPath 支持 asar 内读取）
const WINDOW_ICON = (() => {
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'electron-icon.png'));
    return img.isEmpty() ? undefined : img;
  } catch (_) {
    return undefined;
  }
})();

const IS_AUTOSTART = process.argv.includes('--autostart');

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let state = null;
let launcher = null;
let watchdog = null;
let settings = null;
let gateway = null;
let readyHandled = false;   // 每次启动的就绪处理幂等闸

// ---------------- 窗口 ----------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#10141b',
    title: 'DSH App',
    icon: WINDOW_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'status.html'));

  // 只允许加载 dsh web 的同源目标；外链一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    const allowed = 'http://127.0.0.1:' + state.port;
    if (!url.startsWith(allowed)) {
      e.preventDefault();
      if (url.startsWith('http')) shell.openExternal(url);
    }
  });

  mainWindow.on('close', (e) => {
    if (settings.data.minimizeToTray && !forceQuit) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    broadcast();
  });

  // 状态变更推送到页面
  state.on('changed', () => broadcast());

  // 窗口标题固定为「DSH」：内嵌 dsh web 页面会把自己的 <title>（会话标题 — DeepSeek
  // Harness）同步到窗口标题栏，这里接管并阻止，避免显示"DSH桌面版开发评估 — DeepSeek Harness"
  const appTitle = 'DSH';
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow.setTitle(appTitle);
  });
  mainWindow.on('ready-to-show', () => mainWindow.setTitle(appTitle));

  // 在 dsh web 页面注入壳级能力：悬浮入口 + 输入框上下键历史
  mainWindow.webContents.on('did-finish-load', () => {
    let url = '';
    try { url = mainWindow.webContents.getURL(); } catch (_) { /* 忽略 */ }
    // URL 形如 http://127.0.0.1:<port>/?token=...（indexOf 定位端口，不能用 ===0，
    // http:// 前缀使 indexOf 必不为 0）
    if (url.indexOf('127.0.0.1:' + state.port) >= 0) {
      mainWindow.setTitle(appTitle);
      mainWindow.webContents.executeJavaScript(FLOAT_BUTTONS_JS).catch(() => { /* 忽略 */ });
    }
  });
  // 输入框上下键历史：主进程 before-input-event 拦截（不依赖页面注入时机），
  // 历史保存在本会话（按端口+路径隔离），读写输入框经 executeJavaScript。
  wireInputHistory(mainWindow, () => state.port);
}

// 注入到 dsh web 页面的两个悬浮入口（右上角，透明风格；点击打开壳设置窗并定位到对应卡片）
const FLOAT_BUTTONS_JS = [
  '(function(){',
  'if (document.getElementById("__dshapp_float")) return;',
  'var d=document.createElement("div");d.id="__dshapp_float";',
  'd.style.cssText="position:fixed;top:10px;right:34px;z-index:2147483647;display:flex;gap:8px;";',
  'function mk(txt,act){var b=document.createElement("button");b.textContent=txt;',
  'b.style.cssText=\'border:1px solid rgba(120,140,170,.45);background:rgba(24,30,40,.62);color:#cdd6e4;border-radius:14px;padding:4px 12px;font:12px "Segoe UI","Microsoft YaHei UI",sans-serif;cursor:pointer;backdrop-filter:blur(4px);\';',
  'b.onmouseenter=function(){b.style.background="rgba(40,52,70,.82)";};',
  'b.onmouseleave=function(){b.style.background="rgba(24,30,40,.62)";};',
  'b.onclick=function(){try{if(window.dshApp&&window.dshApp.action)window.dshApp.action(act);}catch(e){}};',
  'return b;}',
  'd.appendChild(mk("⚙ 设置","open-settings"));',
  'd.appendChild(mk("🛡 模型网关","open-settings::gateway"));',
  'document.body.appendChild(d);',
  '})();',
].join('\n');

// —— 输入框上下键历史（主进程实现）——
//
// 原理：Electron 窗口级 before-input-event 在主进程拦截按键，**不依赖页面注入时机**，
// 对 dsh 的 Lexical contenteditable / textarea 统一生效。历史按会话（port+路径）存于
// 主进程内存（≤200 条）；读写输入框值经 executeJavaScript 调用页面内辅助函数：
//   window.__dshAppIhGet() -> { val, atTop }（当前值 + 光标是否在文首）
//   window.__dshAppIhSet(v)  -> 写回输入框（contenteditable 用 insertText 触发编辑器）
// 页面辅助函数由 did-finish-load 的注入提供；若注入未到，按键处理仍然安全跳过。
const IH_KEYS = Object.freeze(['ArrowUp', 'ArrowDown', 'Enter']);
const IH_MAX = 200;

// 页面内辅助函数（通过 executeJavaScript 注入到 dsh web 页面）
// 除 get/set 外，还维护一个"当前输入框状态缓存"（keyup/input/mouseup 时刷新），
// 供主进程 before-input-event **同步**决策（异步查询赶不上按键派发）。
const INPUT_HELPER_JS = [
  '(function(){',
  'if (window.__dshAppIhInstalled) return;',
  'window.__dshAppIhInstalled=true;',
  'window.__dshAppIhCache={val:"",atTop:true,tag:""};',
  // 查找输入框：聚焦元素 > dsh 会话输入框 > textarea
  'function el(){',
  '  var a=document.activeElement;',
  '  if(a&&a!==document.body&&isIn(a))return a;',
  '  var c=document.querySelector("[data-composer-input]");',
  '  if(c&&isIn(c))return c;',
  '  var t=document.querySelector("textarea");',
  '  if(t&&isIn(t))return t;',
  '  return null;',
  '}',
  'function isIn(n){',
  '  if(!n)return false;',
  '  if(n.tagName==="TEXTAREA")return true;',
  '  if(n.isContentEditable)return true;',
  '  if(n.tagName==="INPUT"&&/^(text|search)$/.test(n.type||""))return true;',
  '  return false;',
  '}',
  'function valOf(n){return n.tagName==="TEXTAREA"||n.tagName==="INPUT"?n.value:(n.textContent||"");}',
  'function atTopOf(n){',
  '  if(n.tagName==="TEXTAREA"||n.tagName==="INPUT")return (n.selectionStart||0)===0;',
  '  try{var s=window.getSelection();',
  '    if(s&&s.rangeCount){var r=s.getRangeAt(0),p=document.createRange();',
  '      p.selectNodeContents(n);p.setEnd(r.startContainer,r.startOffset);return p.toString().length===0;}}catch(e){}',
  '  return true;',
  '}',
  'function refresh(){',
  '  var n=el();',
  '  window.__dshAppIhCache=n?{val:valOf(n),atTop:atTopOf(n),tag:n.tagName}:null;',
  '}',
  'window.__dshAppIhGet=function(){refresh();return window.__dshAppIhCache;};',
  'window.__dshAppIhSet=function(v){',
  '  var n=el();',
  '  if(!n)return false;',
  '  try{',
  '    if(n.tagName==="TEXTAREA"||n.tagName==="INPUT"){',
  '      n.value=v;',
  '      try{n.dispatchEvent(new Event("input",{bubbles:true}));}catch(e){}',
  '    }else{',
  '      n.focus();',
  '      var s=window.getSelection();',
  '      if(s&&s.rangeCount){s.removeAllRanges();var r=document.createRange();r.selectNodeContents(n);s.addRange(r);}',
  '      document.execCommand("insertText",false,v);',
  '    }',
  '    if(typeof n.focus==="function")n.focus();',
  '    refresh();',
  '    return true;',
  '  }catch(e){ return false; }',
  '};',
  // 定期与事件刷新缓存（主进程同步决策用）
  'document.addEventListener("input",refresh,true);',
  'document.addEventListener("keyup",refresh,true);',
  'document.addEventListener("mouseup",refresh,true);',
  'setInterval(refresh,800);',
  '})();',
].join('\n');

function wireInputHistory(win, getPort) {
  // 每会话历史：key = por t + 页面路径
  const histories = new Map();   // key -> string[]
  const drafts = new Map();      // key -> { idx, active, draft }（↑ 回溯状态）
  let keyFor = '';

  async function sessionKey() {
    try {
      const url = win.webContents.getURL();
      const port = typeof getPort === 'function' ? getPort() : 3080;
      // 取 pathname+search+hash，隔离不同会话页
      const m = url.indexOf('127.0.0.1:' + port);
      const pathPart = m >= 0 ? url.slice(m + ('127.0.0.1:' + port).length) : url;
      return port + '|' + pathPart;
    } catch (_) { return 'default'; }
  }

  // 注入页面辅助函数（幂等；did-finish-load 与按键前都尝试）
  async function ensureHelper() {
    try {
      await win.webContents.executeJavaScript(INPUT_HELPER_JS);
    } catch (_) { /* 页面未就绪时跳过 */ }
  }

  async function getInputState() {
    try {
      const r = await win.webContents.executeJavaScript(
        'window.__dshAppIhGet ? window.__dshAppIhGet() : null'
      );
      return r && typeof r === 'object' ? r : null;
    } catch (_) { return null; }
  }

  // 同步读取页面缓存的输入框状态（决策用，避免异步赶不上按键派发）
  async function peekInputState() {
    try {
      const r = await win.webContents.executeJavaScript(
        'window.__dshAppIhCache ? window.__dshAppIhCache : null'
      );
      return r && typeof r === 'object' ? r : null;
    } catch (_) { return null; }
  }

  async function setInput(val) {
    try {
      await win.webContents.executeJavaScript(
        'window.__dshAppIhSet ? window.__dshAppIhSet(' + JSON.stringify(val) + ') : false'
      );
    } catch (_) { /* 忽略 */ }
  }

  const onBeforeInput = async (event, input) => {
    // 快捷键带修饰符时不拦截（保留 dsh 自己的 Ctrl/Cmd 组合）
    if (input.control || input.meta || input.alt) return;
    if (input.type !== 'keyDown') return;
    if (IH_KEYS.indexOf(input.key) < 0) return;

    keyFor = await sessionKey();
    let hist = histories.get(keyFor);
    if (!hist) { hist = []; histories.set(keyFor, hist); }
    let st = drafts.get(keyFor);
    if (!st) { st = { idx: hist.length, active: false, draft: '' }; drafts.set(keyFor, st); }

    if (input.key === 'ArrowUp') {
      const stateNow = await peekInputState();
      if (!stateNow) return;                    // 不在输入框
      if (!(stateNow.atTop || stateNow.val === '')) return;  // 非文首/空 → 交还 dsh
      if (hist.length === 0) return;
      if (!st.active) { st.draft = stateNow.val; st.idx = hist.length; st.active = true; }
      if (st.idx > 0) {
        st.idx--;
        event.preventDefault();
        setInput(hist[st.idx]);   // 异步写回（不回退整个按键派发）
      }
      return;
    }

    if (input.key === 'ArrowDown') {
      if (!st.active) return;
      event.preventDefault();
      if (st.idx < hist.length - 1) {
        st.idx++;
        setInput(hist[st.idx]);
      } else {
        st.idx = hist.length;
        setInput(st.draft);
        st.draft = '';
        st.active = false;
      }
      return;
    }

    if (input.key === 'Enter' && !input.shift && !input.control && !input.meta) {
      const stateNow = await peekInputState();
      if (!stateNow) return;
      const v = stateNow.val;
      if (v && v !== hist[hist.length - 1]) {
        hist.push(v);
        if (hist.length > IH_MAX) hist.splice(0, hist.length - IH_MAX);
      }
      st.idx = hist.length; st.active = false; st.draft = '';
      return;   // 不拦截 Enter，交给 dsh 发送
    }
  };

  win.webContents.on('before-input-event', onBeforeInput);
  win.webContents.on('did-finish-load', () => { ensureHelper(); });
  ensureHelper();
}

function createSettingsWindow(section) {
  if (settingsWindow) {
    settingsWindow.focus();
    if (section) focusSection(section);
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 920,
    minHeight: 640,
    resizable: true,
    parent: mainWindow,
    modal: false,
    backgroundColor: '#10141b',
    icon: WINDOW_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
  if (section) {
    settingsWindow.webContents.once('did-finish-load', () => focusSection(section));
  }
}

// 请求设置窗滚动并高亮某个卡片（如模型网关）
function focusSection(section) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('dsh:focus-section', section);
  }
}

function broadcast() {
  const snap = state.snapshot();
  for (const w of [mainWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send('dsh:state', snap);
  }
  if (tray) tray.refresh(snap);
}

// 网关状态推送给设置窗
function broadcastGw() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    const s = gateway.getState();
    settingsWindow.webContents.send('gw:state', Object.assign({}, s, { log: gateway.logTailText(8000) }));
  }
}

// ---------------- 服务控制 ----------------

async function startService() {
  readyHandled = false;
  state.update({ service: 'starting', phase: '正在启动 dsh 服务…', failReason: '' });
  await launcher.stop();
  launcher.detect();
  launcher.start();
  // 就绪等待由 'url'/'exit' 事件驱动；这里额外启动端口轮询兜底
  waitReadyByProbe();
}

async function stopService() {
  state.update({ service: 'stopped', phase: '服务未运行' });
  await launcher.stop();
}

// 端口轮询兜底：URL 行缺失的极旧版本也能判定就绪。
// 注意：兜底 URL（明文、无 token）只用于窗口加载，**绝不**触发系统浏览器（会 401）。
async function waitReadyByProbe() {
  const deadline = Date.now() + 90 * 1000;
  while (Date.now() < deadline) {
    if (!launcher.running || readyHandled) return;
    if (launcher.ready && launcher.authUrl) {
      onReady();   // stdout 就绪行已到（带 token 的真实地址）
      return;
    }
    if (await launcher.probeHealth(state.port, 1500)) {
      // 端口已活：再给 stdout 行 2 秒机会（带 token 优先）
      const t2 = Date.now() + 2000;
      while (Date.now() < t2) {
        if (launcher.ready && launcher.authUrl) {
          onReady();
          return;
        }
        await sleep(250);
      }
      if (!launcher.authUrl) launcher.authUrl = 'http://127.0.0.1:' + state.port + '/';
      onReady();
      return;
    }
    await sleep(1000);
  }
  // 超时：若进程仍在但端口无响应 → 视为启动失败
  if (launcher.running && !readyHandled) onBootTimeout();
}

function onReady() {
  if (readyHandled) return;
  readyHandled = true;
  launcher.ready = true;
  const safe = settings.data.safeMode;
  state.update({
    service: safe ? 'safe' : 'ready',
    phase: safe
      ? '安全模式运行中（已禁用: ' + (settings.data.safeModeNames || '') + '）'
      : 'dsh 服务已就绪',
    authUrl: launcher.authUrl,
  });
  // 设置项：就绪后额外用系统浏览器打开（默认关）。
  // 仅当拿到了带 token 的真实地址时才打开——兜底明文 URL 在浏览器里会 401。
  if (settings.data.autoOpenBrowser
    && launcher.authUrl.indexOf('token=') >= 0) {
    shell.openExternal(launcher.authUrl).catch(() => { /* 忽略 */ });
  }
  // 安全模式：页面顶部横幅由渲染层按 safeMode 展示
  if (mainWindow) {
    mainWindow.loadURL(launcher.authUrl).catch((err) => {
      logger.appendLog('加载界面失败: ' + (err && err.message ? err.message : err));
    });
  }
}

function onBootTimeout() {
  launcher.stop();
  logger.appendLog('服务启动超时（端口无响应），进入恢复流程。');
  watchdog.tryRecover();
}

// ---------------- 看门狗事件 ----------------
function wireLauncher() {
  launcher.on('url', () => onReady());
  launcher.on('error', (err) => {
    logger.appendLog('启动进程失败: ' + (err && err.message ? err.message : err));
    state.update({ service: 'failed', phase: '启动进程失败', failReason: String(err.message || err) });
  });
  launcher.on('exit', (code) => {
    const wasReady = launcher.ready;
    launcher.ready = false;
    if (launcher.manualStop) {
      // 手动停止：不触发看门狗
      state.update({ service: 'stopped', phase: 'dsh 服务已停止' });
      return;
    }
    if (!wasReady) {
      // 未就绪即退出 → 看门狗（插件故障自动隔离）
      watchdog.tryRecover();
    } else if (state.service === 'ready' || state.service === 'safe') {
      state.update({ service: 'stopped', phase: 'dsh 服务已停止（退出码 ' + code + '）' });
    }
  });
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('dsh:state', () => state.snapshot());
  ipcMain.handle('dsh:settings', () => settings.data);
  ipcMain.handle('dsh:save-settings', (_e, patch) => {
    settings.update(patch);
    // 端口变化即时同步到状态机（导航白名单/状态显示依赖）
    if (patch && typeof patch.port === 'number' && patch.port > 0) {
      state.port = patch.port;
    }
    // 开机自启（Windows/macOS 均支持）
    try {
      app.setLoginItemSettings({ openAtLogin: !!settings.data.autoStart, args: ['--autostart'] });
    } catch (_) { /* 忽略 */ }
    broadcast();
    return settings.data;
  });
  ipcMain.handle('dsh:action', async (_e, name) => {
    switch (name) {
      case 'start': await startService(); break;
      case 'stop': await stopService(); break;
      case 'retry': await startService(); break;
      case 'exit-safe': await watchdog.exitSafeMode(); break;
      case 'open-logs':
        shell.openPath(logger.logDirPath() || os.homedir());
        break;
      case 'open-browser':
        shell.openExternal(state.authUrl || 'http://127.0.0.1:' + state.port + '/');
        break;
      case 'open-settings': {
        // 支持 "open-settings::<section>" 形式定位到具体卡片（如 gateway）
        const section = (name.indexOf('::') >= 0) ? name.split('::')[1] : '';
        createSettingsWindow(section);
        break;
      }
      case 'focus':
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        break;
      case 'copy-upgrade-command':
        clipboard.writeText('npm i -g @deepseek-ai/dsh@latest');
        break;
      case 'browse-workdir': {
        const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (!r.canceled && r.filePaths.length) return r.filePaths[0];
        break;
      }
      default: break;
    }
    broadcast();
    return true;
  });
  ipcMain.handle('dsh:versions', async () => {
    const local = launcher.found ? launcher.found.version : null;
    const info = await updater.checkForUpdate(local);
    return { local, update: info };
  });
  // —— 模型网关 ——
  ipcMain.handle('gw:state', () => {
    const s = gateway.getState();
    return Object.assign({}, s, { log: gateway.logTailText(8000) });
  });
  ipcMain.handle('gw:action', async (_e, name, payload) => {
    switch (name) {
      case 'start': await gateway.start(); break;
      case 'stop': await gateway.stop(); break;
      case 'save-config': return gateway.saveConfig(String(payload || ''));
      case 'write-dsh': return await gateway.writeDsh();
      case 'load-example': return { text: gateway.exampleText() };
      case 'get-config': return { text: gateway.configText() };
      case 'clear-log': gateway.clearLog(); break;
      default: break;
    }
    broadcastGw();
    return true;
  });
}

// ---------------- 生命周期 ----------------

let forceQuit = false;

function quitAll() {
  forceQuit = true;
  const stopAll = async () => {
    if (gateway) await gateway.stop();
    await launcher.stop();
    app.quit();
  };
  stopAll();
}

async function bootstrap() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  // 数据目录：exe 旁 data\ 优先（绿色便携，随程序目录走）；不可写才回退 %APPDATA%
  const userData = resolveDataDir();
  logger.init(userData);
  settings = new Settings(userData);
  settings.load();

  state = new AppState();
  state.port = settings.data.port;

  const workDir = settings.data.workDir || os.homedir();
  launcher = new Launcher({ settings, logger, workDir });
  // 启动探明 dsh 版本与 node 路径（仅读包信息，不启动服务）；
  // 放在网关创建之前，让网关复用真实的 node 路径
  launcher.detect();
  watchdog = new Watchdog({ settings, launcher, state, logger, workDir });
  gateway = new GatewayManager({
    userDataDir: userData,
    nodePath: launcher.nodePath || 'node',
    settings,
    logger,
  });
  gateway.init();
  // 网关状态变化 → 推送给设置窗（若打开）
  gateway.on('state', () => broadcastGw());
  registerIpc();
  wireLauncher();

  tray = new TrayController({
    getState: () => state.snapshot(),
    actions: {
      showMain: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
      start: startService,
      stop: stopService,
      openBrowser: () => shell.openExternal(state.authUrl || 'http://127.0.0.1:' + state.port + '/'),
      openSettings: (section) => createSettingsWindow(section),
      openGateway: () => createSettingsWindow('gateway'),
      openLogs: () => shell.openPath(logger.logDirPath() || os.homedir()),
      quit: quitAll,
    },
  });
  tray.create();

  createMainWindow();
  if (settings.data.minimizeToTray) tray.refresh(state.snapshot());

  app.on('window-all-closed', () => { /* 驻留托盘 */ });
  app.on('before-quit', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      quitAll();
    }
  });

  // 检测结果展示（detect 已在启动早期执行）
  if (launcher.found) {
    state.update({ dshVersion: launcher.found.version });
    logger.appendLog('检测到 dsh ' + launcher.found.version + ' @ ' + launcher.found.dir);
    if (settings.data.checkUpdates) {
      updater.checkForUpdate(launcher.found.version).then((info) => {
        if (info) {
          logger.appendLog('发现新版本 dsh ' + info.latest + '（当前 ' + info.local + '），升级命令: ' + info.command);
          state.update({ phase: '发现新版本 dsh ' + info.latest + '，可在「设置」中查看升级命令' });
        }
      });
    }
  } else {
    state.update({ phase: '未发现本机 dsh，启动时将通过 npx 自动获取' });
  }

  // 自动启动策略：--autostart（开机自启）或设置项
  if (IS_AUTOSTART || settings.data.autoStartService) {
    startService();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.whenReady().then(bootstrap).catch((err) => {
  logger.appendLog('启动失败: ' + (err && err.stack ? err.stack : String(err)));
  app.quit();
});