// datadir.js — 数据目录解析（与 DSH 桌面助手一致的便携策略）
//
// 优先级：
//   1) 环境变量 DSH_DATA_DIR 显式覆盖（可写性探测）；
//   2) exe 所在目录旁的 data\（绿色免安装版：随程序目录走，复制整个目录即迁移数据）；
//   3) 以上不可写 → 回退 %APPDATA%\DSH-App（老位置），并把旧数据一次性复制到便携目录。
//
// 数据内容：settings.json、logs/、gateway.config.json、badge 等全部用户数据。
// 网关配置专项迁移：从 DSH 桌面助手（%APPDATA%\DSHDesktop）或旧版 DSH App
// （%APPDATA%\DSH App）一次性复制 gateway.config.json 到便携数据目录，
// 仅当便携目录还没有网关配置时执行（不覆盖用户后续的修改）。
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test-' + Date.now());
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

// 网关注入配置的候选来源（按优先级，取第一个存在的）：
//   1) 环境变量 DSH_LEGACY_CONFIG 显式指向桌面助手 gateway.config.json；
//   2) 桌面助手绿色版（exe 旁 data\）常见部署位置与本工作区开发目录；
//   3) 旧版 DSH App %APPDATA%\DSH App 迁移落点；
//   4) 更老的 %APPDATA%\DSHDesktop / %APPDATA%\DSH-App。
const gatewaySources = [
  () => process.env.DSH_LEGACY_CONFIG || '',
  () => path.join(process.env.USERPROFILE || '', 'dsh-desktop', 'data', 'gateway.config.json'),
  () => path.join(process.env.USERPROFILE || '', 'DSHDesktop', 'data', 'gateway.config.json'),
  // 本工作区开发目录（dsh 桌面助手源码树）
  ...(() => {
    const roots = [];
    const cwd = process.cwd();
    for (const base of [cwd, path.dirname(cwd), path.dirname(path.dirname(cwd))]) {
      if (base && !roots.includes(base)) roots.push(base);
    }
    return roots.map((base) => () => path.join(base, 'dsh-desktop', 'data', 'gateway.config.json'))
      .concat(roots.map((base) => () => path.join(base, 'dsh-desktop-github', 'data', 'gateway.config.json')));
  })(),
  () => path.join(app.getPath('appData'), 'DSH App', 'gateway.config.json'),
  () => path.join(app.getPath('appData'), 'DSHDesktop', 'gateway.config.json'),
  () => path.join(app.getPath('appData'), 'DSH-App', 'gateway.config.json'),
];

// 一次性迁移：便携目录为空且 %APPDATA%\DSH-App 有旧数据 → 复制（不删除旧数据）
function migrateFromAppData(portable) {
  try {
    if (fs.existsSync(path.join(portable, 'settings.json'))) return; // 已有数据
    const old = path.join(app.getPath('appData'), 'DSH-App');
    if (!fs.existsSync(old) || !fs.existsSync(path.join(old, 'settings.json'))) return;
    fs.cpSync(old, portable, { recursive: true });
    const marker = path.join(portable, '.migrated');
    fs.writeFileSync(marker, new Date().toISOString());
    // eslint-disable-next-line no-console
    console.log('[datadir] 已把 %APPDATA%\\DSH-App 旧数据迁移到 ' + portable);
  } catch (_) { /* 迁移失败不阻断启动 */ }
}

// 网关配置一次性迁移：便携目录还没有 gateway.config.json 时，从桌面助手/旧版复制。
// 返回复制来源路径；无可迁移来源或已存在配置时返回 null。
// sources 可注入（默认为桌面助手/旧版路径 ；单测时传静态路径数组）。
function migrateGatewayConfig(portable, sources) {
  try {
    const target = path.join(portable, 'gateway.config.json');
    if (fs.existsSync(target)) return null; // 便携目录已有配置（不覆盖用户数据）
    const list = sources || gatewaySources;
    for (const src of list) {
      const from = typeof src === 'function' ? src() : src;
      if (!from || !fs.existsSync(from)) continue;
      if (!probeWritable(portable)) return null;
      fs.copyFileSync(from, target);
      // eslint-disable-next-line no-console
      console.log('[datadir] 已从 ' + from + ' 复制网关配置到 ' + target);
      return from;
    }
    return null;
  } catch (_) { return null; }
}

function resolveDataDir() {
  // 1) 显式覆盖
  const override = process.env.DSH_DATA_DIR;
  if (override && probeWritable(override)) return override;

  // 2) exe 旁 data\（绿色便携）
  let exeDir = '';
  try { exeDir = path.dirname(process.execPath); } catch (_) { /* 忽略 */ }
  if (exeDir) {
    const portable = path.join(exeDir, 'data');
    if (probeWritable(portable)) {
      migrateFromAppData(portable);
      migrateGatewayConfig(portable);   // 网关配置独立于 settings 迁移
      return portable;
    }
  }

  // 3) 回退 %APPDATA%\DSH-App
  const fallback = path.join(app.getPath('appData'), 'DSH-App');
  probeWritable(fallback);
  return fallback;
}

module.exports = { resolveDataDir, migrateGatewayConfig, gatewaySources };