// datadir.js — 数据目录解析（与 DSH 桌面助手一致的便携策略）
//
// 优先级：
//   1) 环境变量 DSH_DATA_DIR 显式覆盖（可写性探测）；
//   2) exe 所在目录旁的 data\（绿色免安装版：随程序目录走，复制整个目录即迁移数据）；
//   3) 以上不可写 → 回退 %APPDATA%\DSH-App（老位置），并把旧数据一次性复制到便携目录。
//
// 数据内容：settings.json、logs/、gateway.config.json、input-history.json 等全部用户数据。
// 网关配置专项迁移：从 DSH 桌面助手的真实数据目录（exe 旁 data\，沿祖先链向上探测）
// 一次性复制 gateway.config.json 到便携数据目录；若目标已是"模拟/示例"配置而真实源存在，
// 自动覆盖升级（保留 .bak 备份）。无 UI、无按钮，纯一次性自动行为。
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

// 从 cwd 逐级向上到文件系统根（最多 12 层），收集候选基目录。
// 用于在开发树任意深度运行时都能找到 <root>/dsh-desktop\data 真实配置。
function ancestorBases() {
  const roots = [];
  let cur = process.cwd();
  for (let i = 0; i < 12 && cur; i++) {
    if (!roots.includes(cur)) roots.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return roots;
}

// 网关配置候选来源（按优先级，取第一个存在的）：
//   1) 环境变量 DSH_LEGACY_CONFIG 显式指向桌面助手 gateway.config.json；
//   2) 桌面助手便携数据目录（沿 cwd 祖先链找 <base>\dsh-desktop[github]\data）——真实用户配置；
//   3) 用户主目录下的桌面助手（%USERPROFILE%\dsh-desktop\data）；
//   4) %APPDATA% 旧位置（DSHDesktop / DSH App / DSH-App）——注意其中可能是旧模拟数据，
//      因此排在真实源之后，且"目标已是模拟配置"时不从这些源升级。
const gatewaySources = [
  () => process.env.DSH_LEGACY_CONFIG || '',
  ...(() => {
    const list = [];
    for (const base of ancestorBases()) {
      list.push(() => path.join(base, 'dsh-desktop', 'data', 'gateway.config.json'));
      list.push(() => path.join(base, 'dsh-desktop-github', 'data', 'gateway.config.json'));
    }
    return list;
  })(),
  () => path.join(process.env.USERPROFILE || '', 'dsh-desktop', 'data', 'gateway.config.json'),
  () => path.join(process.env.USERPROFILE || '', 'DSHDesktop', 'data', 'gateway.config.json'),
  () => path.join(app.getPath('appData'), 'DSHDesktop', 'gateway.config.json'),
  () => path.join(app.getPath('appData'), 'DSH App', 'gateway.config.json'),
  () => path.join(app.getPath('appData'), 'DSH-App', 'gateway.config.json'),
];

// 判断网关配置内容是否为"模拟/示例"数据（非真实供应商）：
//   - 示例配置：provider-a / provider-b / api.example.com；
//   - 桌面助手自带模拟源：mockA / mockB（baseURL 127.0.0.1:3190/3191）。
// 真实配置的 apiKey 可能仍是测试值，因此只以供应商 id/地址特征判断。
function isMockLikeConfig(text) {
  if (!text) return true;
  try {
    const cfg = JSON.parse(text);
    const ps = Array.isArray(cfg.providers) ? cfg.providers : [];
    if (ps.length === 0) return true;
    return ps.every((p) => {
      const id = String(p.id || '');
      const url = String(p.baseURL || '');
      return /^mock/i.test(id)
        || /127\.0\.0\.1:319\d/.test(url)
        || /^provider-[ab]$/.test(id)
        || /api\.example\d?\.com/.test(url);
    });
  } catch (_) {
    return true;
  }
}

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

// 网关配置一次性迁移/升级：
//   - 目标不存在 → 从最高优先级来源复制；
//   - 目标存在但为模拟/示例数据（isMockLikeConfig）且存在真实来源 → 覆盖升级（备份 .bak-mock）；
//   - 目标为真实配置 → 不动。
// 返回动作说明 { action, from }；无动作返回 null。
// sources 可注入（单测传静态路径数组）。
function migrateGatewayConfig(portable, sources) {
  try {
    const target = path.join(portable, 'gateway.config.json');
    const targetExists = fs.existsSync(target);
    if (targetExists && !isMockLikeConfig(fs.readFileSync(target, 'utf8'))) return null; // 真实配置不动

    const list = sources || gatewaySources;
    for (const src of list) {
      const from = typeof src === 'function' ? src() : src;
      if (!from || !fs.existsSync(from)) continue;
      let fromText = '';
      try { fromText = fs.readFileSync(from, 'utf8'); } catch (_) { continue; }
      if (isMockLikeConfig(fromText)) continue;            // 来源也是模拟数据 → 跳过找下一个
      if (targetExists && path.resolve(from) === path.resolve(target)) break;
      if (!probeWritable(portable)) return null;
      if (targetExists) {
        const bak = target + '.bak-mock';
        try { if (!fs.existsSync(bak)) fs.copyFileSync(target, bak); } catch (_) { /* 备份失败继续 */ }
      }
      fs.copyFileSync(from, target);
      // R25（审计修复）：端口归一——桌面助手（3090）的真实配置迁入 dsh-app 时原样
      // 保留 3090 会与桌面助手同跑时 EADDRINUSE，违背 R22「dsh-app=3091 / 助手=3090
      // 不混占」约定。迁移/升级路径统一改写为 3091（目标已是 3091 则不动）。
      try {
        const cfg = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (cfg && Number(cfg.port) === 3090) {
          cfg.port = 3091;
          fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
          // eslint-disable-next-line no-console
          console.log('[datadir] 迁移配置端口 3090 → 3091（dsh-app 网关约定，避免与桌面助手冲突）');
        }
      } catch (_) { /* 解析失败保持原样 */ }
      // eslint-disable-next-line no-console
      console.log('[datadir] 网关配置已' + (targetExists ? '从模拟数据升级：' : '迁移：') + from + ' → ' + target);
      return { action: targetExists ? 'upgraded' : 'migrated', from };
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

module.exports = { resolveDataDir, migrateGatewayConfig, gatewaySources, isMockLikeConfig };