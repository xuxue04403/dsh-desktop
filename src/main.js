// main.js — DSH App 主进程：装配 launcher/watchdog/window/tray/settings
//
// 架构（参考 anywhere-labs/dsh-desktop 的薄宿主思想，自行轻量实现）：
//   Electron 壳（窗口/托盘/设置/看门狗） + 进程外 `dsh web` 子进程（稳定契约调用）
//   好处：壳与 dsh 完全解耦（升级 dsh 不影响壳）；坏插件导致的服务故障由壳层安全模式兜底。
'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, session } = require('electron');
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
const market = require('./market');   // v1.5.18 插件市场（1024Store + npm 校验 + dsh CLI）
const { installDefaultPlugins, verifyDefaultPlugins } = require('./default-plugins');   // v1.7.0 随 app 分发的默认插件（B1 修复：漏导入 verifyDefaultPlugins 曾使启动前自检静默失效）
const pluginSnapshot = require('./plugin-snapshot');   // v1.7.7：插件迁移快照（复制目录到新电脑后自动装回插件）
const machineAdapt = require('./machine-adapt');       // v1.8.3：换机首启适配（网关配置里写死的凭据路径/区域/代理）
const crashReport = require('./crash-report');         // v1.9.0：致命错误现场落盘（独立于滚动日志，可整体拷走）
const quitGuard = require('./quit-guard');             // v1.9.0：退出前任务确认（旁路信号，见模块头注释）
const webAuth = require('./web-auth');                 // v1.9.0：用启动令牌换 cookie，页面 URL 不再带 token
const dshTag = require('./dsh-tag');                   // v1.9.1：dsh 安装/升级跟随的发行标签（DSH_DSH_TAG）
const dshHomeGuard = require('./dsh-home-guard');      // v1.9.1：共用 dsh home 的版本守卫（多实例版本分叉告警）
let marketOps = null;                 // 市场安装/卸载执行器（懒初始化，detect 后可用）
let defaultPluginsDone = false;       // 默认插件安装幂等闸（每进程最多装一次）

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

// 本应用渲染页判定（安全，P0-1 修复）：`file://` 导航放行与 IPC 来源校验**共用同一判据**，
// 实现与"为什么必须这样判"的完整说明见 renderer-guard.js（该模块有独立单测）。
const { isAppRendererPage } = require('./renderer-guard');

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

// 窗口、托盘图标资源与持久化数据目录（app.getPath('userData') 由 bootstrap 传入）
let APP_USERDATA = '';   // 数据目录（resolveDataDir 解析结果），供输入历史持久化

// v1.9.0：崩溃报告的附加现场。任何一项都可能尚未初始化（启动早期就崩），所以逐项
// 防御——取不到就不写这一项，绝不因为"收集现场"本身再抛一次异常。
function crashContext() {
  const info = {};
  try { info.version = app.getVersion(); } catch (_) { /* 忽略 */ }
  try { info.electron = process.versions.electron; } catch (_) { /* 忽略 */ }
  try { info.node = process.versions.node; } catch (_) { /* 忽略 */ }
  try { info.platform = process.platform + ' ' + process.arch + ' / ' + os.release(); } catch (_) { /* 忽略 */ }
  try { info.uptimeMs = process.uptime() * 1000; } catch (_) { /* 忽略 */ }
  try { if (APP_USERDATA) info.dataDir = APP_USERDATA; } catch (_) { /* 忽略 */ }
  try { if (state) { info.port = state.port; info.service = state.service; info.phase = state.phase; } } catch (_) { /* 忽略 */ }
  try {
    if (launcher) {
      info.context = {
        dshReady: !!launcher.ready,
        dshRunning: !!launcher.running,
        safeMode: !!(settings && settings.data && settings.data.safeMode),
        gatewayRunning: !!(gateway && gateway.running),
      };
    }
  } catch (_) { /* 忽略 */ }
  return info;
}

// v1.9.0：统一的主界面加载入口。
// 先把启动令牌换成会话 cookie，成功则加载**不含令牌**的干净 URL——令牌不再进入渲染层的
// location / 导航历史（页面里还有第三方插件的客户端脚本）。任何一步失败都回退到既有的
// "带令牌 URL"，保证界面一定打得开。换发每次 dsh 就绪只做一次：cookie 绑定该次启动的
// authority，重启 dsh 后必须重换（在 startService 里随 readyHandled 一起复位）。
let webAuthPrimed = false;
let webAuthTried = false;

async function loadWebUI(win) {
  if (!win || win.isDestroyed() || !launcher || !launcher.authUrl) return;
  if (!webAuthTried) {
    webAuthTried = true;   // 先占位：即使下面的 await 期间再次被调用，也不会重复换发
    try {
      const r = await webAuth.primeSessionCookie(session.defaultSession, launcher.authUrl,
        (m) => logger.appendLog(m));
      webAuthPrimed = r.ok;
      logger.appendLog(r.ok
        ? '[界面加载] ' + r.detail + '；主窗口以不带令牌的 URL 加载'
        : '[界面加载] cookie 引导未生效（' + r.detail + '），回退为带令牌的 URL');
    } catch (err) {
      webAuthPrimed = false;
      logger.appendLog('[界面加载] cookie 引导异常，回退为带令牌的 URL：' + (err && err.message ? err.message : err));
    }
  }
  if (win.isDestroyed()) return;   // 换发期间窗口可能已被关掉
  return win.loadURL(webAuth.targetUrl(webAuthPrimed, launcher.authUrl)).catch((err) => {
    logger.appendLog('加载界面失败: ' + (err && err.message ? err.message : err));
  });
}

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
      // 主窗口先加载 renderer/status.html（本地 file:// 状态页，需要 dshApp 桥），
      // 就绪后再导航到 dsh web 页面。桥本身保留，但**所有壳级 IPC 都按来源帧校验**
      // （见 fromLocalPage）：只有 file:// 的 renderer/*.html 能用，dsh web 页面用不了。
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
    // P0-1 修复：旧版 `if (url.startsWith('file://')) return;` 无条件放行任意本地文件导航，
    // 等于把 preload 桥交给磁盘上任意 HTML。现在只放行本应用自带渲染页（见 isAppRendererPage）。
    if (isAppRendererPage(url)) return;
    const allowed = 'http://127.0.0.1:' + state.port;
    // P0-1 加固：按 origin 比较（旧版用 startsWith 前缀比较，语义不严谨）
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === allowed; } catch (_) { /* 非法 URL → 拦截 */ }
    if (!sameOrigin) {
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
  // 审计修复（P2）：渲染进程崩溃/无响应时，旧版窗口会永久白屏或假死，用户没有任何恢复
  // 入口（只能杀进程）。崩溃 → 回到本地状态页并给出提示（状态页有「重新启动」按钮）。
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    const reason = (details && details.reason) || 'unknown';
    logger.appendLog('界面渲染进程异常退出：' + reason + '（exitCode ' + ((details && details.exitCode) || 0) + '）');
    // v1.9.0：`clean-exit` 是正常收尾，不算崩溃；其余（crashed / oom / killed /
    // integrity-failure…）固化成报告——渲染进程没了而壳还活着，正是最需要现场的一种。
    if (reason !== 'clean-exit') {
      try {
        const ctx = crashContext();
        ctx.context = Object.assign({}, ctx.context, {
          reason: reason,
          exitCode: (details && details.exitCode) || 0,
          statePhase: ctx.phase,   // 原 state.phase 挪进现场，"阶段"让位给事件标签
        });
        ctx.phase = '界面渲染进程异常退出';
        crashReport.record('renderer', null, ctx);
      } catch (_) { /* 忽略 */ }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'status.html'))
        .then(() => state.update({ phase: '界面进程异常退出（' + reason + '），已回到状态页——可点「重新启动」恢复' }))
        .catch(() => { /* 忽略 */ });
    }
  });
  mainWindow.on('unresponsive', () => logger.appendLog('界面无响应（dsh 页面卡死或机器繁忙）。'));
  mainWindow.on('responsive', () => logger.appendLog('界面已恢复响应。'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    broadcast();
  });

  // 窗口标题固定为「DSH」：内嵌 dsh web 页面会把自己的 <title>（会话标题 — DeepSeek
  // Harness）同步到窗口标题栏，这里接管并阻止，避免显示"DSH桌面版开发评估 — DeepSeek Harness"
  const appTitle = 'DSH';
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow.setTitle(appTitle);
  });
  mainWindow.on('ready-to-show', () => mainWindow.setTitle(appTitle));

  // dsh web 页面加载后固定窗口标题（阻断内嵌页面 title 同步）
  mainWindow.webContents.on('did-finish-load', () => {
    let url = '';
    try { url = mainWindow.webContents.getURL(); } catch (_) { /* 忽略 */ }
    // URL 形如 http://127.0.0.1:<port>/?token=...（indexOf 定位端口，不能用 ===0，
    // http:// 前缀使 indexOf 必不为 0）
    if (url.indexOf('127.0.0.1:' + state.port) >= 0) {
      mainWindow.setTitle(appTitle);
    }
  });
  // 输入框上下键历史：主进程 before-input-event 拦截（不依赖页面注入时机），
  // 历史按会话 key 持久化到 data\input-history.json（跨启动保留），读写输入框经 executeJavaScript。
  wireInputHistory(mainWindow, () => state.port, APP_USERDATA);
}

// R22：确保主窗口存在并可见（minimizeToTray=false 时用户关窗后 mainWindow 为 null，
// 托盘/二次实例/「聚焦」此前对 null 无操作 → UI 无法再打开，只能重启 app）
function ensureMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    // 服务已就绪 → 直接载入 dsh 界面（否则停留本地状态页）
    // v1.9.0：走统一入口（先换 cookie 再加载，失败自动回退带令牌 URL）
    if (launcher && launcher.ready && launcher.authUrl && mainWindow && !mainWindow.isDestroyed()) {
      // P1（第二轮审计修复）：上一次换发失败时 `webAuthTried` 仍是 true → 重开窗口会**直接**
      // 以带令牌 URL 加载（令牌进入 location 与导航历史，页面里还有第三方插件脚本），
      // 而 web-auth.js 的全部设计目标正是消除这一点。cookie 未就绪时允许重试一次换发。
      if (!webAuthPrimed) webAuthTried = false;
      loadWebUI(mainWindow);
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

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

// 主进程侧的「输入框状态镜像」：由 preload.js 暴露的 __dshAppIh.report() 单向上报维护，
// before-input-event 里**同步**读取——按键派发路径上不允许 await（见下方注释）。
let ihMirror = null;
// 当前会话 id（页面从 WebSocket 帧里学到后上报）：输入历史按它隔离。
let ihSid = '';
// 学到会话 id 时的回调（由 wireInputHistory 注册）：用于把"刚提交但当时还不知道会话 id"
// 的那一条历史补记到正确的会话桶里，并做一次性的旧历史迁移。
let ihSessionHook = null;

// 会话 id 是否真的存在于 dsh 的会话库（~/.dsh/sessions/<工作目录>/<会话id>）。
// 用于过滤掉帧里偶然出现的、非当前会话的临时 id：不因为一个查不到的 id 丢掉已验证会话。
let sessionIdCache = { at: 0, ids: new Set() };
/**
 * 会话 id 是否真的存在于 dsh 的会话库。
 *
 * P1（第二轮审计修复）：新增 `force`。缓存 TTL 是 60 秒，而**新建会话**的 id 在缓存里
 * 还没有记录 → 上报的新 sid 被判为"查不到"而被拒绝（见 dsh:ih-state 的过滤器），
 * 于是新会话开头最多 60 秒的输入历史会被记到**上一个会话**的桶里（历史串会话）。
 * 现在只在"遇到未知 id"时才强制刷新一次：正常路径不多付 IO 代价。
 *
 * @param {boolean} [force] - 忽略缓存，强制重新扫描。
 * @returns {Set<string>} 已知会话 id 集合。
 */
function knownSessionIds(force) {
  const now = Date.now();
  if (!force && now - sessionIdCache.at < 60000) return sessionIdCache.ids;
  const ids = new Set();
  try {
    const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
    for (const dir of require('fs').readdirSync(root)) {
      try {
        for (const id of require('fs').readdirSync(path.join(root, dir))) ids.add(id);
      } catch (_) { /* 单个工作目录不可读 → 跳过 */ }
    }
  } catch (_) { /* 无 sessions 目录 */ }
  sessionIdCache = { at: now, ids };
  return ids;
}

// 页面内辅助函数（通过 executeJavaScript 注入到 dsh web 页面）
// 除 get/set 外，还把"当前输入框状态"经 window.__dshAppIh.report() 上报给主进程，
// 供 before-input-event **同步**决策（异步查询赶不上按键派发，见 wireInputHistory 注释）。
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
  // 上报给主进程（审计：主进程据此同步决策 ↑↓ 是否 preventDefault）
  // 同时带上"当前会话 id"——dsh 是 SPA，切会话不改 URL（实测 URL 恒为 /），
  // 输入历史必须按会话隔离，否则会变成"整个 dsh 的历史"。
  '  try{if(window.__dshAppIh&&window.__dshAppIh.report)window.__dshAppIh.report({input:window.__dshAppIhCache,sid:(window.__dshAppIhSid||"")});}catch(e){}',
  '}',
  // —— 会话 id 侦测（审计修复 P1）——
  // dsh 客户端把会话选择走 WebSocket RPC（dsh-api-gateway: socket.send(JSON.stringify(frame))），
  // 因此这里钩住 WebSocket.prototype.send，从外发帧里学习当前会话 id：切会话会 follow、
  // 发消息会带 sessionId/agentId。帧是 JSON 文本，形如 "sessionId":"xxxx"。
  'window.__dshAppIhSid="";',
  // 按优先级取 id：sessionId（当前会话）> agentId（dsh 里就是会话 id 的别名）>
  // childSessionId（子会话——最后才用，避免把子代理会话当成当前会话）
  'function pickSid(data){',
  '  var m=data.match(/"sessionId":"([^"]{4,80})"/);',
  '  if(m)return m[1];',
  '  m=data.match(/"agentId":"([^"]{4,80})"/);',
  '  if(m)return m[1];',
  '  m=data.match(/"childSessionId":"([^"]{4,80})"/);',
  '  if(m)return m[1];',
  '  return "";',
  '}',
  'function learnSid(data){',
  '  try{',
  '    if(typeof data!=="string"||data.length>400000)return;',
  '    if(data.indexOf("essionId")<0&&data.indexOf("gentId")<0)return;',
  '    var s=pickSid(data);',
  '    if(s&&s!==window.__dshAppIhSid){window.__dshAppIhSid=s;refresh();}',
  '  }catch(e){}',
  '}',
  'if(!window.__dshAppIhWsHooked&&window.WebSocket&&WebSocket.prototype&&WebSocket.prototype.send){',
  '  window.__dshAppIhWsHooked=true;',
  '  var _ihSend=WebSocket.prototype.send;',
  '  WebSocket.prototype.send=function(d){learnSid(d);return _ihSend.apply(this,arguments);};',
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
  'refresh();',
  '})();',
].join('\n');

function wireInputHistory(win, getPort, userDataDir) {
  // 每会话历史：key = port|sid:<会话id>（dsh 是 SPA，URL 不变，必须用会话 id）
  const histories = new Map();   // key -> string[]
  const drafts = new Map();      // key -> { idx, active, draft }（↑ 回溯状态）
  let keyFor = '';
  // "提交时还不知道会话 id"的历史暂存（学到后补记到正确会话）
  let pendingValue = '';
  let pendingTimer = null;
  let legacyMigrated = false;   // 旧版全站历史是否已一次性并入会话桶

  // —— 持久化：data\input-history.json（跨启动保留）——
  const histFile = userDataDir ? path.join(userDataDir, 'input-history.json') : '';
  let saveTimer = null;
  function loadHistories() {
    try {
      if (!histFile || !fsExists(histFile)) return;
      const j = JSON.parse(require('fs').readFileSync(histFile, 'utf8'));
      if (j && typeof j === 'object') {
        for (const k of Object.keys(j)) {
          if (Array.isArray(j[k])) histories.set(k, j[k].slice(-IH_MAX));
        }
      }
      // eslint-disable-next-line no-console
      console.log('[dshapp] 输入历史已加载：' + histories.size + ' 个会话');
    } catch (_) { /* 损坏则忽略 */ }
  }
  function saveHistories() {
    if (!histFile) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveTimer = setTimeout(() => {
      try {
        const out = {};
        histories.forEach((v, k) => { out[k] = v; });
        require('fs').writeFileSync(histFile, JSON.stringify(out), 'utf8');
      } catch (_) { /* 写失败忽略 */ }
    }, 300);
  }
  loadHistories();

  // 会话 key（同步：**按键派发路径上不能 await**，见下）
  //
  // 审计修复（P1）：dsh 是 SPA——切换会话**不改 URL**（实测 input-history.json 里长期只有
  // 一个 key `3080|/`），所以旧的"端口+路径"方案等于全站共用一个历史桶（用户看到的是
  // "整个 dsh 的历史"）。现在优先用页面从 WebSocket 帧里学到的**会话 id**；只有在还没学到
  // （刚加载、尚未 follow/发送）时才退回 URL 桶，且单独用一个 "pending" 命名空间，避免把
  // 旧的全站历史当成当前会话的历史显示出来。
  function sessionKey() {
    const port = typeof getPort === 'function' ? getPort() : 3080;
    if (ihSid) return port + '|sid:' + ihSid;
    try {
      const url = win.webContents.getURL();
      // 只保留 pathname + hash（存根），丢弃 token 等易变 query
      const m = url.indexOf('127.0.0.1:' + port);
      let rest = m >= 0 ? url.slice(m + ('127.0.0.1:' + port).length) : url;
      const hashAt = rest.indexOf('#');
      const hash = hashAt >= 0 ? rest.slice(hashAt) : '';
      const qAt = rest.indexOf('?');
      const pathname = (qAt >= 0 ? rest.slice(0, qAt) : rest.split('#')[0]) || '/';
      return port + '|pending|' + pathname + hash;
    } catch (_) { return 'default'; }
  }

  // fs 引用（require('fs') 局部引以避免顶层绑定的命名冲突）
  function fsExists(p) { try { return require('fs').existsSync(p); } catch (_) { return false; } }

  // 注入页面辅助函数（幂等；did-finish-load 与按键前都尝试）
  async function ensureHelper() {
    try {
      await win.webContents.executeJavaScript(INPUT_HELPER_JS);
    } catch (_) { /* 页面未就绪时跳过 */ }
  }

  async function setInput(val) {
    try {
      await win.webContents.executeJavaScript(
        'window.__dshAppIhSet ? window.__dshAppIhSet(' + JSON.stringify(val) + ') : false'
      );
    } catch (_) { /* 忽略 */ }
  }

  // ⚠️ 审计修复（P1）：本处理器**必须同步**决策。
  // Electron 的 before-input-event 只在处理器同步执行期间接受 preventDefault()——
  // 旧实现在 `await sessionKey()` / `await peekInputState()` 之后才调用 preventDefault，
  // 此时按键早已派发到页面：结果是「光标按原生行为移动/换行」与「我们异步写回历史」
  // 同时发生（光标错位、↑ 与 ↓ 行为不稳定）。现在状态从主进程镜像 ihMirror 同步读取。
  const onBeforeInput = (event, input) => {
    // 快捷键带修饰符时不拦截（保留 dsh 自己的 Ctrl/Cmd 组合）
    if (input.control || input.meta || input.alt) return;
    if (input.type !== 'keyDown') return;
    if (IH_KEYS.indexOf(input.key) < 0) return;

    keyFor = sessionKey();
    let hist = histories.get(keyFor);
    if (!hist) { hist = []; histories.set(keyFor, hist); }
    let st = drafts.get(keyFor);
    if (!st) { st = { idx: hist.length, active: false, draft: '' }; drafts.set(keyFor, st); }

    if (input.key === 'ArrowUp') {
      const stateNow = ihMirror;                 // 主进程镜像（同步）
      if (!stateNow) return;                     // 不在输入框 / 尚未上报
      if (!(stateNow.atTop || stateNow.val === '')) return;  // 非文首/空 → 交还 dsh
      if (hist.length === 0) return;
      if (!st.active) { st.draft = stateNow.val; st.idx = hist.length; st.active = true; }
      if (st.idx > 0) {
        st.idx--;
        event.preventDefault();                  // 同步 → 真正拦下原生光标移动
        setInput(hist[st.idx]);                  // 异步写回（值本身不受影响）
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
      const stateNow = ihMirror;
      if (stateNow) {
        const v = stateNow.val;
        // 审计修复（P1）：历史按会话落桶。提交那一刻**还不知道**会话 id 时（Enter 早于
        // dsh 发出 RPC 帧），先把这条挂起，等页面学到会话 id 后补记（见 ihSessionHook）；
        // 3 秒仍未学到就丢弃，绝不写进别的会话桶。
        if (v) {
          if (ihSid) recordHistory(hist, v);
          else {
            pendingValue = v;
            if (pendingTimer) clearTimeout(pendingTimer);
            pendingTimer = setTimeout(() => { pendingValue = ''; pendingTimer = null; }, 3000);
          }
        }
      }
      st.idx = hist.length; st.active = false; st.draft = '';
      return;   // 不拦截 Enter，交给 dsh 发送
    }
  };

  // 记录一条历史（去重 + 上限 + 防抖持久化）
  function recordHistory(hist, v) {
    if (!v || v === hist[hist.length - 1]) return false;
    hist.push(v);
    if (hist.length > IH_MAX) hist.splice(0, hist.length - IH_MAX);
    saveHistories();
    return true;
  }

  // 会话 id 刚学到：① 补记挂起的那条提交；② 一次性把旧版"全站一个桶"的历史并入该会话
  ihSessionHook = (sid) => {
    const port = typeof getPort === 'function' ? getPort() : 3080;
    const key = port + '|sid:' + sid;
    let h = histories.get(key);
    if (!h) { h = []; histories.set(key, h); }

    // ① 旧版历史（key 形如 `3080|/`，即"整个 dsh 的历史"）一次性并入**第一个学到会话 id 的会话**，
    //    之后各会话各自独立。数据只搬不删（并入后旧桶移除，避免再次并入其它会话）。
    if (!legacyMigrated) {
      legacyMigrated = true;
      const legacyKeys = [...histories.keys()].filter((k) => /^\d+\|(\/|pending\|)/.test(k));
      let moved = 0;
      for (const lk of legacyKeys) {
        const arr = (histories.get(lk) || []).filter((v) => typeof v === 'string' && v);
        if (arr.length) {
          const merged = [...arr.filter((v) => !h.includes(v)), ...h];
          h.length = 0;
          h.push(...merged.slice(-IH_MAX));
          moved += arr.length;
        }
        histories.delete(lk);
      }
      if (moved) {
        // eslint-disable-next-line no-console
        console.log('[dshapp] 已把旧的全站输入历史并入当前会话（' + moved + ' 条，一次性迁移）');
        saveHistories();
      }
    }

    // ② 提交时还不知道会话 id 的那一条 → 补记到本会话
    if (!pendingValue) return;
    const v = pendingValue;
    pendingValue = '';
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (recordHistory(h, v)) {
      // eslint-disable-next-line no-console
      console.log('[dshapp] 会话历史已归档到 ' + key);
    }
  };

  win.webContents.on('before-input-event', onBeforeInput);
  win.webContents.on('did-finish-load', () => {
    ihMirror = null;        // 页面重载 → 镜像失效，等新的上报
    ihSid = '';             // 新页面 → 会话 id 需要重新学习
    ensureHelper();
  });
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
  // R25（审计修复）：与主窗口同款——外链一律交系统浏览器，拒绝新开 BrowserWindow
  // （市场页有 window.open(item.homepage) 调用）
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url).catch(() => { /* 忽略 */ });
    return { action: 'deny' };
  });
  // 审计修复（P3）：设置窗此前没有 will-navigate 守卫。设置页只应停留在本地文件，
  // 任何外部导航一律拒绝并交系统浏览器（与主窗口同策略，纵深防御）。
  settingsWindow.webContents.on('will-navigate', (e, url) => {
    // P0-1 修复：同主窗口——只放行本应用自带渲染页，其余 file:// 一律拒绝
    if (isAppRendererPage(url)) return;
    e.preventDefault();
    if (url.startsWith('http')) shell.openExternal(url).catch(() => { /* 忽略 */ });
  });
  if (section) {
    settingsWindow.webContents.once('did-finish-load', () => focusSection(section));
  }
}

// 请求设置窗滚动并高亮某个卡片（如模型网关）
function focusSection(section) {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  // 审计修复（P3）：窗口刚创建、页面尚未加载完时立即 send 会丢事件（旧版只在
  // "本次创建"时注册 did-finish-load，复用已存在的窗口就直接发 → 定位失效）。
  try {
    if (settingsWindow.webContents.isLoading()) {
      settingsWindow.webContents.once('did-finish-load', () => focusSection(section));
      return;
    }
  } catch (_) { /* 忽略：直接尝试发送 */ }
  settingsWindow.webContents.send('dsh:focus-section', section);
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

// ---------------- 默认插件（随 app 分发） ----------------
// v1.7.0：dsh-email-bridge（邮箱桥接）随 dsh-app 分发 → 安装到 dsh profile 并挂载。
// R24：installDefaultPlugins 为异步（含 pnpm 安装路径）；每进程最多完整执行一次；
// verifyDefaultPlugins 在每次启动 dsh 前做「挂载条目 ⇒ 包可解析」自检并自动修复
// （2026-09-10 事故：插件包被 pnpm 清理后挂载条目悬空 → dsh 整树启动失败）。
async function ensureDefaultPlugins(reason) {
  if (defaultPluginsDone) return null;
  if (!settings || settings.data.installDefaultPlugins === false) return null;
  const found = launcher && launcher.found;
  if (!found) return null;
  try {
    const r = await installDefaultPlugins({
      hostDshDir: found.dir,
      nodeInfo: launcher.nodeInfo || { exe: 'node', env: {}, embedded: false },
      profile: 'web',
      logger,
    });
    defaultPluginsDone = r.ok === true;
    logger.appendLog('[默认插件] ' + r.action + '：' + r.message + '（' + reason + '）');
    return r;
  } catch (err) {
    logger.appendLog('[默认插件] 安装异常：' + (err && err.message ? err.message : err));
    return null;
  }
}

async function verifyDefaultPluginsBeforeStart() {
  // 注意：自检是**安全检查**（挂载条目 ⇒ 包/宿主依赖可解析），不受 installDefaultPlugins
  // 设置门控——用户关闭"默认插件安装"后，已挂载的插件仍必须保持可解析，否则包一旦
  // 被清理就会悬空条目 → dsh 整树启动失败（R24 事故形态）。
  try {
    const r = await verifyDefaultPlugins({
      hostDshDir: launcher && launcher.found ? launcher.found.dir : null,
      nodeInfo: launcher ? launcher.nodeInfo : null,
      profile: 'web',
      logger,
    });
    // 用户经市场/自检确认卸载（dep+包都没了）→ 关闭"默认插件安装"，尊重用户选择，
    // 否则下次进程启动 ensure 会静默重装回滚用户的卸载（审计高-1）。
    // 环境性摘除（host 不可解析/修复失败）不关闭——环境恢复后要自动装回。
    if (r && r.action === 'entry-removed' && settings) {
      settings.update({ installDefaultPlugins: false });
      defaultPluginsDone = true;   // 本进程不再尝试安装
      logger.appendLog('[默认插件] 检测到用户已卸载默认插件——已关闭「默认插件安装」设置（不再自动重装；可在设置中重新开启）');
    }
  } catch (err) {
    logger.appendLog('[默认插件] 启动前自检异常：' + (err && err.message ? err.message : err));
  }
}

// ---------------- 迁移快照（v1.7.7：复制绿色目录到新电脑后自动装回插件与 dsh 配置） ----------------
// 背景：壳与内置 dsh、网关配置都随目录走，但用户自己装的插件与 dsh 自身配置都在 ~/.dsh 里——
// 新机器上插件会"消失"（搜索插件没了、邮箱桥接要重填密码）、dsh 也不认识任何模型路由。
// 这里把插件清单 + 插件配置 + dsh 配置（settings.yaml/.credentials.yaml 等）采集到数据目录
// （随目录复制；发布 zip 剔除 data\ 所以不会外泄），新机器启动前自动补齐。
let pluginSnapshotCaptured = false;
let pluginSnapshotApplied = false;
let serviceBootStartAt = 0;   // 本次 dsh 拉起时刻（算"就绪耗时"用）

// 市场执行器（懒初始化；与「市场」IPC 复用同一构造参数）
function ensureMarketOps() {
  if (!marketOps) {
    marketOps = new market.MarketOps({
      nodeInfo: (launcher && launcher.nodeInfo) || { exe: 'node', env: {}, embedded: false },
      dshBin: launcher && launcher.found ? launcher.found.bin : null,
      log: (s) => logger.appendLog('[市场] ' + s),
    });
  }
  return marketOps;
}

/** 启动 dsh 之前应用插件快照（首次在新机器上运行时装回缺失插件） */
async function applyPluginSnapshotBeforeStart() {
  if (pluginSnapshotApplied) return null;
  const found = launcher && launcher.found;
  if (!found || !APP_USERDATA) return null;
  pluginSnapshotApplied = true;   // 每次进程只尝试一次（失败不阻断、也不反复触发 pnpm）
  const t0 = Date.now();
  try {
    const r = await pluginSnapshot.applyIfNeeded({
      dataDir: APP_USERDATA,
      profile: 'web',
      marketOps: ensureMarketOps(),
      hostDshDir: found.dir,      // 宿主依赖本地化（junction）：让 dsh 启动不必联网解析依赖
      log: (s) => logger.appendLog('[迁移快照] ' + s),
    });
    logger.appendLog('[迁移快照] ' + r.action + '：' + r.message + '（启动前，耗时 ' + (Date.now() - t0) + 'ms）');
    return r;
  } catch (err) {
    logger.appendLog('[迁移快照] 应用异常：' + (err && err.message ? err.message : err));
    return null;
  }
}

// ---------------- 换机首启适配（v1.8.3：网关配置里"只在本机成立"的部分） ----------------
// 与迁移快照的分工：快照负责把插件与 dsh 配置装回来；这里负责网关配置的换机适配——
// 清掉写死别处用户名的 authFile、按新机实际登录的 WorkBuddy 区域启停对应供应商、
// 关掉本机不可达的本地代理。幂等（按机器指纹），只动机器相关字段，绝不碰任何 Key。
let machineAdapted = false;
async function adaptGatewayForMachineBeforeStart() {
  if (machineAdapted) return null;
  if (!APP_USERDATA) return null;
  machineAdapted = true;   // 每次进程只尝试一次
  try {
    const r = await machineAdapt.applyIfNeeded({
      dataDir: APP_USERDATA,
      log: (s) => logger.appendLog('[换机适配] ' + s),
    });
    if (r.action === 'adapted') logger.appendLog('[换机适配] ' + r.message);
    else logger.appendLog('[换机适配] ' + r.action + '：' + r.message);
    return r;
  } catch (err) {
    logger.appendLog('[换机适配] 异常（不阻断启动）：' + (err && err.message ? err.message : err));
    return null;
  }
}

/**
 * v1.9.0：快照可迁移性自检。
 *
 * 本项目的核心用法是"绿色目录直接拷到新电脑就能跑"，而能否直接跑取决于快照承诺随包
 * 携带的插件包体与 dsh 配置文件是否真的躺在 data\ 里。等到新机器上才发现缺东西，
 * 代价是离线环境下插件装不回来——所以每次刷新快照后当场校验一次并如实报告。
 *
 * 只读、不阻断：异常只记日志（启动路径上不引入新的失败面）。
 */
function selfCheckSnapshot(reason) {
  if (!APP_USERDATA) return null;
  try {
    const v = pluginSnapshot.verify(APP_USERDATA);
    if (!v.snapshotExists) {
      logger.appendLog('[迁移自检] 尚无迁移快照（' + reason + '）');
      return v;
    }
    if (v.ok) {
      logger.appendLog('[迁移自检] 通过：' + v.message + '（' + reason + '）');
    } else {
      logger.appendLog('[迁移自检] 发现不完整——现在拷到新电脑可能缺内容：' + v.message + '（' + reason + '）');
    }
    if (v.plugins && v.plugins.registry && v.plugins.registry.length) {
      logger.appendLog('[迁移自检] ' + v.plugins.registry.length + ' 个插件无随包内容，新机器需联网安装：'
        + v.plugins.registry.join(', '));
    }
    state.update({ migrationCheck: { ok: v.ok, message: v.message, at: Date.now() } });
    return v;
  } catch (err) {
    logger.appendLog('[迁移自检] 异常：' + (err && err.message ? err.message : err));
    return null;
  }
}

/** 服务就绪后刷新快照（保持"随时可复制迁移"的状态） */
function capturePluginSnapshotNow(reason) {
  if (pluginSnapshotCaptured || !APP_USERDATA) return null;
  pluginSnapshotCaptured = true;
  try {
    const r = pluginSnapshot.capture({
      dataDir: APP_USERDATA,
      profile: 'web',
      log: (s) => logger.appendLog('[迁移快照] ' + s),
    });
    if (r.ok) logger.appendLog('[迁移快照] ' + r.action + '：' + r.message + '（' + reason + '）');
    else logger.appendLog('[迁移快照] ' + r.action + '：' + r.message + '（' + reason + '）');
    selfCheckSnapshot(reason);   // v1.9.0：采集完立刻校验可迁移性
    return r;
  } catch (err) {
    logger.appendLog('[迁移快照] 采集异常：' + (err && err.message ? err.message : err));
    return null;
  }
}

// ---------------- 服务控制 ----------------
// 服务操作串行队列（审计高-2/中-5）：start/stop 并发进入时（启动中点停止、双击启动、
// 托盘与设置页同时操作）按序执行，杜绝"启动中 verify/pnpm 阶段被 stop 穿透后
// in-flight start 继续 launcher.start() 把状态翻回 ready"的竞态。
let serviceOpQueue = Promise.resolve();
function runServiceOp(label, fn) {
  const next = serviceOpQueue.then(fn, fn);
  // 队列自身错误不阻断后续操作
  serviceOpQueue = next.then(() => undefined, () => undefined);
  next.then(
    () => undefined,
    (err) => logger.appendLog('[服务操作] ' + label + ' 异常：' + (err && err.message ? err.message : err)),
  );
  return next;
}

async function startService() {
  // v1.9.3（2026-09-29 实测竞态）：升级期间**不得**拉起服务。
  // 事故：启动流程的 startService() 与升级的 `npm install` 抢跑——安装窗口内 `node-global`
  // 被腾空，findDsh 只找得到 npx 缓存里的旧版（实测 0.1.7-rc.2），于是进程在 21:09:57 起来、
  // 而升级 21:10:14 才完成；日志写着"自动升级成功 0.2.0-rc.2"，**实际运行的却是旧版**。
  // 现在启动流程让位，由升级流程在安装完成后负责拉起（见 upgradeDsh 的 shouldRunAfter）。
  if (upgrading) {
    logger.appendLog('[启动] 升级进行中 —— 暂不拉起服务（升级完成后会自动拉起）');
    return { ok: false, error: 'upgrade-in-progress' };
  }
  return runServiceOp('启动', async () => {
    readyHandled = false;
    // v1.9.0：新一次启动 = 新 authority 令牌，会话 cookie 必须重换（见 loadWebUI）
    webAuthTried = false;
    webAuthPrimed = false;
    state.update({ service: 'starting', phase: '正在启动 dsh 服务…', failReason: '' });
    // 启动分段计时（2026-09-11 加）：迁移到新机器后"启动慢"必须能一眼看出卡在哪一段。
    //   [启动计时] 停旧进程 0ms / 检测 dsh 120ms / 默认插件自检 5000ms / 迁移快照 20ms → 已拉起 dsh
    const t0 = Date.now();
    await launcher.stop();
    const t1 = Date.now();
    launcher.detect();
    const t2 = Date.now();
    // R24：启动 dsh 前自检默认插件（挂载条目 ⇒ 包可解析；不一致自动修复，防悬空条目启动失败）
    await verifyDefaultPluginsBeforeStart();
    const t3 = Date.now();
    // v1.7.7：新机器首次运行 → 按快照把用户插件装回（幂等；无快照时是纯读取，零开销）
    await applyPluginSnapshotBeforeStart();
    const t4 = Date.now();
    launcher.start();
    serviceBootStartAt = Date.now();
    logger.appendLog('[启动计时] 停旧进程 ' + (t1 - t0) + 'ms / 检测 dsh ' + (t2 - t1)
      + 'ms / 默认插件自检 ' + (t3 - t2) + 'ms / 迁移快照 ' + (t4 - t3) + 'ms → 已拉起 dsh');
    // 就绪等待由 'url'/'exit' 事件驱动；这里额外启动端口轮询兜底
    waitReadyByProbe();
  });
}

/** 慢启动取证（2026-09-11 加）：dsh 就绪耗时过长时，把它自己的 stdout（web.log）末尾若干行
 *  抄进 app.log——用户只需贴一个文件，就能看出是插件加载、pnpm 同步还是网络等待。 */
function logSlowBootDetails(bootMs) {
  try {
    const p = logger.webLogPath();
    // 2026-09-29 修复：本文件**没有顶层 `fs` 绑定**（别处一律用内联 require('fs') 或 fsExists()，
    // 第 456 行还专门注明"避免顶层绑定的命名冲突"）。这里原先直接写 `fs.existsSync` / `fs.readFileSync`
    // → 每次抛 ReferenceError: fs is not defined → 被下面的 catch 吞掉，日志只留一行
    // "读取 web.log 失败：fs is not defined"。**该功能自 2026-09-11 加入以来从未工作过。**
    if (!p || !fsExists(p)) {
      logger.appendLog('[启动诊断] web.log 不存在（dsh 未输出？）');
      return;
    }
    const lines = String(require('fs').readFileSync(p, 'utf8')).split(/\r?\n/).filter((l) => l.trim());
    const tail = lines.slice(-25);
    logger.appendLog('[启动诊断] dsh 就绪耗时 ' + Math.round(bootMs / 1000) + 's（偏慢）；web.log 末尾 '
      + tail.length + ' 行（共 ' + lines.length + ' 行）：');
    for (const l of tail) logger.appendLog('[启动诊断] | ' + l.slice(0, 240));
  } catch (err) {
    logger.appendLog('[启动诊断] 读取 web.log 失败：' + (err && err.message ? err.message : err));
  }
}

async function stopService() {
  return runServiceOp('停止', async () => {
    state.update({ service: 'stopped', phase: '服务未运行' });
    await launcher.stop();
  });
}

// ---------------- dsh 自动升级（v1.5.17）----------------
// 流程：停服（防 Windows 文件占用）→ npm i -g @deepseek-ai/dsh@<标签> → detect 刷新版本 →
// 若之前在运行则重启服务。任何失败都写日志并回退提示手动命令。
// v1.9.1：标签由 dsh-tag 统一解析（DSH_DSH_TAG，缺省 latest），不再写死 latest。
let upgrading = false;   // 升级互斥（自动触发与手动按钮并发保护）

async function upgradeDsh(trigger, spec) {
  if (upgrading) {
    logger.appendLog('[升级] 已有升级进行中，忽略重复触发（' + trigger + '）');
    return { ok: false, error: 'upgrade-in-progress' };
  }
  upgrading = true;
  const wasRunning = launcher.running;
  // v1.9.3（2026-09-29 实测竞态）：启动流程也会调 startService()，它与本函数的 npm install
  // 抢跑会导致"装完却跑着旧版"。现在启动流程在 upgrading 期间让位（见 startService 的守卫），
  // 因此这里必须把"本次是启动自动触发"也视为**应当拉起服务**，否则升级完成后没人拉服务。
  const shouldRunAfter = wasRunning || trigger === '启动自动';
  try {
    const before = launcher.found ? launcher.found.version : '(未安装)';
    logger.appendLog('[升级] 开始自动升级 dsh（' + trigger + '，当前 ' + before + '）…');
    state.update({ phase: '正在升级 dsh…（先停止服务，完成后自动重启）' });

    // 1) 停止服务（运行中的 bin.js 被替换会 EBUSY）
    if (wasRunning) {
      await launcher.stop();
      logger.appendLog('[升级] 已停止 dsh web 服务');
      await sleep(500);   // 释放文件句柄的短暂缓冲
    }

    // 2) 执行 npm 全局安装（v1.5.17：内嵌运行时模式装到便携前缀 data\node-global，
    //    绿色随程序走；升级即同前缀替换，dsh 的 ~/.dsh 配置/会话不受影响）
    const prefix = launcher.nodeInfo && launcher.nodeInfo.embedded ? launcher.portablePrefix() : null;
    const r = await updater.performUpgrade({
      nodeInfo: launcher.nodeInfo || { exe: 'node', env: {}, embedded: false },
      prefix,
      spec,   // v1.9.2：多标签取高者判定的确切版本；缺省回退到标签形态
      onProgress: (line) => logger.appendLog('[npm] ' + line),
    });
    if (!r.ok) {
      logger.appendLog('[升级] 安装失败：' + r.output.slice(-600));
      state.update({ phase: 'dsh 升级失败（详见日志），可手动执行: '
        + (spec ? 'npm i -g ' + spec : dshTag.dshUpgradeCommand()) });
      // 失败回退：原本在跑、或本次是启动自动触发 → 拉起服务（让位期间没人拉）
      if (shouldRunAfter) { await startService(); }
      return { ok: false, error: r.output.slice(-300) };
    }

    // 3) 刷新检测结果并验证新版本
    launcher.detect();
    const after = launcher.found ? launcher.found.version : null;
    logger.appendLog('[升级] 安装完成，检测到 dsh ' + (after || '(未找到)'));
    if (!after) {
      logger.appendLog('[升级] 警告：安装后未检测到 dsh（可能装到了非扫描路径）');
      state.update({ phase: 'dsh 升级完成但未检测到安装（详见日志）' });
      return { ok: false, error: 'installed but not detected' };
    }
    state.update({ dshVersion: after });

    // 4) 拉起服务：原本在跑 → 重启；启动自动触发 → 也要拉起（启动流程已让位）
    if (shouldRunAfter) {
      logger.appendLog('[升级] ' + (wasRunning ? '重启' : '启动') + ' dsh web 服务…（确保运行的是刚装好的 '
        + after + '，避免安装窗口内抢跑选中旧版）');
      await startService();
    } else {
      state.update({ phase: 'dsh 已升级到 ' + after });
    }
    logger.appendLog('[升级] 完成：' + before + ' → ' + after);
    return { ok: true, from: before, to: after };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.appendLog('[升级] 异常：' + msg);
    if (shouldRunAfter) { try { await startService(); } catch (_) { /* 忽略 */ } }
    return { ok: false, error: msg };
  } finally {
    upgrading = false;
  }
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
  // 启动计时收尾（2026-09-11）：dsh 从"被拉起"到打印就绪行耗时；超过 25s 时附上它的
  // stdout 末尾若干行（插件加载/pnpm 同步/网络等待都能看出来）
  if (serviceBootStartAt) {
    const bootMs = Date.now() - serviceBootStartAt;
    serviceBootStartAt = 0;
    logger.appendLog('[启动计时] dsh 就绪耗时 ' + bootMs + 'ms');
    if (bootMs > 25000) logSlowBootDetails(bootMs);
  }
  // R25（审计修复）：成功启动复位看门狗单发闸（否则同进程内第二次故障被闸吞掉）
  if (watchdog) watchdog.triggered = false;
  // v1.7.0：服务就绪后确保默认插件已安装（含首次启动才完成 dsh 安装的场景）
  // v1.7.7：其后再刷新插件迁移快照（此时 profile 必然已生成）
  ensureDefaultPlugins('服务就绪')
    .then(() => capturePluginSnapshotNow('服务就绪'))
    .catch(() => { /* 内部已记录 */ });
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
  // v1.9.0：走统一入口（先换 cookie 再加载，失败自动回退带令牌 URL）
  if (mainWindow) loadWebUI(mainWindow);
}

function onBootTimeout() {
  launcher.stop();
  logger.appendLog('服务启动超时（端口无响应），进入恢复流程。');
  watchdog.tryRecover();
}

// ---------------- 看门狗事件 ----------------
function wireLauncher() {
  launcher.on('url', () => onReady());
  // 2026-09-14 事故修复：dsh 不接受 --patch（安全模式补丁层）时，退出安全模式并立刻重试——
  // 否则每次启动都会带这个未知选项、永远停在"安全模式启动失败"，用户再也起不来服务。
  launcher.on('patch-unsupported', () => {
    try {
      if (settings && settings.data.safeMode) {
        settings.update({ safeMode: false, safeModeLevel: 0, safeModeNames: '' });
        logger.appendLog('[安全模式] 当前 dsh 版本不支持 --patch 补丁层——已自动退出安全模式并重试正常启动');
      } else {
        logger.appendLog('[安全模式] 当前 dsh 版本不支持 --patch 补丁层（本次未处于安全模式，忽略）');
      }
      // 让看门狗别把这次"标志不支持"误判成插件故障
      if (watchdog) watchdog.triggered = false;
    } catch (err) {
      logger.appendLog('[安全模式] 退出安全模式失败：' + (err && err.message ? err.message : err));
    }
    setTimeout(() => {
      if (launcher && !launcher.running && !launcher.manualStop) {
        startService().catch(() => { /* 内部已记录 */ });
      }
    }, 300);
  });
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
    // v1.9.0：dsh 服务**非用户主动**退出即固化现场（含"启动失败"与"就绪后崩溃"两种）。
    // 看门狗随后可能自动恢复，但恢复成功与否正是事后要判断的事——现场必须留下。
    try {
      const ctx = crashContext();
      ctx.phase = wasReady ? 'dsh 服务就绪后意外退出' : 'dsh 服务启动失败（未就绪即退出）';
      crashReport.record('web', null, ctx);
    } catch (_) { /* 忽略 */ }
    if (!wasReady) {
      // 未就绪即退出 → 看门狗（插件故障自动隔离）
      watchdog.tryRecover();
    } else if (state.service === 'ready' || state.service === 'safe') {
      state.update({ service: 'stopped', phase: 'dsh 服务已停止（退出码 ' + code + '）' });
    }
  });
}

// ---------------- IPC ----------------

// ---------------- IPC 来源守卫（审计 P0） ----------------
// 主窗口会从 renderer/status.html（本地 file://）导航到 dsh web 页面
// （http://127.0.0.1:<port>，第三方插件的客户端脚本在同一页面执行），preload 桥对两者
// 都可见。壳级通道（读网关配置＝全部供应商明文 Key / 改写网关配置 / 安装插件 /
// 改设置 / 升级）**只应服务本地渲染页**，否则页面内任意脚本即可导出密钥并落地命令。
// 判定三条同时成立：① 来源是主框架（排除被注入的 iframe）；② file:// 协议；
// ③ 路径是本应用的 renderer/*.html。
function fromLocalPage(event) {
  try {
    const frame = event && event.senderFrame;
    if (!frame) return false;
    const sender = event.sender;
    if (sender && sender.mainFrame && frame !== sender.mainFrame) return false;
    // P0-1 修复：旧实现是 `/\/renderer\/[A-Za-z0-9._-]+\.html$/i.test(u)`——只看后缀形态，
    // 任意磁盘位置的 `…\renderer\x.html` 都能通过。改为真实路径前缀比较（isAppRendererPage）。
    return isAppRendererPage(frame.url);
  } catch (_) {
    return false;   // senderFrame 已销毁时取属性会抛错 → 视为非本地
  }
}

function registerIpc() {
  // 统一入口：所有壳级 IPC 都经此注册（新增通道自动获得来源校验）
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!fromLocalPage(event)) {
      logger.appendLog('[安全] 已拒绝非本地页面对 IPC ' + channel + ' 的调用');
      return { ok: false, error: 'forbidden-origin' };
    }
    return fn(event, ...args);
  });
  // 主窗口（dsh web 页面）经 preload.js 的 __dshAppIh 单向上报输入框状态：只更新镜像，不返回数据
  ipcMain.on('dsh:ih-state', (event, s) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
      // P1（第二轮审计修复）：必须是**主框架**。旧实现只校验 sender，页面内的 iframe
      //（dsh 页面里跑着第三方插件渲染的内容）同样能上报，从而污染输入框镜像——
      // 表现为 ↑ 键被劫持、输入内容被替换成别的文本。与 fromLocalPage 的校验保持一致。
      if (event.senderFrame && event.sender.mainFrame
        && event.senderFrame !== event.sender.mainFrame) return;
      const input = (s && s.input && typeof s.input === 'object' && typeof s.input.val === 'string')
        ? { val: s.input.val.slice(0, 100000), atTop: !!s.input.atTop, tag: String(s.input.tag || '') }
        : null;
      ihMirror = input;
      const sid = (s && typeof s.sid === 'string') ? s.sid.slice(0, 80) : '';
      if (sid && sid !== ihSid) {
        // 会话库校验：不因为一个"查不到"的候选 id 丢掉已确认的会话
        let ids = knownSessionIds();
        // P1：未知 id 可能是**刚新建的会话**（缓存 60 秒未刷新）→ 强制刷新一次再判，
        // 否则新会话开头的历史会被错误归到上一个会话桶。
        if (!ids.has(sid)) { ids = knownSessionIds(true); }
        if (!ids.has(sid) && ihSid && ids.has(ihSid)) return;
        ihSid = sid;
        // 会话 id 刚学到：把"提交时还不知道会话"的那条历史补记到正确的会话桶，并迁移旧历史
        try { if (typeof ihSessionHook === 'function') ihSessionHook(sid); } catch (_) { /* 忽略 */ }
      }
    } catch (_) { /* 忽略 */ }
  });
  handle('dsh:state', () => state.snapshot());
  handle('dsh:settings', () => settings.data);
  handle('dsh:save-settings', (_e, patch) => {
    settings.update(patch);
    // P0-3 修复：端口同步读**落盘后的权威值**（settings.data.port）。
    // 旧版用未校验的 `patch.port` 直接赋给 state.port，而 settings.update 内部会把非法端口
    // 回退成 3080 → state.port 与 settings.data.port 分叉，导航白名单、托盘提示、探活目标
    // 全部指向一个并不存在的端口。
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'port')) {
      state.update({ port: settings.data.port });
    }
    // 开机自启（Windows/macOS 均支持）
    try {
      app.setLoginItemSettings({ openAtLogin: !!settings.data.autoStart, args: ['--autostart'] });
    } catch (_) { /* 忽略 */ }
    broadcast();
    return settings.data;
  });
  handle('dsh:action', async (_e, name) => {
    switch (name) {
      case 'start': await startService(); break;
      case 'stop': await stopService(); break;
      case 'retry': await startService(); break;
      case 'exit-safe': await watchdog.exitSafeMode(); break;
      case 'open-logs':
        shell.openPath(logger.logDirPath() || os.homedir()).catch(() => { /* 忽略 */ });
        break;
      case 'open-browser':
        shell.openExternal(state.authUrl || 'http://127.0.0.1:' + state.port + '/').catch(() => { /* 忽略 */ });
        break;
      case 'open-settings': {
        // 支持 "open-settings::<section>" 形式定位到具体卡片（如 gateway）
        const section = (name.indexOf('::') >= 0) ? name.split('::')[1] : '';
        createSettingsWindow(section);
        break;
      }
      case 'focus':
        ensureMainWindow();
        break;
      case 'copy-upgrade-command':
        clipboard.writeText(dshTag.dshUpgradeCommand());
        break;
      case 'upgrade-dsh':
        return await upgradeDsh('手动');
      case 'install-default-plugins': {
        // v1.7.0：重新安装/修复随 app 分发的默认插件（含 vendor 刷新与依赖声明）
        const found = launcher && launcher.found;
        if (!found) return { ok: false, action: 'skip', message: '未检测到 dsh' };
        const r = await installDefaultPlugins({
          hostDshDir: found.dir,
          nodeInfo: launcher.nodeInfo || { exe: 'node', env: {}, embedded: false },
          profile: 'web', logger,
        });
        defaultPluginsDone = r.ok === true;
        logger.appendLog('[默认插件] 手动安装：' + r.action + '：' + r.message);
        broadcast();
        return r;
      }
      case 'browse-workdir': {
        const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (!r.canceled && r.filePaths.length) return r.filePaths[0];
        return null;   // R25（审计修复）：取消返回 null——旧版 break→true，渲染层把 "true" 填进输入框
      }
      default: break;
    }
    broadcast();
    return true;
  });
  handle('dsh:versions', async () => {
    const local = launcher.found ? launcher.found.version : null;
    const info = await updater.checkForUpdate(local);
    return { local, update: info };
  });
  // —— 模型网关 ——
  handle('gw:state', () => {
    const s = gateway.getState();
    return Object.assign({}, s, { log: gateway.logTailText(8000) });
  });
  handle('gw:action', async (_e, name, payload) => {
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
  // —— 插件市场（v1.5.18，参考官方 dsh-community-market 架构）——
  // 安全边界照搬官方：源数据只用于发现（源版本不作安装目标）；安装预览必须通过
  // npm registry 元数据校验（同名+稳定版+有效 dsh.bundle.patch）；安装/卸载统一走
  // 标准 dsh CLI（与手工命令一致——市场/CLI/手工三途径互通，已安装视图读 dsh 真实
  // profile 状态，天然兼容自行安装的插件）。
  handle('mk:discover', async (_e, payload) => {
    const p = payload || {};
    return await market.discover(String(p.sourceId || ''), String(p.q || ''), String(p.category || ''), p.cursor || '', Number(p.limit) || 50);
  });
  handle('mk:preview', async (_e, pkgName) => {
    return await market.npmPreview(String(pkgName || ''));
  });
  handle('mk:installed', () => {
    return market.installedPlugins();
  });
  handle('mk:action', async (_e, name, pkgName) => {
    if (!marketOps) marketOps = new market.MarketOps({
      nodeInfo: launcher.nodeInfo || { exe: 'node', env: {}, embedded: false },
      dshBin: launcher.found ? launcher.found.bin : null,
      log: (s) => logger.appendLog('[市场] ' + s),
    });
    const onLine = (line) => { logger.appendLog('[dsh plugin] ' + line); };
    if (name === 'install') {
      const r = await marketOps.install(String(pkgName || ''), onLine);
      logger.appendLog(r.ok ? '[市场] 安装成功：' + pkgName + '（重启 dsh 服务后生效）' : '[市场] 安装失败：' + pkgName);
      return r;
    }
    if (name === 'remove') {
      const r = await marketOps.remove(String(pkgName || ''), onLine);
      logger.appendLog(r.ok ? '[市场] 卸载成功：' + pkgName + '（重启 dsh 服务后生效）' : '[市场] 卸载失败：' + pkgName);
      // 审计高-1：卸载的是随 app 分发的默认插件 → 同步关闭「默认插件安装」，
      // 否则下次进程启动会被 ensure 静默重装（卸载被回滚）
      if (r.ok && String(pkgName || '') === 'dsh-email-bridge' && settings) {
        settings.update({ installDefaultPlugins: false });
        defaultPluginsDone = true;
        logger.appendLog('[默认插件] 用户卸载了默认插件——已关闭「默认插件安装」设置（不再自动重装）');
      }
      return r;
    }
    return { ok: false, error: 'unknown-action' };
  });
  // 复制文本到剪贴板（设置页"复制"按钮等）
  handle('dsh:clipboard', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  });
}

// ---------------- 生命周期 ----------------

let forceQuit = false;
let quitConfirming = false;   // 确认框已弹出：重复的退出请求应"加入"而不是叠第二个框

// v1.9.0：退出前任务确认。
// 官方 desktop 直接问 Host"这次退出会打断什么"（私有 IPC，2 秒不应答按有任务算）；
// DSH-App 与 dsh 之间只有 stdout 就绪行 + HTTP 两个稳定契约，没有这条通道，
// 因此改用旁路可观测信号（会话状态写入 + 网关流量）。判定与措辞的取舍见 quit-guard.js。
function quitAll(confirmed) {
  if (!confirmed) {
    // 用户可在设置里关掉这项确认；函数式取用，避免设置尚未加载时读到 undefined
    if (settings && settings.data && settings.data.confirmQuitWhenBusy === false) { quitAll(true); return; }
    if (quitConfirming) return;   // 已有确认框在等：本次请求并入那一次
    let verdict;
    try {
      verdict = quitGuard.assess({ gatewayLastActivityAt: gateway ? gateway.lastActivityAt : 0 });
    } catch (err) {
      // 判定本身失败不该把用户锁在应用里：放行并留痕
      logger.appendLog('[退出确认] 活动判定失败，按直接退出处理：' + (err && err.message ? err.message : err));
      quitAll(true);
      return;
    }
    if (!verdict.busy) { quitAll(true); return; }
    quitConfirming = true;
    logger.appendLog('[退出确认] 检测到近期活动（' + verdict.signals.map((s) => s.detail).join('；') + '），等待用户确认');
    quitGuard.confirm(dialog, mainWindow, verdict, (m) => logger.appendLog(m))
      .then((ok) => {
        quitConfirming = false;
        if (ok) quitAll(true);
        else logger.appendLog('[退出确认] 用户取消退出，任务继续。');
      })
      .catch((err) => {
        quitConfirming = false;
        logger.appendLog('[退出确认] 确认流程异常，按确认退出：' + (err && err.message ? err.message : err));
        quitAll(true);
      });
    return;
  }
  forceQuit = true;
  const stopAll = async () => {
    // R18（退出全清）：正常停网关 + dsh 主进程后，再全局清理所有 dsh 相关进程树
    // （孙进程/broker/plugin 操作树——此前退出后残留 node 进程、旧实例 dsh web 占用
    // 3080、黑窗进程等都是这里漏掉的）。特征匹配足够特异，不影响系统终端手工跑的 dsh。
    if (gateway) { gateway.stopping = true; await gateway.stop(); }
    await launcher.stop();
    try {
      const { killAllDshProcesses } = require('./gateway-manager');
      // R25：限定本应用数据目录（broker/网关 --config 都在其下）——不再用裸特征误杀
      // 用户手工跑的 dsh / 桌面助手网关
      // 审计修复（P2）：killAllDshProcesses 已改异步（旧版 spawnSync 会让退出流程卡住
      // 最多 3×15 秒，界面在此期间完全无响应）
      const n = await killAllDshProcesses((s) => logger.appendLog(s), gateway ? gateway.userDataDir : undefined);
      if (n > 0) logger.appendLog('退出清理：共清理 ' + n + ' 个 dsh 相关进程树。');
    } catch (e) {
      logger.appendLog('退出清理异常: ' + (e && e.message ? e.message : e));
    }
    // 第三轮审计修复：把 web.log 的**暂存半行**落盘后再退出。
    // logger.appendWeb 只在见到 \n 时才立即落盘，未带换行的最后一段暂存在内存里（等 250ms 定时器）；
    // 而退出流程会直接 app.quit() —— 那一段往往正是子进程的最后遗言（崩溃原因），却因此丢失。
    // 启动侧（launcher.start）早有同款 flush，退出侧此前漏了。
    try { logger.flushWebNow(); } catch (_) { /* 忽略 */ }
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
    ensureMainWindow();
  });

  // 数据目录：exe 旁 data\ 优先（绿色便携，随程序目录走）；不可写才回退 %APPDATA%
  const userData = resolveDataDir();
  APP_USERDATA = userData;   // 供输入历史等模块持久化
  logger.init(userData);
  // 审计修复（P2）：单文件便携版会解包到**系统临时目录**运行，而数据目录按"exe 旁"定位
  // → data\ 落在临时目录里，系统清理后配置/历史/密钥全丢（用户毫无察觉）。这里显式告警。
  let dataDirInTemp = false;
  try {
    const t = path.resolve(os.tmpdir()).toLowerCase();
    dataDirInTemp = path.resolve(userData).toLowerCase().startsWith(t);
  } catch (_) { /* 忽略 */ }
  if (dataDirInTemp) {
    logger.appendLog('[警告] 数据目录位于系统临时目录（' + userData + '）：这是单文件便携版的运行时行为，'
      + '系统清理临时文件后配置/会话历史/供应商密钥会丢失。建议改用绿色目录版，或设置环境变量 '
      + 'DSH_DATA_DIR=<固定目录>。');
  }
  // v1.9.0：崩溃报告目录与滚动日志同处（一切随绿色目录走，换机可整体拷走）。
  // 清理放在启动路径而不是错误路径上——崩溃时不该再去做删文件这种事。
  crashReport.init(logger.logDirPath());
  const prunedCrashes = crashReport.prune();
  if (prunedCrashes > 0) {
    logger.appendLog('已清理 ' + prunedCrashes + ' 份旧崩溃报告（保留最近 ' + crashReport.MAX_KEEP + ' 份）');
  }

  // 第三轮审计修复：会话权限显式收紧（此前全仓库没有任何权限处理器）。
  // 主窗口既加载本地状态页、也加载 dsh web 页面（页面里跑着第三方插件的客户端脚本），
  // 无处理器时 Electron 对部分权限的默认行为随版本而异（有些默认放行）。
  //
  // 名单是**实测得出**的，不是照抄通用建议：
  //   · 拒绝：经 grep 全量 dsh 客户端产物确认**没有任何使用点**的敏感权限
  //     （geolocation / hid / serial / usb / midi / display-capture / idle-detection /
  //       local-fonts / speaker-selection / window-management / storage-access）；
  //   · **故意放行** clipboard-read 与 media —— dsh 真的在用：
  //     `dsh-client-ui-sidebar-terminal` / `…-documentpreview` 调 `clipboard.readText`（粘贴），
  //     `dsh-experimental-client-ui-voice-input` 调 `getUserMedia`（语音输入）。
  //     按"通用最佳实践"一律拒绝会直接弄坏这两个功能。
  try {
    const DENY_PERMISSIONS = new Set([
      'geolocation', 'hid', 'serial', 'usb', 'midi', 'midiSysex',
      'display-capture', 'idle-detection', 'local-fonts', 'speaker-selection',
      'window-management', 'storage-access', 'top-level-storage-access',
    ]);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(!DENY_PERMISSIONS.has(String(permission)));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => (
      !DENY_PERMISSIONS.has(String(permission))
    ));
  } catch (err) {
    logger.appendLog('[安全] 权限处理器注册失败（不影响启动）：' + (err && err.message ? err.message : err));
  }
  // R22：兜底未捕获异常/Promise 拒绝——主进程缺 handler 时 Node 默认直接 throw，
  // 用户操作路径上偶发的 openExternal/加载失败即可带崩整个壳
  // v1.9.0：除 app.log 的一行流水外，另固化一份完整现场（logs\crash-*.log）。app.log
  // 是 1MB 轮转的流水，事故现场会被后续输出冲掉；而绿色目录换机后用户往往只剩日志可查。
  process.on('unhandledRejection', (reason) => {
    try { logger.appendLog('[未处理 Promise 拒绝] ' + ((reason && (reason.stack || reason.message)) || reason)); } catch (_) { /* 忽略 */ }
    try { crashReport.record('main', reason, crashContext()); } catch (_) { /* 忽略 */ }
  });
  process.on('uncaughtException', (err) => {
    try { logger.appendLog('[未捕获异常] ' + ((err && err.stack) || err)); } catch (_) { /* 忽略 */ }
    try { crashReport.record('main', err, crashContext()); } catch (_) { /* 忽略 */ }
  });
  settings = new Settings(userData);
  settings.load();

  state = new AppState();
  state.port = settings.data.port;
  // 状态变更推送到窗口（全局注册一次——createMainWindow 可能因 ensureMainWindow
  // 多次重建窗口，监听器不能跟着窗口重复注册）
  state.on('changed', () => broadcast());

  const workDir = settings.data.workDir || os.homedir();
  launcher = new Launcher({ settings, logger, workDir });
  // 启动探明 dsh 版本与 node 路径（仅读包信息，不启动服务）；
  // 放在网关创建之前，让网关复用真实的 node 路径
  launcher.detect();
  // v1.9.0：每次启动幂等确保「应用根目录\node.exe」存在。
  // 它是内嵌运行时的 PATH 入口——launcher.prepareEmbeddedInstallEnv 在 exe 旁建硬链接，
  // 因为 dsh 的原生依赖（koffi/node-pty）postinstall 直接调 `node`，而本机没有系统 Node.js。
  // 该文件此前**只在安装/升级 dsh 时**才会被创建，于是 build-portable / build-uat 的
  // `rmSync(appDir)`（只备份 data\）之后它不会自动恢复：表现为 PATH 上的 `node` 突然消失，
  // 后续任何依赖它的命令都失败（2026-09-25 实际发生，根因排查花了较久）。
  // 已存在时零开销（一次 existsSync）；缺失时硬链接（同盘零拷贝），失败才回退复制。
  try {
    const ensured = require('./launcher').prepareEmbeddedInstallEnv(null, process.env);
    if (ensured && ensured.nodeExe) {
      logger.appendLog('内嵌运行时入口就绪：' + ensured.nodeExe);
    } else {
      logger.appendLog('[警告] 未能准备内嵌 node.exe —— dsh 原生依赖的安装/postinstall 可能失败'
        + '（可从 DSH-App.exe 手工硬链接一份为 node.exe）');
    }
  } catch (err) {
    logger.appendLog('[警告] 准备内嵌 node.exe 异常：' + (err && err.message ? err.message : err));
  }
  watchdog = new Watchdog({ settings, launcher, state, logger, workDir });
  gateway = new GatewayManager({
    userDataDir: userData,
    nodePath: launcher.nodePath || 'node',
    nodeEnv: (launcher.nodeInfo && launcher.nodeInfo.env) || {},   // v1.5.17：内嵌运行时需 ELECTRON_RUN_AS_NODE=1
    settings,
    logger,
  });
  gateway.init();
  // v1.8.3：换机首启适配——必须在网关启动之前完成（网关只在启动时读一次配置）。
  // 放在 gateway.init() 之后，确保"首次无配置时从示例生成"的那份也已存在。
  // 幂等：同一台机器只做一次，正常启动只是一次小文件读取，无额外等待。
  await adaptGatewayForMachineBeforeStart();
  // 网关状态变化 → 推送给设置窗（若打开）
  gateway.on('state', () => broadcastGw());
  // 逐请求日志（pushLog 内 800ms 节流 emit）→ 也推送给设置窗，日志框才能实时跟随
  gateway.on('log', () => broadcastGw());
  registerIpc();
  wireLauncher();

  tray = new TrayController({
    getState: () => state.snapshot(),
    // 审计修复（P3）：托盘气泡只在首次运行提示一次（旧版每次启动都弹）
    shouldBalloon: () => !!(settings && !settings.data.trayBalloonShown),
    onBalloon: () => { try { settings.update({ trayBalloonShown: true }); } catch (_) { /* 忽略 */ } },
    actions: {
      showMain: ensureMainWindow,
      start: startService,
      stop: stopService,
      openBrowser: () => shell.openExternal(state.authUrl || 'http://127.0.0.1:' + state.port + '/').catch(() => { /* 忽略 */ }),
      openSettings: (section) => createSettingsWindow(section),
      openGateway: () => createSettingsWindow('gateway'),
      openMarket: () => createSettingsWindow('market'),   // v1.5.18：托盘直达插件市场
      restartGateway: async () => {
        // 托盘「重启网关」：先杀网关进程再启动（restart 已实现先杀后启 + 清熔断）
        if (!gateway) return;
        try {
          await gateway.restart();
          logger.appendLog('模型网关：已通过托盘菜单重启。');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('dsh:state', state.snapshot());
          }
        } catch (err) {
          logger.appendLog('模型网关重启失败: ' + (err && err.message ? err.message : err));
        }
      },
      openLogs: () => shell.openPath(logger.logDirPath() || os.homedir()).catch(() => { /* 忽略 */ }),
      quit: quitAll,
    },
  });
  tray.create();

  createMainWindow();
  if (settings.data.minimizeToTray) tray.refresh(state.snapshot());
  // 临时数据目录 → 在状态页给出常驻提示（用户最需要知道的"数据会丢"风险）
  if (dataDirInTemp && !state.authUrl) {
    state.update({ phase: '注意：数据目录在系统临时目录（' + userData + '）——清理临时文件会丢失配置与密钥；请改用绿色目录版或设置 DSH_DATA_DIR' });
  }

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
    // v1.9.1：共用 dsh home 的版本守卫（多实例跑不同 dsh 版本会互相改坏 settings/会话索引）
    dshHomeGuard.checkAndRecord({
      dshVersion: launcher.found.version,
      dataDir: APP_USERDATA,
      log: (s) => logger.appendLog(s),
    });
    ensureDefaultPlugins('启动检测后').catch(() => { /* 内部已记录 */ });   // v1.7.0：默认插件随 app 分发
    if (settings.data.checkUpdates) {
      // v1.5.17：开启"启动时检查更新"→ 检测到新版**自动升级**（停服→npm i -g→重启）
      // v1.9.2：不再"只跟 latest"，而是**同时评估全部候选标签（latest + next）取版本最高者**。
      //   起因（2026-09-29 用户反馈"0.2.0-rc1 已发布，启动时为什么没有自动更新"）：
      //   `latest` 追平到 0.1.7-rc.2 的同时 `next` 前进到 0.2.0-rc.1，只查 latest 的实现
      //   永远看不到它——检查确实跑了，结论却是"无需升级"，用户无从分辨。
      updater.evaluate(launcher.found.version).then((r) => {
        // 把每个候选标签各自的查询结果写成一行，便于事后核对"到底比了什么"
        const detail = r.tags.map((t) => t.tag + '=' + (t.version || '查询失败')).join(' / ');
        const mirror = '镜像 ' + dshTag.dshRegistry();
        if (r.needed) {
          logger.appendLog('发现新版本 dsh ' + r.best.version + '（当前 ' + r.local + '，来自标签 '
            + r.best.tag + '），开始自动升级…（已比较 ' + detail + '；' + mirror + '）');
          state.update({ phase: '发现新版本 dsh ' + r.best.version + '，自动升级中…' });
          // 传**确切版本**而不是标签名：检查与安装之间标签可能被上游移动
          upgradeDsh('启动自动', r.spec).then((res) => {
            if (res && res.ok) {
              logger.appendLog('自动升级成功：' + res.from + ' → ' + res.to);
            } else {
              logger.appendLog('自动升级失败，可手动执行: ' + r.command);
            }
          });
        } else if (r.best) {
          // 无需升级也要写清楚比过哪些标签（v1.9.1 起的可观测性要求）
          logger.appendLog('[启动更新] 当前 dsh ' + r.local + ' 已是候选通道中的最高版本'
            + '（已比较 ' + detail + '；' + mirror + '），无需升级');
        } else {
          logger.appendLog('[启动更新] 所有候选标签均查询失败（已比较 ' + detail + '；' + mirror
            + '）—— 无法判断是否有新版本，不影响启动');
        }
      }).catch((err) => {
        logger.appendLog('[启动更新] 检查失败（不影响启动）：' + (err && err.message ? err.message : err));
      });
    } else {
      logger.appendLog('[启动更新] 设置里「启动时检查更新」为关闭 —— 跳过版本检查');
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