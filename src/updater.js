// updater.js — dsh 版本检查与升级
//
// 升级策略（v1.5.17）：
//  - 设置开启 checkUpdates 时，检测到新版**自动升级**（停服 → npm i -g → 重启服务）
//  - 手动触发：设置页「立即升级」按钮 / dsh:action 'upgrade-dsh'
//  - 升级用找到的 node 跑 npm（npm-cli.js 与 node 同目录；nvm 环境装到激活版本的全局目录，
//    findDsh 扫描所有 nvm 版本目录所以升级后必然被发现）
//  - 服务运行中先停再升（Windows 运行中的文件被替换会 EBUSY/EPERM）
//  - 检查走内置 https 直连 npm registry（无外部程序依赖），镜像可用 DSH_NPM_REGISTRY 覆盖。
'use strict';

const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { compareVersions } = require('./launcher');
const {
  dshCandidateTags, dshRegistry, dshInstallSpec, dshInstallSpecFor,
  dshVersionUrlFor, dshUpgradeCommand, dshUpgradeCommandFor,
} = require('./dsh-tag');

// shell 命令行参数引用（审计修复）：含空格/特殊字符时用双引号包裹并转义内部引号。
// 仅在 Windows shell 回退路径使用（真正的 npm-cli 路径走数组传参，不经过 shell）。
function shellQuote(a) {
  const s = String(a);
  if (!/[\s"&|<>^%]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

// 查询**指定标签**对应的版本（v1.9.1：不再写死 latest）。
// 返回 null 表示该标签查不到（断网 / 镜像异常 / 标签不存在）——只影响它自己，不牵连其它候选。
function fetchTagVersion(tag, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = https.get(dshVersionUrlFor(tag), {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'dsh-app/0.1.0' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info.version || null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// 测试注入点：把"按标签查版本"换成可控实现，使**多标签择优**逻辑可以离线回归
// （不联网、不依赖镜像当时恰好把某个版本挂在哪个标签上）。生产路径永远走 fetchTagVersion。
let fetchOverride = null;
function __setFetchForTest(fn) { fetchOverride = typeof fn === 'function' ? fn : null; }
function queryTag(tag, timeoutMs) {
  if (fetchOverride) {
    try { return Promise.resolve(fetchOverride(tag)); } catch (err) { return Promise.resolve(null); }
  }
  return fetchTagVersion(tag, timeoutMs);
}

/**
 * 同时评估全部候选标签（缺省 `latest` + `next`），返回**版本最高**的那个。
 *
 * 为什么不是"跟随某一个标签"：实测 2026-09-29 —— `latest` 追平到 0.1.7-rc.2，而 `next`
 * 前进到 0.2.0-rc.1；只跟 `latest` 的实现**永远看不到**发在 `next` 上的新版本，
 * 用户会认为"启动时没有自动更新"（真实发生过）。
 *
 * 失败隔离：某个标签查不到只记 null，其余候选照常参与比较；全部失败才返回 null。
 *
 * @param {number} [timeoutMs] 单个标签的查询超时
 * @returns {Promise<{version:string, tag:string, tags:Array<{tag:string, version:string|null}>}|null>}
 */
async function bestRelease(timeoutMs = 8000) {
  const cands = dshCandidateTags();
  const results = await Promise.all(
    cands.map(async (tag) => ({ tag, version: await queryTag(tag, timeoutMs) })),
  );
  let best = null;
  for (const r of results) {
    if (!r.version) continue;
    if (!best || compareVersions(r.version, best.version) > 0) best = { version: r.version, tag: r.tag };
  }
  if (!best) return null;
  return { version: best.version, tag: best.tag, tags: results };
}

// 兼容入口（旧调用/测试）：候选中的最高版本；null 表示"一个候选都查不到"。
async function latestVersion(timeoutMs = 8000) {
  const best = await bestRelease(timeoutMs);
  return best ? best.version : null;
}

/**
 * 评估"要不要升级"，**永远返回结构化结果**（含每个候选标签各自的查询结果）。
 * 与 {@link checkForUpdate} 的分工：这个给日志用（说明"比过哪些标签、为什么升/不升"），
 * 那个给 IPC/界面用（无需升级时返回 null，保持既有契约）。
 *
 * `spec` 用**确切版本**而不是标签名：检查与安装之间标签可能被上游移动，装我们刚判定过的那个版本才确定。
 *
 * @returns {Promise<{local:string|null, best:{version:string,tag:string}|null,
 *   tags:Array<{tag:string,version:string|null}>, needed:boolean, spec:string|null, command:string}>}
 */
async function evaluate(localVersion) {
  const best = await bestRelease();
  const tags = best ? best.tags : dshCandidateTags().map((tag) => ({ tag, version: null }));
  const needed = !!(best && localVersion && compareVersions(best.version, localVersion) > 0);
  return {
    local: localVersion || null,
    best: best ? { version: best.version, tag: best.tag } : null,
    tags,
    needed,
    spec: best ? dshInstallSpecFor(best.version) : null,
    command: best ? dshUpgradeCommandFor(best.version) : dshUpgradeCommand(),
  };
}

// 生成升级引导信息（返回 null 表示无需升级 —— 界面据此判断"已是最新"）
async function checkForUpdate(localVersion) {
  if (!localVersion) return null;
  const r = await evaluate(localVersion);
  if (!r.needed) return null;
  return { local: r.local, latest: r.best.version, tag: r.best.tag, tags: r.tags, command: r.command };
}

/** 定位 npm-cli.js（node 旁的 npm）：
 *  nvm-windows/标准安装下 node 同目录 node_modules\npm\bin\npm-cli.js；
 *  找不到时退回 'npm'（PATH 解析）。
 */
function findNpmCli(nodePath) {
  if (!nodePath || nodePath === 'node') return 'npm';
  const dir = path.dirname(nodePath);
  const cands = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),   // nvm shim：node 在版本目录根
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* 忽略 */ }
  }
  return 'npm';
}

/**
 * 执行升级：npm i -g @deepseek-ai/dsh@<标签>（标签见 dsh-tag.js，缺省 latest）
 * v1.5.17：
 *  - nodeInfo（launcher.findNode() 结果）指定运行时；内嵌模式（embedded）时 npm-cli
 *    优先用随应用打包的（launcher.findEmbeddedNpmCli），并安装到便携前缀 prefix
 *    （data\node-global——绿色随程序走，升级即同前缀替换，dsh 的 ~/.dsh 配置不受影响）；
 *  - 非 prefix 时装系统全局（npm i -g 默认）。
 * @param {object} opts { nodeInfo, prefix, onProgress, spec }
 *   `spec` 为要安装的包规格（如 `@deepseek-ai/dsh@0.2.0-rc.1`）——由调用方传入
 *   {@link evaluate} 判定的**确切版本**；缺省才回退到标签形态（首次安装/手动触发）。
 * @returns {Promise<{ok: boolean, output: string}>}
 */
function performUpgrade(opts) {
  const o = opts || {};
  const nodeInfo = o.nodeInfo || { exe: 'node', env: {}, embedded: false };
  const nodePath = typeof nodeInfo === 'string' ? nodeInfo : nodeInfo.exe;
  return new Promise((resolve) => {
    let npmCli;
    if (o.prefix) {
      // 内嵌/便携模式：优先随应用打包的 npm-cli（不依赖系统 npm）
      try { npmCli = require('./launcher').findEmbeddedNpmCli(); } catch (_) { npmCli = null; }
      if (!npmCli) npmCli = findNpmCli(nodePath);
    } else {
      npmCli = findNpmCli(nodePath);
    }
    const useNode = npmCli !== 'npm';
    // v1.9.1：跟随可配置标签（DSH_DSH_TAG），不再写死 latest——否则主目录与 UAT 会
    // 因标签不同而跑成两个 dsh 版本，而两者共用 ~/.dsh，旧版会把新版状态改坏。
    // v1.9.2：优先用调用方判定的确切版本（多标签取高者的结果），避免检查与安装之间标签被移动。
    const spec = String(o.spec || '').trim() || dshInstallSpec();
    const args = useNode
      ? [npmCli, 'install', '-g', spec, '--no-fund', '--no-audit', '--force']
      : ['install', '-g', spec, '--no-fund', '--no-audit', '--force'];
    if (o.prefix) args.push('--prefix', o.prefix);
    // v1.5.17c：默认 npmmirror（默认源国内会残缺——实测 zod 缺 index.js 导致启动崩）
    args.push('--registry', dshRegistry());

    const spawnEnv = Object.assign({}, process.env,
      nodeInfo && nodeInfo.env ? nodeInfo.env : {});
    // v1.5.17a：便携前缀模式下，把 app exe 拷为 <prefix>\node.exe 并注入 PATH——
    // dsh 原生依赖（koffi/node-pty）postinstall 调 `node`，零依赖机器上必须可解析
    let envForNpm = spawnEnv;
    if (o.prefix) {
      try {
        const prep = require('./launcher').prepareEmbeddedInstallEnv(o.prefix, spawnEnv);
        envForNpm = prep.env;
      } catch (_) { /* 回退原 env */ }
    }
    const line = (s) => { try { (o.onProgress || (() => { }))(String(s)); } catch (_) { /* 忽略 */ } };
    line('执行: ' + (useNode ? nodePath : 'npm') + ' ' + args.join(' '));

    let output = '';
    const child = useNode
      ? spawn(nodePath, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: envForNpm })
      // 审计修复（P2）：系统 npm 回退路径走 shell 时参数必须逐个加引号——否则安装路径含
      // 空格（如 D:\My Apps\DSH-App\data\node-global）时 `--prefix` 会被拆成两个参数，
      // 升级静默装到错误位置。改为拼一条已转义的命令行（shell 分支）。" 
      : spawn(['npm'].concat(args.map(shellQuote)).join(' '), {
        windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: envForNpm,
      });

    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* 忽略 */ }
      resolve({ ok: false, output: output + '\n[超时] 安装超过 5 分钟被中止' });
    }, 5 * 60 * 1000);

    if (child.stdout) child.stdout.on('data', (c) => { const t = c.toString('utf8'); output += t; line(t.trimEnd()); });
    if (child.stderr) child.stderr.on('data', (c) => { const t = c.toString('utf8'); output += t; line(t.trimEnd()); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: output + '\n' + (err.message || String(err)) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output + '\n[exit ' + code + ']' });
    });
  });
}

module.exports = {
  latestVersion, bestRelease, evaluate, fetchTagVersion, checkForUpdate, performUpgrade, findNpmCli,
  __setFetchForTest,
};