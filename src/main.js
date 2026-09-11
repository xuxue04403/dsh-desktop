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
const market = require('./market');   // v1.5.18 插件市场（1024Store + npm 校验 + dsh CLI）
const { installDefaultPlugins, verifyDefaultPlugins } = require('./default-plugins');   // v1.7.0 随 app 分发的默认插件（B1 修复：漏导入 verifyDefaultPlugins 曾使启动前自检静默失效）
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
  // 审计修复（P2）：渲染进程崩溃/无响应时，旧版窗口会永久白屏或假死，用户没有任何恢复
  // 入口（只能杀进程）。崩溃 → 回到本地状态页并给出提示（状态页有「重新启动」按钮）。
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    const reason = (details && details.reason) || 'unknown';
    logger.appendLog('界面渲染进程异常退出：' + reason + '（exitCode ' + ((details && details.exitCode) || 0) + '）');
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
    if (launcher && launcher.ready && launcher.authUrl && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(launcher.authUrl).catch((err) => {
        logger.appendLog('加载界面失败: ' + (err && err.message ? err.message : err));
      });
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
function knownSessionIds() {
  const now = Date.now();
  if (now - sessionIdCache.at < 60000) return sessionIdCache.ids;
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
    if (url.startsWith('file://')) return;
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
  return runServiceOp('启动', async () => {
    readyHandled = false;
    state.update({ service: 'starting', phase: '正在启动 dsh 服务…', failReason: '' });
    await launcher.stop();
    launcher.detect();
    // R24：启动 dsh 前自检默认插件（挂载条目 ⇒ 包可解析；不一致自动修复，防悬空条目启动失败）
    await verifyDefaultPluginsBeforeStart();
    launcher.start();
    // 就绪等待由 'url'/'exit' 事件驱动；这里额外启动端口轮询兜底
    waitReadyByProbe();
  });
}

async function stopService() {
  return runServiceOp('停止', async () => {
    state.update({ service: 'stopped', phase: '服务未运行' });
    await launcher.stop();
  });
}

// ---------------- dsh 自动升级（v1.5.17）----------------
// 流程：停服（防 Windows 文件占用）→ npm i -g @deepseek-ai/dsh@latest → detect 刷新版本 →
// 若之前在运行则重启服务。任何失败都写日志并回退提示手动命令。
let upgrading = false;   // 升级互斥（自动触发与手动按钮并发保护）

async function upgradeDsh(trigger) {
  if (upgrading) {
    logger.appendLog('[升级] 已有升级进行中，忽略重复触发（' + trigger + '）');
    return { ok: false, error: 'upgrade-in-progress' };
  }
  upgrading = true;
  const wasRunning = launcher.running;
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
      onProgress: (line) => logger.appendLog('[npm] ' + line),
    });
    if (!r.ok) {
      logger.appendLog('[升级] 安装失败：' + r.output.slice(-600));
      state.update({ phase: 'dsh 升级失败（详见日志），可手动执行: npm i -g @deepseek-ai/dsh@latest' });
      // 失败回退：若之前在运行，重启旧版继续可用
      if (wasRunning) { await startService(); }
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

    // 4) 之前在运行 → 重启服务
    if (wasRunning) {
      logger.appendLog('[升级] 重启 dsh web 服务…');
      await startService();
    } else {
      state.update({ phase: 'dsh 已升级到 ' + after });
    }
    logger.appendLog('[升级] 完成：' + before + ' → ' + after);
    return { ok: true, from: before, to: after };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logger.appendLog('[升级] 异常：' + msg);
    if (wasRunning) { try { await startService(); } catch (_) { /* 忽略 */ } }
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
  // R25（审计修复）：成功启动复位看门狗单发闸（否则同进程内第二次故障被闸吞掉）
  if (watchdog) watchdog.triggered = false;
  // v1.7.0：服务就绪后确保默认插件已安装（含首次启动才完成 dsh 安装的场景）
  ensureDefaultPlugins('服务就绪').catch(() => { /* 内部已记录 */ });
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
    const u = String(frame.url || '');
    if (!u.startsWith('file://')) return false;
    return /\/renderer\/[A-Za-z0-9._-]+\.html$/i.test(u);
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
      const input = (s && s.input && typeof s.input === 'object' && typeof s.input.val === 'string')
        ? { val: s.input.val.slice(0, 100000), atTop: !!s.input.atTop, tag: String(s.input.tag || '') }
        : null;
      ihMirror = input;
      const sid = (s && typeof s.sid === 'string') ? s.sid.slice(0, 80) : '';
      if (sid && sid !== ihSid) {
        // 会话库校验：不因为一个"查不到"的候选 id 丢掉已确认的会话
        const ids = knownSessionIds();
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
        clipboard.writeText('npm i -g @deepseek-ai/dsh@latest');
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

function quitAll() {
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
  // R22：兜底未捕获异常/Promise 拒绝——主进程缺 handler 时 Node 默认直接 throw，
  // 用户操作路径上偶发的 openExternal/加载失败即可带崩整个壳
  process.on('unhandledRejection', (reason) => {
    try { logger.appendLog('[未处理 Promise 拒绝] ' + ((reason && (reason.stack || reason.message)) || reason)); } catch (_) { /* 忽略 */ }
  });
  process.on('uncaughtException', (err) => {
    try { logger.appendLog('[未捕获异常] ' + ((err && err.stack) || err)); } catch (_) { /* 忽略 */ }
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
  watchdog = new Watchdog({ settings, launcher, state, logger, workDir });
  gateway = new GatewayManager({
    userDataDir: userData,
    nodePath: launcher.nodePath || 'node',
    nodeEnv: (launcher.nodeInfo && launcher.nodeInfo.env) || {},   // v1.5.17：内嵌运行时需 ELECTRON_RUN_AS_NODE=1
    settings,
    logger,
  });
  gateway.init();
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
    ensureDefaultPlugins('启动检测后').catch(() => { /* 内部已记录 */ });   // v1.7.0：默认插件随 app 分发
    if (settings.data.checkUpdates) {
      // v1.5.17：开启"启动时检查更新"→ 检测到新版**自动升级**（停服→npm i -g→重启）
      updater.checkForUpdate(launcher.found.version).then((info) => {
        if (info) {
          logger.appendLog('发现新版本 dsh ' + info.latest + '（当前 ' + info.local + '），开始自动升级…');
          state.update({ phase: '发现新版本 dsh ' + info.latest + '，自动升级中…' });
          upgradeDsh('启动自动').then((r) => {
            if (r && r.ok) {
              logger.appendLog('自动升级成功：' + r.from + ' → ' + r.to);
            } else {
              logger.appendLog('自动升级失败，可手动执行: npm i -g @deepseek-ai/dsh@latest');
            }
          });
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