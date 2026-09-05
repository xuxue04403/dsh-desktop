// updater.js — dsh 版本检查与升级引导
//
// 升级兼容：只做「检查 + 引导」，不代用户强装（升级需要管理员/用户环境权限）——
// 界面上给出可一键复制的升级命令，或调用 npx 临时最新版启动。
// 检查走内置 https 直连 npm registry（无外部程序依赖），镜像可用 DSH_NPM_REGISTRY 覆盖。
'use strict';

const https = require('https');
const { compareVersions } = require('./launcher');

function latestVersion(timeoutMs = 8000) {
  const registry = (process.env.DSH_NPM_REGISTRY || 'https://registry.npmjs.org')
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

module.exports = { latestVersion, checkForUpdate };