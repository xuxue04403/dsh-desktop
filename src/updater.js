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

// shell 命令行参数引用（审计修复）：含空格/特殊字符时用双引号包裹并转义内部引号。
// 仅在 Windows shell 回退路径使用（真正的 npm-cli 路径走数组传参，不经过 shell）。
function shellQuote(a) {
  const s = String(a);
  if (!/[\s"&|<>^%]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

function latestVersion(timeoutMs = 8000) {
  // v1.5.17c：默认 npmmirror（与安装源一致，国内网络稳定）；DSH_NPM_REGISTRY 可覆盖
  const registry = (process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com')
    .replace(/\/+$/, '');
  return new Promise((resolve) => {
    const req = https.get(registry + '/@deepseek-ai/dsh/latest', {
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

// 生成升级引导信息（返回 null 表示无需升级）
async function checkForUpdate(localVersion) {
  if (!localVersion) return null;
  const latest = await latestVersion();
  if (!latest) return null;
  if (compareVersions(latest, localVersion) > 0) {
    return { local: localVersion, latest, command: 'npm i -g @deepseek-ai/dsh@latest' };
  }
  return null;
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
 * 执行升级：npm i -g @deepseek-ai/dsh@latest
 * v1.5.17：
 *  - nodeInfo（launcher.findNode() 结果）指定运行时；内嵌模式（embedded）时 npm-cli
 *    优先用随应用打包的（launcher.findEmbeddedNpmCli），并安装到便携前缀 prefix
 *    （data\node-global——绿色随程序走，升级即同前缀替换，dsh 的 ~/.dsh 配置不受影响）；
 *  - 非 prefix 时装系统全局（npm i -g 默认）。
 * @param {object} opts { nodeInfo, prefix, onProgress }
 * @returns {Promise<{ok: boolean, output: string}>}
 */
function performUpgrade(opts) {
  const o = opts || {};
  const nodeInfo = o.nodeInfo || { exe: 'node', env: {}, embedded: false };
  const nodePath = typeof nodeInfo === 'string' ? nodeInfo : nodeInfo.exe;
  return new Promise((resolve) => {
    const registry = process.env.DSH_NPM_REGISTRY || '';
    let npmCli;
    if (o.prefix) {
      // 内嵌/便携模式：优先随应用打包的 npm-cli（不依赖系统 npm）
      try { npmCli = require('./launcher').findEmbeddedNpmCli(); } catch (_) { npmCli = null; }
      if (!npmCli) npmCli = findNpmCli(nodePath);
    } else {
      npmCli = findNpmCli(nodePath);
    }
    const useNode = npmCli !== 'npm';
    const args = useNode
      ? [npmCli, 'install', '-g', '@deepseek-ai/dsh@latest', '--no-fund', '--no-audit', '--force']
      : ['install', '-g', '@deepseek-ai/dsh@latest', '--no-fund', '--no-audit', '--force'];
    if (o.prefix) args.push('--prefix', o.prefix);
    // v1.5.17c：默认 npmmirror（默认源国内会残缺——实测 zod 缺 index.js 导致启动崩）
    args.push('--registry', registry || 'https://registry.npmmirror.com');

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

module.exports = { latestVersion, checkForUpdate, performUpgrade, findNpmCli };