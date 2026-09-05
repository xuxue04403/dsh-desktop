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
const { iconDataURL, COLORS } = require('./icon');

// 窗口/任务栏图标（程序化生成，见 icon.js）
const WINDOW_ICON = (() => {
  try {
    const { nativeImage } = require('electron');
    return nativeImage.createFromDataURL(iconDataURL(32, COLORS.brand));
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

  // 在 dsh web 页面注入壳级能力：悬浮入口 + 输入框上下键历史
  mainWindow.webContents.on('did-finish-load', () => {
    let url = '';
    try { url = mainWindow.webContents.getURL(); } catch (_) { /* 忽略 */ }
    if (url.indexOf('127.0.0.1:' + state.port) === 0) {
      mainWindow.webContents.executeJavaScript(FLOAT_BUTTONS_JS).catch(() => { /* 忽略 */ });
      mainWindow.webContents.executeJavaScript(INPUT_HISTORY_JS).catch(() => { /* 忽略 */ });
    }
  });
}

// 注入到 dsh web 页面的两个悬浮入口（右上角，透明风格；点击打开壳设置窗并定位到对应卡片）
const FLOAT_BUTTONS_JS = [
  '(function(){',
  'if (document.getElementById("__dshapp_float")) return;',
  'var d=document.createElement("div");d.id="__dshapp_float";',
  'd.style.cssText="position:fixed;top:10px;right:34px;z-index:2147483647;display:flex;gap:8px;";',
  'function mk(txt,act){var b=document.createElement("button");b.textContent=txt;',
  'b.style.cssText="border:1px solid rgba(120,140,170,.45);background:rgba(24,30,40,.62);color:#cdd6e4;',
  'border-radius:14px;padding:4px 12px;font:12px \\"Segoe UI\\",\\"Microsoft YaHei UI\\",sans-serif;cursor:pointer;',
  'backdrop-filter:blur(4px);";',
  'b.onmouseenter=function(){b.style.background="rgba(40,52,70,.82)";};',
  'b.onmouseleave=function(){b.style.background="rgba(24,30,40,.62)";};',
  'b.onclick=function(){try{if(window.dshApp&&window.dshApp.action)window.dshApp.action(act);}catch(e){}};',
  'return b;}',
  'd.appendChild(mk("⚙ 设置","open-settings"));',
  'd.appendChild(mk("🛡 模型网关","open-settings::gateway"));',
  'document.body.appendChild(d);',
  '})();',
].join('\n');

// 注入到 dsh 对话输入框的"上下键历史"：
//   ↑ 在行首/空框时回溯本会话已发送的输入；↓ 前进；Enter（发送）后自动入列。
//   - 按会话（URL）分别存储于 localStorage，最多 200 条；
//   - 仅拦截 ↑/↓ 快捷键，不影响 dsh 自身的 Enter 发送/换行逻辑；
//   - 找不到输入框（布局变化）时静默跳过，跨版本容错。
const INPUT_HISTORY_JS = [
  '(function(){',
  'if (document.getElementById("__dshapp_ih")) return;',
  'var LS="__dshapp_ih";',
  'var key=LS+":"+(location.pathname+location.search+location.hash);',
  'var hist=[];try{hist=JSON.parse(localStorage.getItem(key)||"[]")}catch(e){}',
  'if(!Array.isArray(hist))hist=[];',
  'var idx=hist.length,active=false,draft="";',
  'function inputEl(){',
  '  var els=document.querySelectorAll("textarea,[contenteditable=\\"true\\"]");',
  '  var best=null;',
  '  for(var i=0;i<els.length;i++){var el=els[i];',
  '    try{var r=el.getBoundingClientRect();',
  '    if(r.width>60&&r.height>12&&el.offsetParent!==null){best=el;}}catch(e){}}',
  '  return best;',
  '}',
  'function curVal(el){return el.tagName==="TEXTAREA"?el.value:(el.textContent||"");}',
  'function setVal(el,v){',
  '  if(el.tagName==="TEXTAREA"){el.value=v;}else{el.textContent=v;}',
  '  try{el.dispatchEvent(new Event("input",{bubbles:true}));}catch(e){}',
  '}',
  'function atTop(el){',
  '  if(el.tagName==="TEXTAREA"){return el.selectionStart===0;}',
  '  return true;',
  '}',
  'function handle(el,e){',
  '  if(e.key==="ArrowUp"&&(atTop(el)||curVal(el)==="")){',
  '    if(hist.length===0)return;',
  '    if(!active){draft=curVal(el);idx=hist.length;active=true;}',
  '    if(idx>0){idx--;setVal(el,hist[idx]);e.preventDefault();}',
  '    return;',
  '  }',
  '  if(e.key==="ArrowDown"&&active){',
  '    if(idx<hist.length-1){idx++;setVal(el,hist[idx]);}',
  '    else{idx=hist.length;setVal(el,draft);draft="";active=false;}',
  '    e.preventDefault();',
  '    return;',
  '  }',
  '  if(e.key==="Enter"&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey){',
  '    var v=curVal(el);',
  '    if(v&&v!==hist[hist.length-1]){',
  '      hist.push(v);',
  '      if(hist.length>200)hist=hist.slice(-200);',
  '      try{localStorage.setItem(key,JSON.stringify(hist));}catch(err){}',
  '    }',
  '    idx=hist.length;active=false;draft="";',
  '  }',
  '}',
  'var bound=null;',
  'function tick(){',
  '  var el=inputEl();',
  '  if(el&&el!==bound){',
  '    if(bound)bound.removeEventListener("keydown",handle);',
  '    bound=el;el.addEventListener("keydown",handle);',
  '  }',
  '}',
  'setInterval(tick,800);tick();',
  'document.addEventListener("visibilitychange",tick);',
  '})();',
].join('\n');

function createSettingsWindow(section) {
  if (settingsWindow) {
    settingsWindow.focus();
    if (section) focusSection(section);
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 640,
    resizable: false,
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

  const userData = app.getPath('userData');
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