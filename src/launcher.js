// launcher.js — dsh web 进程管理（发现/启动/停止/健康/URL 就绪行解析）
//
// 升级兼容契约（与 dsh 版本无关的稳定面）：
//   1) dsh web --no-open --port <n>            —— 启动参数（0.1.2-rc.1 与 0.1.3-alpha.1 一致）
//   2) stdout 就绪行 "dsh web: http://127.0.0.1:<port>/?token=..."（printUrl 默认 true）
//   3) --patch <yml> 覆盖层（安全模式禁用故障插件）
//   4) 直接 spawn node bin.js（不经 cmd.exe / shim，规避 cmd 引号/参数破坏问题）
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

// dsh web 的 stdout 就绪行
const REGEX_URL_LINE = /dsh web:\s*(https?:\/\/[^\s\)]+)/;
// 等待就绪超时（毫秒）
const READY_TIMEOUT = 90 * 1000;

// semver 版本比较（审计修复）：
// 旧实现按 `[.-]` 切分后逐段比较，把预发布标识当普通段 → `0.1.3-alpha.1` 被判为**高于**
// `0.1.3`（与 semver 相反）：多版本并存时 findDsh 可能选错版本，checkForUpdate 也可能对
// 已是最新的稳定版反复提示升级。现在按 semver 规则：
//   1) 先比 x.y.z 数字段（缺失/非数字按 0）；
//   2) 都有预发布标识 → 逐段比较（数字段 < 字母段；段数少者更小）；
//   3) 只有一方有预发布标识 → **有预发布的那方更小**。
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
    const dash = s.indexOf('-');
    const core = dash >= 0 ? s.slice(0, dash) : s;
    const pre = dash >= 0 ? s.slice(dash + 1) : '';
    return {
      nums: core.split('.').map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : NaN)),
      pre: pre ? pre.split('.') : [],
    };
  };
  const A = parse(a);
  const B = parse(b);
  const n = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(A.nums[i]) ? A.nums[i] : 0;
    const y = Number.isFinite(B.nums[i]) ? B.nums[i] : 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (A.pre.length === 0 && B.pre.length === 0) return 0;
  if (A.pre.length === 0) return 1;    // 正式版 > 预发布版
  if (B.pre.length === 0) return -1;
  const m = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < m; i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xd = /^\d+$/.test(x);
    const yd = /^\d+$/.test(y);
    if (xd && yd) {
      const xi = parseInt(x, 10);
      const yi = parseInt(y, 10);
      if (xi !== yi) return xi > yi ? 1 : -1;
    } else if (xd !== yd) {
      return xd ? -1 : 1;              // 数字标识符优先级低于字母标识符
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

// 定位 node 运行时（v1.5.17 内嵌优先）：
//  1) 打包后的本程序 exe + ELECTRON_RUN_AS_NODE=1 —— Electron 二进制即纯 Node 运行时
//     （零系统依赖：用户机器无需安装 node；运行时版本随应用打包，一致可控）
//  2) 开发模式（未打包，electron 从 node_modules 起）→ 回退系统 node
//  3) 系统 node（nvm-windows / 标准安装 / PATH 兜底）
// 返回 { exe, env }：spawn 时合并 env（内嵌模式需 ELECTRON_RUN_AS_NODE=1）
function findNode() {
  // 打包判定：electron 主进程默认 exe；app.isPackaged 在 main 传入（避免此模块依赖 electron）
  const packaged = !process.defaultApp && process.resourcesPath && process.resourcesPath.endsWith('resources');
  if (packaged) {
    return {
      exe: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      embedded: true,
    };
  }
  // 开发模式：系统 node
  const candidates = [];
  const appData = process.env.APPDATA || '';
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  candidates.push(path.join(pf, 'nodejs', 'node.exe'));
  for (const root of [path.join(appData, 'nvm'), path.join(local, 'nvm')]) {
    try {
      const vers = fs.readdirSync(root)
        .filter((v) => /^v\d/.test(v))
        .sort((x, y) => compareVersions(y.slice(1), x.slice(1)));
      for (const v of vers) candidates.push(path.join(root, v, 'node.exe'));
    } catch (_) { /* 忽略 */ }
  }
  for (const c of candidates) if (fs.existsSync(c)) return { exe: c, env: {}, embedded: false };
  return { exe: 'node', env: {}, embedded: false };
}

// 兼容旧调用（tests 等直接当字符串用）：字符串化处理
function findNodeStr() {
  const n = findNode();
  return typeof n === 'string' ? n : n.exe;
}

// 内嵌 npm-cli.js 定位（v1.5.17）：打包在 resources\node_modules\npm（asar 外的真实文件
// ——ELECTRON_RUN_AS_NODE 子进程读不了 asar 内文件，故 build-portable 放 asar 外）。
// 用途：dsh 首次安装/自动升级（DSH-App.exe 作为 node 跑 npm-cli.js，零系统依赖）。
function findEmbeddedNpmCli() {
  const candidates = [];
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  } catch (_) { /* 忽略 */ }
  // 开发模式：项目内 node_modules
  candidates.push(path.join(__dirname, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* 忽略 */ }
  }
  return null;
}

// v1.5.17a：为安装环境准备"node 可用"的 PATH（关键修复）。
// dsh 的原生依赖（koffi/node-pty）postinstall 脚本直接调 `node`——零依赖机器上
// PATH 没有 node 会失败（'node' 不是内部或外部命令）→ 整个安装失败。
// 方案：把应用 exe 硬链接/复制为「应用根目录」\node.exe（与 DSH-App.exe 同目录——
// Electron 依赖的同目录 DLL 完整；不能放 prefix/data 下——那里无 DLL，启动报
// 0xC0000135 STATUS_DLL_NOT_FOUND），并把应用根目录注入子进程 PATH 头部——
// postinstall 的 `node` 即解析到内嵌运行时。返回 { env }。
function prepareEmbeddedInstallEnv(prefix, baseEnv) {
  const env = Object.assign({}, baseEnv || process.env, { ELECTRON_RUN_AS_NODE: '1' });
  try {
    const appDir = path.dirname(process.execPath);
    const nodeExe = path.join(appDir, 'node.exe');
    if (!fs.existsSync(nodeExe)) {
      try {
        fs.linkSync(process.execPath, nodeExe);         // 硬链接优先（同盘零拷贝）
      } catch (_) {
        fs.copyFileSync(process.execPath, nodeExe);     // 回退复制（同目录，DLL 完整）
      }
    }
    env.PATH = appDir + path.delimiter + (env.PATH || '');
    return { env, nodeExe };
  } catch (_) {
    return { env, nodeExe: null };
  }
}

// 发现已安装的 @deepseek-ai/dsh（npm 全局 / npx 缓存 / 便携前缀），返回版本最高者
// 返回 { dir, version, bin }；无则返回 null
// v1.5.17：新增便携前缀 <exe旁data>\node-global（内嵌运行时方案的安装位置，绿色随程序走）
function findDsh() {
  const candidates = [];
  const local = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const roots = [
    path.join(appData, 'npm', 'node_modules'),             // npm 默认全局前缀（非 nvm）
    path.join(local, 'npm-cache', '_npx'),                 // npx 缓存（每个 hash 一个）
    path.join(pf, 'nodejs', 'node_modules'),               // 标准安装全局
  ];
  // 便携前缀（exe 旁 data\node-global\node_modules）——内嵌运行时安装位置，优先级最高
  try {
    const portable = path.join(path.dirname(process.execPath), 'data', 'node-global', 'node_modules');
    if (fs.existsSync(portable)) roots.unshift(portable);
  } catch (_) { /* 忽略 */ }
  try {
    if (process.env.DSH_DATA_DIR) {
      roots.unshift(path.join(process.env.DSH_DATA_DIR, 'node-global', 'node_modules'));
    }
  } catch (_) { /* 忽略 */ }
  // nvm-windows：npm 全局根 = nvm 根（node_modules 平铺在各 nvm 版本目录里）
  try {
    const nvmRoots = [path.join(appData, 'nvm'), path.join(local, 'nvm')];
    for (const root of nvmRoots) {
      const vers = fs.readdirSync(root).filter((v) => /^v\d/.test(v));
      for (const v of vers) roots.push(path.join(root, v, 'node_modules'));
    }
  } catch (_) { /* 忽略 */ }

  for (const root of roots) {
    try {
      if (root.endsWith('_npx')) {
        for (const hash of fs.readdirSync(root)) {
          candidates.push(path.join(root, hash, 'node_modules'));
        }
      } else {
        candidates.push(root);
      }
    } catch (_) { /* 忽略 */ }
  }

  let best = null;
  for (const base of candidates) {
    const dir = path.join(base, '@deepseek-ai', 'dsh');
    const pkg = path.join(dir, 'package.json');
    try {
      if (!fs.existsSync(pkg)) continue;
      const info = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (best === null || compareVersions(info.version, best.version) > 0) {
        best = { dir, version: info.version, bin: path.join(dir, 'lib', 'bin.js') };
      }
    } catch (_) { /* 忽略 */ }
  }
  if (best && fs.existsSync(best.bin)) return best;
  return null;
}

class Launcher extends EventEmitter {
  /**
   * @param {object} opts { settings, logger, workDir }
   */
  constructor(opts) {
    super();
    this.settings = opts.settings;
    this.log = opts.logger.appendLog.bind(opts.logger);
    this.workDir = opts.workDir;
    this.proc = null;
    this.nodePath = null;      // 字符串（兼容旧引用：启动 dsh 的 node 可执行文件）
    this.nodeInfo = null;      // { exe, env, embedded }
    this.found = null;
    this.authUrl = '';
    this.running = false;
    this.ready = false;
    this.manualStop = false;   // 手动停止标志：避免退出事件触发看门狗
    this.installing = false;   // 首次安装（npm/npx）进行中——这期间 this.proc 为 null
    this.installChild = null;  // 安装子进程句柄（允许「停止服务」取消安装）
    this.webLogBaseline = 0;   // R22：本次启动前 web.log 字节基线（看门狗切分用）
  }

  detect() {
    this.nodeInfo = findNode();
    this.nodePath = typeof this.nodeInfo === 'string' ? this.nodeInfo : this.nodeInfo.exe;
    this.found = findDsh();
    // R19：检测到 dsh 后立即打黑窗 patch（幂等）——启动/工具进程不再弹窗
    if (this.found) {
      this.applySubprocessPatch(this.found);
      // R21：OpenCode Go 的 x-opencode-session 头（2026-09-05 起上游强制）
      this.applyOpenCodeSessionPatch(this.found);
      // R28：模型发现实时化（内置目录快照不含新上线模型）
      this.applyLiveModelDiscoveryPatch(this.found);
    }
    return this.found;
  }

  get version() {
    return this.found ? this.found.version : '';
  }

  // R28（模型发现实时化，2026-09-10）：
  //   dsh 的「获取模型」走 @deepseek-ai/dsh-llm-pi-ai 的 discoverModels()。它**先查内置
  //   目录**（pi-ai 随包发布的 models 快照）——目录命中的 provider（如 opencode-go）直接
  //   return，**根本不发网络请求**。于是新上线的模型（如 deepseek-v4.1-flash）在 UI 里
  //   永远看不到，用户点多少次"获取模型"都没用。
  //   本补丁把该分支改成「实时优先 + 目录回退」：对白名单 provider 先按目录里声明的
  //   baseUrl/api 拉一次实时列表（实测 https://opencode.ai/zen/go/v1/models 返回 37 个模型，
  //   含 deepseek-v4.1-flash），同名模型沿用目录里的显示名与容量，失败/为空则回退目录
  //   （离线可用性不变）。白名单可用环境变量 DSH_APP_LIVE_MODELS 覆盖（逗号分隔）。
  //   幂等：含 R28 标记即跳过；dsh 升级替换文件后由 detect() 自动重打。
  applyLiveModelDiscoveryPatch(found) {
    if (!found || !found.dir) return false;
    try {
      const file = path.join(found.dir, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');
      if (!fs.existsSync(file)) return false;
      let src = fs.readFileSync(file, 'utf8');
      if (src.includes('// R28 dsh-app')) return true;   // 已打过
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
      if (!src.includes(anchor)) {
        this.log('R28 补丁：未找到模型发现目录短路锚点（dsh 版本变化？）——「获取模型」仍只会返回内置快照');
        return false;
      }
      const replacement = [
        '\tif (request.provider !== void 0) {',
        '\t\tconst installed = catalogModels(request.provider);',
        '\t\tif (installed.size > 0) {',
        '\t\t\tconst catalogReply = [...installed.values()].map((model) => ({',
        '\t\t\t\tid: model.id,',
        '\t\t\t\tname: model.name,',
        '\t\t\t\tcontextWindow: model.contextWindow,',
        '\t\t\t\tmaxTokens: model.maxTokens',
        '\t\t\t}));',
        '\t\t\t// R28 dsh-app: 内置目录是安装时的快照——目录命中的 provider 在此直接返回，永不联网，',
        '\t\t\t// 新上线的模型因此在「获取模型」里永远看不到。白名单内的 provider 先要一次实时列表，',
        '\t\t\t// 失败/为空再回退目录（离线行为不变）。DSH_APP_LIVE_MODELS 可覆盖白名单。',
        '\t\t\tconst liveProviders = new Set(String((typeof process !== "undefined" && process.env && process.env.DSH_APP_LIVE_MODELS) || "opencode-go,opencode").split(",").map((s) => s.trim()).filter(Boolean));',
        '\t\t\tif (liveProviders.has(request.provider)) {',
        '\t\t\t\ttry {',
        '\t\t\t\t\tconst entries = [...installed.values()];',
        '\t\t\t\t\tconst seed = entries.find((m) => typeof m.baseUrl === "string" && m.baseUrl.length > 0);',
        '\t\t\t\t\tconst liveBase = request.baseURL !== void 0 && request.baseURL.length > 0 ? request.baseURL : (seed === void 0 ? void 0 : seed.baseUrl);',
        '\t\t\t\t\tif (liveBase !== void 0) {',
        '\t\t\t\t\t\tconst known = new Map(catalogReply.map((m) => [m.id, m]));',
        '\t\t\t\t\t\tconst live = await discoverModels({',
        '\t\t\t\t\t\t\t...request,',
        '\t\t\t\t\t\t\tprovider: void 0,',
        '\t\t\t\t\t\t\tbaseURL: liveBase,',
        '\t\t\t\t\t\t\tapi: request.api ?? (seed === void 0 ? void 0 : seed.api)',
        '\t\t\t\t\t\t}, storedProfile);',
        '\t\t\t\t\t\tconst merged = live.map((m) => {',
        '\t\t\t\t\t\t\tconst hit = known.get(m.id);',
        '\t\t\t\t\t\t\treturn hit === void 0 ? m : {',
        '\t\t\t\t\t\t\t\t...m,',
        '\t\t\t\t\t\t\t\tname: m.name ?? hit.name,',
        '\t\t\t\t\t\t\t\tcontextWindow: m.contextWindow ?? hit.contextWindow,',
        '\t\t\t\t\t\t\t\tmaxTokens: m.maxTokens ?? hit.maxTokens',
        '\t\t\t\t\t\t\t};',
        '\t\t\t\t\t\t});',
        '\t\t\t\t\t\tif (merged.length > 0) return merged;',
        '\t\t\t\t\t}',
        '\t\t\t\t} catch { /* 实时失败 → 回退目录 */ }',
        '\t\t\t}',
        '\t\t\treturn catalogReply;',
        '\t\t}',
        '\t}',
      ].join('\n');
      src = src.replace(anchor, replacement);
      fs.writeFileSync(file, src, 'utf8');
      this.log('R28 补丁：dsh-llm-pi-ai 模型发现改为「实时优先 + 目录回退」 ✓');
      return true;
    } catch (e) {
      this.log('R28 补丁 失败: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  // dsh 便携安装前缀（内嵌运行时方案）：<data>\node-global —— npm --prefix 安装位置，
  // 绿色随程序目录走，升级即同前缀重装。dsh 配置/会话在 ~/.dsh 不受影响。
  portablePrefix() {
    try {
      const dataDir = this.settings && this.settings.dataDir ? this.settings.dataDir
        : (process.env.DSH_DATA_DIR || path.join(path.dirname(process.execPath), 'data'));
      return path.join(dataDir, 'node-global');
    } catch (_) {
      return path.join(path.dirname(process.execPath), 'data', 'node-global');
    }
  }

  // R19（黑窗根治，官方 dsh-desktop 双补丁对等实现）：
  //   补丁1（dsh-subprocess-local）：spawn 加 windowsHide:true（node 层）。
  //   补丁2（dsh-win32-process）：native CreateProcessAsUserW 的 STARTUPINFO
  //     dwFlags 256(STARTF_USESTDHANDLES)→257(+STARTF_USESHOWWINDOW) +
  //     wShowWindow:0(SW_HIDE)——ACL sandbox 的 pwsh 由原生 API 创建，node 的
  //     windowsHide 管不到，必须改 native 层（官方 dsh-win32-process patch 同款）。
  // 幂等：已 patch 跳过；dsh 升级替换文件后自动重打。
  applySubprocessPatch(found) {
    if (process.platform !== 'win32') return false;
    if (!found || !found.dir) return false;
    // 补丁1：dsh-subprocess-local
    try {
      const t1 = path.join(found.dir, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js');
      if (fs.existsSync(t1)) {
        let src = fs.readFileSync(t1, 'utf8');
        if (!src.includes('windowsHide: true,   // dsh-app R19')) {
          const anchor = '\tconst child = spawn(program, args, {\n\t\tcwd: spec.cwd,';
          if (src.includes(anchor)) {
            src = src.replace(anchor, '\tconst child = spawn(program, args, {\n\t\twindowsHide: true,   // dsh-app R19: GUI 宿主下隐藏孙进程控制台窗口\n\t\tcwd: spec.cwd,');
            fs.writeFileSync(t1, src, 'utf8');
            this.log('R19 补丁1：dsh-subprocess-local windowsHide ✓');
          }
        }
      }
    } catch (e) { this.log('R19 补丁1 失败: ' + (e && e.message ? e.message : e)); }
    // 补丁2：dsh-win32-process（native 层）
    try {
      const t2 = path.join(found.dir, 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib', 'index.js');
      if (fs.existsSync(t2)) {
        let src = fs.readFileSync(t2, 'utf8');
        if (!src.includes('wShowWindow: 0,   // dsh-app R19')) {
          const anchor = 'encodeStartupInfo(startupInfo, {\n\t\t\tcb: 104,\n\t\t\tdwFlags: 256,';
          const replacement = 'encodeStartupInfo(startupInfo, {\n\t\t\tcb: 104,\n\t\t\tdwFlags: 257,\n\t\t\twShowWindow: 0,   // dsh-app R19: STARTF_USESHOWWINDOW+SW_HIDE（隐藏 ACL runner 子进程窗口）';
          if (src.includes(anchor)) {
            src = src.split(anchor).join(replacement);
            fs.writeFileSync(t2, src, 'utf8');
            this.log('R19 补丁2：dsh-win32-process STARTF+SW_HIDE ✓');
          } else {
            this.log('R19 补丁2：未找到 dwFlags 锚点（dsh 版本变化？）');
          }
        }
      }
    } catch (e) { this.log('R19 补丁2 失败: ' + (e && e.message ? e.message : e)); }
    return true;
  }

  // R21（OpenCode Go session 头）：2026-09-05 起 opencode.ai/zen/go 网关要求所有请求
  // 携带 x-opencode-session 头（路由/缓存），否则 400 MissingSessionID。
  // pi-ai 的 opencode-go provider 未适配——patch pi-ai 两处请求头构造（openai-completions
  // 与 anthropic-messages），当 model.provider==='opencode-go' 或 baseUrl 含 opencode.ai
  // 且调用方未显式提供该头时注入随机 UUID。幂等：已含 dsh-app 标记则跳过。
  applyOpenCodeSessionPatch(found) {
    if (!found || !found.dir) return false;
    try {
      const piAi = path.join(found.dir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api');
      const targets = [
        {
          file: path.join(piAi, 'openai-completions.js'),
          anchor: '    // Merge options headers last so they can override defaults\n    if (optionsHeaders) {',
          inject: '    // R21 dsh-app: OpenCode Go requires x-opencode-session (2026-09-05+)\n    if ((model.provider === "opencode-go" || (model.baseUrl || "").includes("opencode.ai")) && !headers["x-opencode-session"]) {\n        headers["x-opencode-session"] = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now()) + "-" + Math.floor(Math.random() * 1e9);\n    }\n    // Merge options headers last so they can override defaults\n    if (optionsHeaders) {',
        },
        {
          file: path.join(piAi, 'anthropic-messages.js'),
          anchor: '',
          extra: [
            {
              // 定义 r21Headers（仅 opencode-go 生效）
              anchor: '    // API key or header-owned auth.\n    const sessionAffinityHeaders',
              inject: '    // API key or header-owned auth.\n    // R21 dsh-app: OpenCode Go requires x-opencode-session (2026-09-05+)\n    const r21Headers = (model.provider === "opencode-go" || (model.baseUrl || "").includes("opencode.ai")) && !(optionsHeaders && (optionsHeaders["x-opencode-session"] || optionsHeaders["X-OpenCode-Session"])) ? { "x-opencode-session": (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now()) + "-" + Math.floor(Math.random() * 1e9) } : {};\n    const sessionAffinityHeaders',
            },
            {
              // 并入 mergeClientHeaders
              anchor: '    }, sessionAffinityHeaders, model.headers, optionsHeaders);',
              inject: '    }, sessionAffinityHeaders, r21Headers, model.headers, optionsHeaders);',
            },
          ],
        },
      ];
      let patched = 0;
      for (const t of targets) {
        if (!fs.existsSync(t.file)) continue;
        let src = fs.readFileSync(t.file, 'utf8');
        if (src.includes('// R21 dsh-app')) { patched++; continue; }
        let ok = true;
        if (t.extra) {
          // 多段替换（anthropic：定义变量 + 并入 mergeClientHeaders）
          for (const step of t.extra) {
            if (!src.includes(step.anchor)) { ok = false; break; }
            src = src.replace(step.anchor, step.inject);
          }
        } else {
          if (!src.includes(t.anchor)) ok = false;
          else src = src.replace(t.anchor, t.inject);
        }
        if (!ok) { this.log('R21 patch：锚点未找到 ' + path.basename(t.file)); continue; }
        fs.writeFileSync(t.file, src, 'utf8');
        this.log('R21 patch：' + path.basename(t.file) + ' x-opencode-session ✓');
        patched++;
      }
      return patched > 0;
    } catch (e) { this.log('R21 patch 失败: ' + (e && e.message ? e.message : e)); return false; }
  }

  // 启动（安全模式时自动追加 --patch）。
  // v1.5.17a：首次安装改为**异步**（原 spawnSync 会阻塞 Electron 主进程最多 5 分钟，
  // UI 表现为"正在启动中"一直转圈）；失败路径保证 this.proc 不为 null 的兜底（错误事件
  // 处理依赖 proc），并在安装失败时发出 'install-failed' 事件让 UI 及时反馈。
  start() {
    // 审计修复（P1）：首次安装期间 this.proc 仍为 null，`if (this.proc) return` 拦不住
    // 重复触发（用户在"正在安装"时再点「启动」/托盘重复点击/服务操作队列前后两次调用）
    // → 会对同一 --prefix 并发跑两个 npm install，互相踩 node_modules。这里加独立闸门。
    if (this.proc || this.installing) return;
    this.ready = false;
    this.authUrl = '';
    this.manualStop = false;
    // R22：记录本次启动前的 web.log 字节基线——看门狗只分析「本次启动之后」追加的
    // 输出（web.log 跨启动不清空，历史插件故障行若被误读会触发假安全模式）
    this.webLogBaseline = 0;
    try { this.webLogBaseline = require('./logger').webLogSize() || 0; } catch (_) { /* 忽略 */ }
    const port = this.settings.data.port;
    const patch = this.settings.data.safeMode ? this.settings.safePatchPath : null;

    let args = ['web', '--no-open', '--port', String(port)];
    if (patch && fs.existsSync(patch)) args.push('--patch', patch);

    const found = this.found;
    // spawn env：内嵌运行时需要 ELECTRON_RUN_AS_NODE=1
    const spawnEnv = Object.assign({}, process.env,
      this.nodeInfo && this.nodeInfo.env ? this.nodeInfo.env : {});
    // v1.5.18b：内嵌模式下把 pnpm 环境注入 dsh（dsh 的 plugin 管理/部分插件运行
    // 会 spawnSync('pnpm', …)——PATH 前置应用根目录(node.exe)与 pnpm shim 目录，
    // 并提供 NODE 变量；pnpm.cmd shim 由 MarketOps._envWithPnpm 同款生成（复用以防重复）。
    if (this.nodeInfo && this.nodeInfo.embedded) {
      try {
        const appDir = path.dirname(process.execPath);
        const pnpmCjs = path.join(appDir, 'resources', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
        if (fs.existsSync(pnpmCjs)) {
          const privBin = path.join(this.portablePrefix(), '..', 'market');
          fs.mkdirSync(privBin, { recursive: true });
          const shim = path.join(privBin, 'pnpm.cmd');
          fs.writeFileSync(shim, [
            '@echo off',
            'setlocal DisableDelayedExpansion',
            'set "ELECTRON_RUN_AS_NODE=1"',
            `"${process.execPath}" "${pnpmCjs}" %*`,
            'exit /b %errorlevel%',
            '',
          ].join('\r\n'), 'utf8');
          spawnEnv.PATH = appDir + path.delimiter + privBin + path.delimiter + (spawnEnv.PATH || '');
          spawnEnv.NODE = path.join(appDir, 'node.exe');
        }
      } catch (_) { /* pnpm 注入失败不阻塞启动 */ }
    }

    if (found) {
      this._spawnDsh(args, spawnEnv);
    } else {
      // 本机无 dsh → 首次自动安装（异步，不阻塞 UI）：
      // 优先内嵌 npm（装到 data\node-global 便携前缀，零系统依赖）；
      // 回退 npx（系统有 node 的环境）。
      // 审计修复：安装全程持 installing 闸门（并发 start 直接返回），并允许 stop() 取消。
      this.installing = true;
      const token = (this._installToken = (this._installToken || 0) + 1);
      this._installAndStart(args, spawnEnv)
        .catch((e) => this.log('首次安装异常：' + (e && e.message ? e.message : e)))
        .finally(() => {
          // 令牌校验：安装被 stop() 取消后紧接着又有新的安装启动时，
          // 旧任务的收尾不得把新任务的闸门打开（否则又出现并发安装）
          if (this._installToken === token) { this.installing = false; this.installChild = null; }
        });
    }
  }

  _spawnDsh(args, spawnEnv) {
    const target = this.found || null;
    if (!target) return false;
    // v1.5.17b：dsh 的 HMR 插件要求 node 以 --expose-internals 启动（Node 22+ 的
    // cordis-plugin-hmr 依赖内部 API；缺此参数服务起后数秒即崩：
    // "--expose-internals is required for HMR service"）。内嵌运行时（Electron 的
    // node 模式）与系统 node 均支持该参数，固定带上。
    const nodeArgs = ['--expose-internals', target.bin].concat(args);

    // v1.5.17e（学官方 dsh-desktop 的 launch broker）：Windows 内嵌模式下，DSH-App.exe
    // 是 GUI 子系统——它直接 spawn 的控制台程序（dsh 内部的 pwsh/cmd 工具）会各自新建
    // 可见控制台窗口（"执行脚本弹黑窗"）。解法：经 cmd.exe（控制台子系统）作宿主——
    // spawn cmd /c broker.cmd 并 windowsHide 隐藏其控制台，dsh 与全部孙进程共享这个
    // 隐藏控制台（孙进程继承，不再弹窗）。broker 是生成的 cmd 脚本（路径全部引号包裹，
    // 无转义问题），stdout 仍走 pipe 供 URL 行解析。
    if (process.platform === 'win32' && this.nodeInfo && this.nodeInfo.embedded) {
      try {
        const dataDir = path.dirname(this.portablePrefix());
        const brokerDir = path.join(dataDir, 'broker');
        fs.mkdirSync(brokerDir, { recursive: true });
        const broker = path.join(brokerDir, 'launch-dsh.cmd');
        const appExe = process.execPath;
        const lines = [
          '@echo off',
          'setlocal DisableDelayedExpansion',
          `set "ELECTRON_RUN_AS_NODE=1"`,
          // R25（审计修复）：args 逐个加引号——`--patch <safe.yml>` 路径含空格时
          // （%APPDATA% 回退/用户名含空格）cmd 会拆断参数 → 安全模式补丁丢失
          `"${appExe}" --expose-internals "${target.bin}" ${args.map((a) => '"' + a + '"').join(' ')}`,
          'exit /b %errorlevel%',
          '',
        ];
        fs.writeFileSync(broker, lines.join('\r\n'), 'utf8');
        this.log('启动 dsh ' + target.version + '（cmd broker 隐藏控制台）→ ' + nodeArgs.join(' '));
        // cmd /d/s/c：禁用 AutoRun、按字符串解析、执行后退出。
        // 注意 broker 内已含 exe/参数（无转义问题），此处 args 不再传。
        this.proc = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', broker], {
          cwd: this.workDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv,
        });
        this.running = true;
        this._wireProc();
        return true;
      } catch (e) {
        this.log('cmd broker 失败（回退直接 spawn）：' + (e && e.message ? e.message : e));
        // 落到下方常规路径
      }
    }
    this.log('启动 dsh ' + target.version + ' → ' + this.nodePath + ' ' + nodeArgs.join(' '));
    this.proc = spawn(this.nodePath, nodeArgs, {
      cwd: this.workDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv,
    });
    this.running = true;
    this._wireProc();
    return true;
  }

  _wireProc() {
    const p = this.proc;
    if (!p) return;
    p.on('error', (err) => {
      // R22：进程身份校验——stop/restart 后旧进程的迟到事件（taskkill 返回与 uv 回调
      // 间存在时序窗口）一律忽略，避免误改新进程状态
      if (this.proc !== p) return;
      this.running = false;
      this.emit('error', err);
    });
    p.on('exit', (code, signal) => {
      // R22：同 error——旧进程迟到的 exit 会把 running 误置 false 并让 main 误判
      // 「未就绪即退出」触发看门狗（误杀新进程/误进安全模式、误禁用插件）
      if (this.proc !== p) return;
      this.running = false;
      this.emit('exit', code, signal);
    });
    this.bindOutput();
  }

  async _installAndStart(args, spawnEnv) {
    const npmCli = findEmbeddedNpmCli();
    if (npmCli && this.nodeInfo && this.nodeInfo.embedded) {
      const prefix = this.portablePrefix();
      this.log('未发现本机 dsh，使用内嵌 npm 安装到便携目录 ' + prefix + ' …（首次约 1-3 分钟，界面可继续操作）');
      try {
        // 关键（v1.5.17a）：dsh 原生依赖（koffi/node-pty）postinstall 调 `node`——
        // 把 app exe 拷为 <prefix>\node.exe 并注入 PATH，零依赖机器上安装才能成功
        const prep = prepareEmbeddedInstallEnv(prefix, spawnEnv);
        // v1.5.17c：默认走 npmmirror 镜像——npm 默认源在国内网络会部分包下载残缺
        // （实测 zod 目录存在但 index.js 缺失 → dsh 启动报 ERR_MODULE_NOT_FOUND）；
        // DSH_NPM_REGISTRY 可覆盖。加 --force 确保残缺安装被完整重装。
        const registry = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';
        const { spawn: spawnAsync } = require('child_process');
        const install = await new Promise((resolve) => {
          const child = spawnAsync(this.nodePath, [npmCli, 'install', '-g', '--prefix', prefix,
            '@deepseek-ai/dsh@latest', '--no-fund', '--no-audit', '--force', '--registry', registry], {
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: prep.env,
          });
          this.installChild = child;   // 审计修复：暴露句柄，stop() 可取消安装
          let out = '';
          const t = setTimeout(() => { try { child.kill(); } catch (_) { /* 忽略 */ } resolve({ status: 1, output: out + '\n[超时] 5 分钟' }); }, 5 * 60 * 1000);
          if (child.stdout) child.stdout.on('data', (c) => { out += c; });
          if (child.stderr) child.stderr.on('data', (c) => { out += c; });
          child.on('error', (e) => { clearTimeout(t); resolve({ status: 1, output: String(e) }); });
          child.on('exit', (code) => { clearTimeout(t); if (this.installChild === child) this.installChild = null; resolve({ status: code, output: out }); });
        });
        if (install.status === 0) {
          this.log('dsh 安装完成（便携前缀），正在启动…');
          this.detect();   // 重新扫描（便携前缀在 findDsh 扫描列表内）
          // 审计修复：安装期间被「停止服务」取消（manualStop）→ 不再自动拉起服务
          if (this.manualStop) { this.log('安装完成，但服务已被用户停止——不自动启动。'); return; }
          if (this.found && this._spawnDsh(args, spawnEnv)) return;
          this.log('安装完成但未检测到 dsh，回退 npx…');
        } else {
          this.log('内嵌 npm 安装失败（退出码 ' + install.status + '）：' + String(install.output || '').slice(-300));
          if (this.manualStop) return;   // 被用户取消 → 不落入 npx 回退
        }
      } catch (e) {
        this.log('内嵌 npm 安装异常：' + (e && e.message ? e.message : e));
      }
    }
    // 回退：npx（系统 node 环境）——零依赖机器上 npx 不存在时也会触发 error 事件（UI 显示失败）
    if (!this.proc) {
      this.log('未发现本机 dsh，使用 npx 自动下载安装并启动…');
      this.proc = spawn('npx', ['--yes', '@deepseek-ai/dsh'].concat(args), {
        cwd: this.workDir, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.running = true;
      this._wireProc();
    }
  }

  bindOutput() {
    const p = this.proc;
    if (!p || !p.stdout) return;
    let buf = '';
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      this.logRaw(text);
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        const m = REGEX_URL_LINE.exec(line);
        if (m) {
          this.authUrl = m[1];
          this.ready = true;
          this.emit('url', this.authUrl);
        }
      }
    };
    p.stdout.on('data', onData);
    if (p.stderr) p.stderr.on('data', (chunk) => this.logRaw(chunk.toString('utf8')));
  }

  logRaw(text) {
    try {
      const { appendWeb } = require('./logger');
      appendWeb(text.trimEnd());
    } catch (_) { /* 忽略 */ }
  }

  // HTTP 健康探测：2xx/4xx 都算服务活着（401 是浏览器信任门槛，仍证明服务在线）
  probeHealth(port, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  // 等待就绪：优先 stdout URL 行；超时后回退端口探测
  async waitReady(timeoutMs = READY_TIMEOUT) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.ready && this.authUrl) return this.authUrl;
      if (await this.probeHealth(this.settings.data.port, 1500)) {
        // 端口在线但未读到 URL 行（极旧版本）→ 用明文 URL
        if (!this.authUrl) this.authUrl = 'http://127.0.0.1:' + this.settings.data.port + '/';
        this.ready = true;
        return this.authUrl;
      }
      await sleep(1000);
    }
    return null;
  }

  async stop() {
    const p = this.proc;
    this.proc = null;
    this.manualStop = true;
    // 审计修复（P1）：running 必须在 stop 时复位。旧版只置 proc=null，而 _wireProc 的
    // 进程身份守卫（R22）会拦掉随后迟到的 exit 事件 → running 永远停在 true：
    //   · upgradeDsh 的 wasRunning 误判 → 用户手动停服后升级还会自动把服务拉起来；
    //   · waitReadyByProbe / onBootTimeout 的 launcher.running 判断失真。
    this.running = false;
    this.ready = false;
    // 首次安装进行中 → 允许取消（安装子进程不在 this.proc 上）
    if (this.installChild) {
      try { this.installChild.kill(); this.log('已取消进行中的 dsh 安装。'); } catch (_) { /* 忽略 */ }
      this.installChild = null;
    }
    this._installToken = (this._installToken || 0) + 1;   // 使在途安装任务的收尾失效
    this.installing = false;                              // 让紧随其后的 start() 能重新发起
    if (!p || p.exitCode !== null) return;
    try {
      // Windows 进程树终止
      const r = spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      if (r.status !== 0) p.kill();
    } catch (_) {
      try { p.kill(); } catch (_) { /* 忽略 */ }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Launcher, findDsh, findNode, findNodeStr, findEmbeddedNpmCli, prepareEmbeddedInstallEnv, compareVersions, REGEX_URL_LINE };