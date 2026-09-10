// default-plugins.js — 随 dsh-app 分发的默认插件安装（v1.7.0 起：dsh-email-bridge 邮箱桥接）
//
// 【R24 · 2026-09-10 事故教训（dsh 无法启动）】
//   旧实现把插件包直接拷进 pnpm 管理的 profile node_modules，但不在 profile 的
//   package.json 声明依赖 → 任何一次 pnpm 操作（市场安装/卸载、dsh plugin CLI）都会
//   把它当"多余包"清除 → cordis.patch.yml 的挂载条目悬空 → dsh 启动 import 失败 →
//   **整棵插件树拒绝启动**（用户被迫手删配置才能开机）。
//
// 【v2 防清理方案】
//   1) 插件源常驻 profile：`<profile>\vendor\dsh-email-bridge`（非 node_modules 目录，pnpm 不碰）；
//   2) profile `package.json` 声明 `"dsh-email-bridge": "file:vendor/dsh-email-bridge"` ——
//      vendor 包声明了 bundleDependencies（携带全部第三方依赖，离线可装），因此：
//      · pnpm 永远不会把它当"多余包"清除；
//      · 即使目录意外丢失，下一次任何 pnpm 操作都会自动从 vendor 重装；
//   3) node_modules 缺包时优先 `dsh plugin add file:vendor/...`（pnpm 正规安装），
//      失败才退回直接拷贝（依赖声明仍在，pnpm 稍后会自行对齐）；
//   4) @deepseek-ai 宿主包由 dsh 官方兜底闭包 `$DSH_HOME/profiles/node_modules` 解析
//      （宿主启动时自愈维护）；仅当兜底缺失时才建 junction 指向本次 dsh 安装，
//      且兜底可用时会清掉旧 junction（指向应用目录的 junction 会被构建清空，是悬空隐患）；
//   5) `verifyDefaultPlugins()` 在 dsh 每次启动前校验「挂载条目 ⇒ 包可解析」并自动修复；
//      用户经市场卸载（pnpm 移除依赖声明）时同步移除挂载条目，不再悬空。
//
// 全流程幂等、失败只记日志；修改 profile 文件（package.json / cordis.patch.yml）前一律备份。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// @deepseek-ai 宿主包：优先经 $DSH_HOME/profiles/node_modules 兜底闭包解析（不 junction）
const HOST_PACKAGES = ['dsh-tools', 'dsh-llm', 'dsh-credentials', 'schemastery'];
const PLUGIN_DIR_NAME = 'dsh-email-bridge';
const PATCH_ENTRY_ID = 'email';
const DEP_SPEC = 'file:vendor/' + PLUGIN_DIR_NAME;   // 相对 profile package.json

// 通用占位默认配置（不绑定任何真实邮箱；真实值在 设置→插件→dsh-email-bridge 卡片填写）
const DEFAULT_PATCH_BLOCK = [
  '- insert:',
  '    - id: ' + PATCH_ENTRY_ID,
  '      name: ' + PLUGIN_DIR_NAME,
  '      config:',
  '        imap:',
  '          host: imap.example.com',
  '          port: 993',
  '          secure: true',
  '          user: you@example.com',
  '          mailbox: INBOX',
  '          idle: true',
  '          pollIntervalSeconds: 60',
  '          markSeen: false',
  '        smtp:',
  '          host: smtp.example.com',
  '          port: 465',
  '          secure: true',
  '          user: you@example.com',
  '          from: you@example.com',
  '        summary:',
  '          maxBodyChars: 2000',
  '        attachments:',
  '          save: true',
  '          dir: ""',
  '          maxBytes: 10485760',
  '',
].join('\n');

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function profileDir(profile) {
  return path.join(dshHome(), 'profiles', profile || 'web');
}

/** app 自带的 vendored 插件目录（打包后 <resources>\vendor\...；开发时 <root>\out\_vendor\...） */
function vendorDir() {
  const candidates = [];
  try {
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vendor', PLUGIN_DIR_NAME));
  } catch (_) { /* 忽略 */ }
  candidates.push(path.join(__dirname, '..', 'out', '_vendor', PLUGIN_DIR_NAME));
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'package.json'))) return c; } catch (_) { /* 忽略 */ }
  }
  return null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function backupFile(file, tag) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-' + tag + '-' + Date.now());
  } catch (_) { /* 备份失败继续（原文件仍在） */ }
}

/**
 * 删除路径（junction/symlink 安全版）：Electron 内置 node 的 fs.rmSync 对 junction
 * 报 ERR_FS_EISDIR，且 recursive 会**穿透 junction 删掉目标内容**（宿主包！）——
 * junction/symlink 一律 unlink（实测 Electron 与系统 node 均安全），真实目录才 recursive。
 * R25（审计补强）：真实目录**内部**也可能嵌着 junction（如 linkMissingHostPackages
 * 建的 @deepseek-ai/*）——recursive 同样会穿透。删除前先递归清掉目录树里所有
 * symlink/junction，再 rmSync。
 */
function removePath(p) {
  let st = null;
  try { st = fs.lstatSync(p); } catch (_) { return; }
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(p); return; } catch (_) { /* 尝试 rmdir 兜底 */ }
    try { fs.rmdirSync(p); } catch (_) { /* 忽略 */ }
    return;
  }
  if (st.isDirectory()) {
    // 先摘掉树内所有 symlink/junction（防止 rmSync recursive 穿透目标）
    const stripLinks = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const child = path.join(dir, e.name);
        let cst = null;
        try { cst = fs.lstatSync(child); } catch (_) { continue; }
        if (cst.isSymbolicLink()) {
          try { fs.unlinkSync(child); } catch (_) { /* 忽略 */ }
        } else if (cst.isDirectory()) {
          stripLinks(child);
        }
      }
    };
    stripLinks(p);
  }
  fs.rmSync(p, { recursive: true, force: true });
}

// ---------------- 1) vendor 源常驻 profile ----------------
function vendorInProfile(profile) {
  return path.join(profile, 'vendor', PLUGIN_DIR_NAME);
}

function ensureVendorCopy(profile, vendor, meta, log) {
  const target = vendorInProfile(profile);
  const marker = path.join(target, '.vendor-meta.json');
  const current = readJson(marker);
  const same = current && current.version === meta.version && current.vendoredAt === meta.vendoredAt;
  if (same && fs.existsSync(path.join(target, 'package.json'))) return false;
  removePath(target);
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(vendor)) {
    fs.cpSync(path.join(vendor, name), path.join(target, name), { recursive: true });
  }
  fs.writeFileSync(marker, JSON.stringify({ version: meta.version, vendoredAt: meta.vendoredAt }, null, 2) + '\n', 'utf8');
  if (log) log('默认插件：vendor 源已就绪 ' + PLUGIN_DIR_NAME + '@' + meta.version + ' → ' + target);
  return true;
}

// ---------------- 2) package.json 依赖声明（防 pnpm 清理的核心） ----------------
function depDeclared(pkgFile) {
  const pkg = readJson(pkgFile);
  return !!(pkg && pkg.dependencies && pkg.dependencies[PLUGIN_DIR_NAME] === DEP_SPEC);
}

function ensureDependency(pkgFile, log) {
  const pkg = readJson(pkgFile);
  if (!pkg) return false;
  if (pkg.dependencies && pkg.dependencies[PLUGIN_DIR_NAME] === DEP_SPEC) return false;
  backupFile(pkgFile, 'defaultplugin');
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies[PLUGIN_DIR_NAME] = DEP_SPEC;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  if (log) log('默认插件：已在 profile package.json 声明 "' + PLUGIN_DIR_NAME + '": "' + DEP_SPEC + '"（防 pnpm 清理）');
  return true;
}

// ---------------- 3) 安装包到 node_modules ----------------
function packageInstalled(profile) {
  return fs.existsSync(path.join(profile, 'node_modules', PLUGIN_DIR_NAME, 'package.json'));
}

/** 已安装副本的标记文件（记录它来自哪一版 vendor——用于新鲜度校验） */
function installedMarkerFile(profile) {
  return path.join(profile, 'node_modules', PLUGIN_DIR_NAME, '.dsh-app-managed.json');
}

function readInstalledMarker(profile) {
  return readJson(installedMarkerFile(profile));
}

/** 已安装副本是否与当前 vendor 内容一致（R26：vendor 更新必须传播到已装副本） */
function installedCopyStale(profile, meta) {
  if (!packageInstalled(profile)) return true;
  const marker = readInstalledMarker(profile);
  // 无标记（pnpm 安装或旧版拷贝）或标记版本不一致 → 需要刷新
  if (!marker || marker.vendoredAt !== meta.vendoredAt) return true;
  return false;
}

function writeInstalledMarker(profile, meta, via) {
  try {
    fs.writeFileSync(installedMarkerFile(profile), JSON.stringify({
      name: meta.name,
      version: meta.version,
      vendoredAt: meta.vendoredAt,
      installedAt: new Date().toISOString(),
      via,
      managedBy: 'dsh-app default-plugins',
    }, null, 2) + '\n', 'utf8');
  } catch (_) { /* 标记写入失败不影响功能（下次会再刷新一次） */ }
}

/** 旧版 junction 清理（指向应用目录，会被构建清空 → 悬空；兜底闭包可用时不再需要） */
function removeHostJunctions(profile, log) {
  const scope = path.join(profile, 'node_modules', PLUGIN_DIR_NAME, 'node_modules', '@deepseek-ai');
  try {
    if (!fs.existsSync(scope)) return;
    let removedAny = false;
    for (const name of fs.readdirSync(scope)) {
      const link = path.join(scope, name);
      let st = null;
      try { st = fs.lstatSync(link); } catch (_) { continue; }
      if (st.isSymbolicLink()) {
        removePath(link);   // Electron 的 rmSync 对 junction 报 EISDIR——removePath 用 unlink
        removedAny = true;
      }
    }
    if (removedAny && log) log('默认插件：已移除旧 junction（改用 dsh 官方 profiles/node_modules 兜底解析）');
  } catch (_) { /* 忽略 */ }
}

/** 兜底闭包缺失时，为缺失的宿主包建 junction（最后手段） */
function linkMissingHostPackages(profile, hostDshDir, log) {
  const fallback = path.join(dshHome(), 'profiles', 'node_modules', '@deepseek-ai');
  const missing = [];
  for (const name of HOST_PACKAGES) {
    if (fs.existsSync(path.join(fallback, name, 'package.json'))) continue;
    missing.push(name);
  }
  if (missing.length === 0) {
    removeHostJunctions(profile, log);
    return { linked: [], removedJunctions: true };
  }
  if (!hostDshDir) return { linked: [], removedJunctions: false, missing };
  const scope = path.join(profile, 'node_modules', PLUGIN_DIR_NAME, 'node_modules', '@deepseek-ai');
  fs.mkdirSync(scope, { recursive: true });
  for (const name of missing) {
    const source = path.join(hostDshDir, 'node_modules', '@deepseek-ai', name);
    const link = path.join(scope, name);
    try {
      if (!fs.existsSync(path.join(source, 'package.json'))) continue;
      removePath(link);
      fs.symlinkSync(source, link, 'junction');
      if (log) log('默认插件：兜底闭包缺失，junction ' + name + ' → 宿主安装（临时手段）');
    } catch (_) { /* 忽略单个失败 */ }
  }
  return { linked: missing, removedJunctions: false };
}

/**
 * 宿主包是否可解析（R24 复核补强）：插件 import '@deepseek-ai/dsh-tools' 等时，
 * Node 会沿 [插件嵌套 node_modules] → [profile node_modules] → [profiles/node_modules
 * 兜底闭包] → [DSH_HOME/node_modules] 逐级查找。四处都没有 ⇒ 插件必然 import 失败
 * ⇒ dsh 整树起不来——这种情况绝不能挂载（或必须摘除已挂载条目）。
 */
function hostPackagesResolvable(profile) {
  const pluginDir = path.join(profile, 'node_modules', PLUGIN_DIR_NAME);
  const roots = [
    path.join(pluginDir, 'node_modules', '@deepseek-ai'),            // junction 兜底
    path.join(profile, 'node_modules', '@deepseek-ai'),              // profile 平铺
    path.join(dshHome(), 'profiles', 'node_modules', '@deepseek-ai'), // dsh 官方兜底闭包
    path.join(dshHome(), 'node_modules', '@deepseek-ai'),            // DSH_HOME 根
  ];
  for (const name of HOST_PACKAGES) {
    const ok = roots.some((root) => fs.existsSync(path.join(root, name, 'package.json')));
    if (!ok) return false;
  }
  return true;
}

// ---------------- 4) cordis.patch.yml 挂载条目 ----------------
// R25（审计修复）：行锚定 + 值边界——旧版 `name:\s*['"]?dsh-email-bridge` 无边界，
// 会误配 `dsh-email-bridge-xxx`、`hostname:`/`username:` 子串、注释行与 id 行缺 ^，
// 导致永不挂载或误删他人条目。
function patchEntryPresent(text) {
  if (!text) return false;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*-\s*id:\s*['"]?email['"]?\s*$/.test(line)) return true;
    if (/^\s*name:\s*['"]?dsh-email-bridge['"]?\s*$/.test(line)) return true;
  }
  return false;
}

function ensurePatchEntry(profile, log, patchBlock) {
  const block = typeof patchBlock === 'string' && patchBlock.trim().length > 0 ? patchBlock : DEFAULT_PATCH_BLOCK;
  const patchFile = path.join(profile, 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(patchFile, 'utf8'); } catch (_) { text = ''; }
  if (patchEntryPresent(text)) return { changed: false, reason: 'already-mounted' };

  let next;
  // 有效内容 = 去掉注释行后的文本（profile 模板是「注释 + []」，不能按整段文本判列表）
  const effective = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n').trim();
  if (effective === '' || effective === '[]') {
    next = text.includes('[]') ? text.replace('[]', block) : text.replace(/\s*$/, '\n') + block;
  } else if (/^-/m.test(effective)) {
    // 已有其他条目：作为新的列表项追加（顶层必须是 YAML 列表，loader 约定如此）
    next = text.replace(/\s*$/, '\n') + block;
  } else {
    return { changed: false, reason: 'patch-not-a-list' };
  }
  try {
    if (text.trim().length > 0) backupFile(patchFile, 'defaultplugin');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(patchFile, next, 'utf8');
    if (log) log('默认插件：已在 cordis.patch.yml 挂载 ' + PLUGIN_DIR_NAME + '（id: ' + PATCH_ENTRY_ID + '）');
    return { changed: true, reason: 'inserted' };
  } catch (err) {
    if (log) log('默认插件：写入 cordis.patch.yml 失败：' + (err && err.message ? err.message : err));
    return { changed: false, reason: 'write-failed' };
  }
}

/** 移除挂载条目（用户经市场卸载后防悬空）；返回是否发生改动。
 *  R25（审计修复）：同时支持 insert 包装块与顶层直写块（`- id: email`）——
 *  旧版只识别 `- insert:`，直写形式摘不掉 → 卸载后悬空仍在 → dsh 启动失败。 */
function removePatchEntry(profile, log) {
  const patchFile = path.join(profile, 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(patchFile, 'utf8'); } catch (_) { return false; }
  if (!patchEntryPresent(text)) return false;
  const lines = text.split(/\r?\n/);
  const kept = [];
  let i = 0;
  let removed = false;
  while (i < lines.length) {
    const line = lines[i];
    if (/^-\s/.test(line)) {
      // 收集整个顶层列表项（到下一个顶层 '- ' 或任何非缩进非空行【含注释】为止——
      // 列注释属于"块外"，不得随块一起被摘掉）
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (/^-\s/.test(l) || (l.trim() !== '' && !/^\s/.test(l))) break;
        j++;
      }
      const block = lines.slice(i, j).join('\n');
      if (patchEntryPresent(block)) {
        removed = true;
        i = j;
        continue;
      }
    }
    kept.push(line);
    i++;
  }
  if (!removed) return false;
  let next = kept.join('\n');
  // 去掉我们的块后若已无任何顶层条目 → 补回 [] 占位（loader 要求列表）
  const effective = next.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n').trim();
  if (effective === '') next = next.replace(/\s*$/, '\n') + '[]\n';
  try {
    backupFile(patchFile, 'defaultplugin-remove');
    fs.writeFileSync(patchFile, next, 'utf8');
    if (log) log('默认插件：检测到插件已被卸载，已同步移除 cordis.patch.yml 挂载条目（防悬空）');
    return true;
  } catch (_) { return false; }
}

// ---------------- 主入口 ----------------

// 进行中闸门（审计高-2）：bootstrap 与 onReady 可能在首次安装（pnpm 30-90s）窗口内
// 并发调用；并发跑 ensureVendorCopy/ensurePatchEntry 会互相踩（removePath+cpSync 竞争）。
// 复用同一个 in-flight Promise，天然串行化。
let installInflight = null;

/**
 * 安装/刷新随 app 分发的默认插件（幂等；并发调用共享同一次执行）。
 * @param {object} opts { hostDshDir, nodeInfo, marketOps, profile, logger, force, patchBlock }
 * @returns {Promise<{ok: boolean, action: string, message: string}>}
 */
async function installDefaultPlugins(opts) {
  if (installInflight) return installInflight;
  installInflight = doInstallDefaultPlugins(opts).finally(() => { installInflight = null; });
  return installInflight;
}

/**
 * @private 实际安装逻辑（经 installDefaultPlugins 的进行中闸门串行执行）
 */
async function doInstallDefaultPlugins(opts) {
  const o = opts || {};
  const log = (m) => { try { if (o.logger && o.logger.appendLog) o.logger.appendLog(m); } catch (_) { /* 忽略 */ } };
  const vendor = vendorDir();
  if (!vendor) return { ok: false, action: 'skip', message: '未找到 vendored 插件（out\\_vendor 缺失）' };
  const meta = readJson(path.join(path.dirname(vendor), 'vendor-meta.json'))
    || readJson(path.join(vendor, '.vendor-meta.json'))
    || { version: '0.0.0', vendoredAt: '' };
  if (!meta.version) return { ok: false, action: 'skip', message: 'vendor-meta.json 缺失或损坏' };

  const profile = profileDir(o.profile);
  const pkgFile = path.join(profile, 'package.json');
  try {
    fs.mkdirSync(profile, { recursive: true });
  } catch (err) {
    return { ok: false, action: 'skip', message: 'profile 目录不可写：' + (err && err.message ? err.message : err) };
  }

  // 1) vendor 源常驻 + 2) 依赖声明（防清理核心）
  let changed = false;
  changed = ensureVendorCopy(profile, vendor, meta, log) || changed;
  if (!fs.existsSync(pkgFile)) {
    // profile 尚未初始化（dsh 未跑过）：写入最小占位，等 dsh initProfile 接管。
    // R25（审计修复）：必须同时写 pnpm-workspace.yaml——dsh 的 profile 约定是
    // nodeLinker:hoisted + autoInstallPeers:false；缺了它 pnpm 默认 isolated +
    // autoInstallPeers=true，会把 peer @deepseek-ai/cordis 拉进 profile（多余实例）
    // 且布局与 dsh 管理的 profile 分叉。
    fs.writeFileSync(pkgFile, JSON.stringify({
      name: 'dsh-profile-web', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
      dependencies: { [PLUGIN_DIR_NAME]: DEP_SPEC },
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8');
    changed = true;
  } else {
    changed = ensureDependency(pkgFile, log) || changed;
  }

  // 3) node_modules 里的包（R26：vendor 内容变了也要刷新已装副本——否则插件更新
  //    只更新了 vendor，profile 里仍是旧代码，表现为"改了没生效"）
  const stale = installedCopyStale(profile, meta);
  let via = packageInstalled(profile) ? 'present' : '';
  if (stale) {
    const alreadyInstalled = packageInstalled(profile);
    if (alreadyInstalled) via = 'refresh';
    // 3a) 全新安装且可用 pnpm 时优先正规安装（dsh plugin add file:vendor/dsh-email-bridge）；
    //     已装副本刷新走拷贝路径（内容确定、离线、快）
    let pnpmOk = false;
    if (!alreadyInstalled) {
      try {
        const marketOps = o.marketOps || ((o.nodeInfo && o.hostDshDir)
          ? new (require('./market').MarketOps)({
              nodeInfo: o.nodeInfo,
              dshBin: path.join(o.hostDshDir, 'lib', 'bin.js'),
              log: (s) => log('[默认插件] ' + s),
            })
          : null);
        if (marketOps) {
          const r = await marketOps.install(DEP_SPEC, (line) => { if (/error|ERR/i.test(line)) log('[pnpm] ' + line); });
          pnpmOk = !!(r && r.ok);
        }
      } catch (err) {
        log('默认插件：pnpm 安装异常：' + (err && err.message ? err.message : err));
      }
    }
    if (pnpmOk && packageInstalled(profile)) {
      via = 'pnpm';
      writeInstalledMarker(profile, meta, 'pnpm');
    } else {
      // 3b) 退回直接拷贝（依赖声明已在，pnpm 之后任何操作会自动从 vendor 重装对齐）
      try {
        const source = vendorInProfile(profile);
        const target = path.join(profile, 'node_modules', PLUGIN_DIR_NAME);
        removePath(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        for (const name of fs.readdirSync(source)) {
          if (name === '.vendor-meta.json') continue;
          fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true });
        }
        if (!alreadyInstalled) via = 'copy';
        writeInstalledMarker(profile, meta, 'copy');
        log('默认插件：已' + (alreadyInstalled ? '刷新' : '安装') + ' profile 内插件副本（vendor ' + meta.vendoredAt + '）');
      } catch (err) {
        return { ok: false, action: 'failed', message: '安装包失败：' + (err && err.message ? err.message : err) };
      }
    }
    if (!packageInstalled(profile)) return { ok: false, action: 'failed', message: '安装后仍未检测到包' };
    changed = true;
  }

  // 4) 宿主包解析：优先 dsh 官方兜底闭包；缺失才 junction
  linkMissingHostPackages(profile, o.hostDshDir, log);
  // 4.5) 复核补强：宿主包仍不可解析 ⇒ 插件 import 必失败 ⇒ 挂载必崩——
  //      绝不挂载；已挂载（旧状态）则摘除，记清原因（等下次环境就绪再装）。
  if (!hostPackagesResolvable(profile)) {
    const removedExisting = removePatchEntry(profile, log);
    if (log) log('默认插件：@deepseek-ai 宿主包不可解析（兜底闭包与 junction 均缺失），'
      + (removedExisting ? '已摘除挂载条目防 dsh 启动失败' : '跳过挂载') + '——待 dsh 完整运行一次生成兜底闭包后会自动装回');
    return { ok: false, action: 'host-unresolvable', message: PLUGIN_DIR_NAME + '@' + meta.version + ' 宿主包不可解析，未挂载' };
  }

  // 5) 挂载条目
  const patch = ensurePatchEntry(profile, log, o.patchBlock);

  const action = changed ? 'installed' : (patch.changed ? 'mounted' : 'ready');
  return { ok: true, action, message: PLUGIN_DIR_NAME + '@' + meta.version + ' / via=' + via + ' / patch=' + patch.reason };
}

/**
 * dsh 启动前的快速自检（廉价 fs 检查；不一致自动修复）。
 * 「挂载条目存在 ⇒ 包必须可解析」，杜绝 2026-09-10 那种悬空条目导致 dsh 无法启动。
 * @param {object} opts { hostDshDir, nodeInfo, marketOps, profile, logger }
 * @returns {Promise<{ok: boolean, action: string, message: string}>}
 */
async function verifyDefaultPlugins(opts) {
  const o = opts || {};
  const log = (m) => { try { if (o.logger && o.logger.appendLog) o.logger.appendLog(m); } catch (_) { /* 忽略 */ } };
  const profile = profileDir(o.profile);
  const patchFile = path.join(profile, 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(patchFile, 'utf8'); } catch (_) { return { ok: true, action: 'noop', message: '未挂载' }; }
  if (!patchEntryPresent(text)) return { ok: true, action: 'noop', message: '未挂载' };

  if (packageInstalled(profile)) {
    // 包在：宿主依赖也必须可解析（兜底闭包被删 + 无 junction = import 必失败）
    if (!hostPackagesResolvable(profile)) {
      linkMissingHostPackages(profile, o.hostDshDir, log);   // 再试一次 junction（可能 hostDshDir 这次可用）
      if (!hostPackagesResolvable(profile)) {
        const removed = removePatchEntry(profile, log);
        if (log) log('默认插件：宿主包不可解析，已' + (removed ? '摘除挂载条目' : '尝试摘除挂载条目') + '防 dsh 启动失败（待兜底闭包恢复后自动装回）');
        return { ok: true, action: removed ? 'entry-removed-host' : 'entry-remove-failed-host', message: '宿主包不可解析，挂载条目已摘除' };
      }
    }
    // 确保 vendor 源没丢（丢了补一份，保证 pnpm 之后能自愈）
    const vendor = vendorDir();
    if (vendor) {
      const meta = readJson(path.join(path.dirname(vendor), 'vendor-meta.json')) || { version: '0.0.0', vendoredAt: '' };
      const marker = readJson(path.join(vendorInProfile(profile), '.vendor-meta.json'));
      if (!marker || marker.version !== meta.version || !fs.existsSync(path.join(vendorInProfile(profile), 'package.json'))) {
        try { ensureVendorCopy(profile, vendor, meta, log); } catch (_) { /* 忽略 */ }
      }
    }
    return { ok: true, action: 'ok', message: '挂载与安装一致' };
  }

  // 挂载了但包不在：
  if (depDeclared(path.join(profile, 'package.json'))) {
    // 依赖声明在 → 包意外丢失（如被清理）→ 修复安装
    const r = await installDefaultPlugins(Object.assign({}, o, { force: false }));
    log('默认插件：检测到包丢失，已自动修复（' + r.action + '：' + r.message + '）');
    // 修复失败且包仍缺失 → 摘除条目兜底（悬空条目会让 dsh 整树启动失败；
    // 摘除后下次环境就绪 ensure 会自动装回）
    if (!packageInstalled(profile)) {
      const removed = removePatchEntry(profile, log);
      if (log) log('默认插件：修复未成功，已' + (removed ? '摘除挂载条目' : '尝试摘除挂载条目') + '（防悬空）');
      return { ok: true, action: removed ? 'entry-removed-repair-failed' : 'entry-remove-failed', message: '包修复失败，条目已兜底摘除' };
    }
    return r;
  }
  // 依赖声明也被移除 → 用户经市场卸载 → 同步移除挂载条目（防悬空）
  const removed = removePatchEntry(profile, log);
  return { ok: true, action: removed ? 'entry-removed' : 'entry-remove-failed', message: '插件已被卸载，挂载条目' + (removed ? '已移除' : '移除失败（请手动处理）') };
}

module.exports = {
  installDefaultPlugins,
  verifyDefaultPlugins,
  removePatchEntry,
  vendorDir,
  profileDir,
  dshHome,
  PLUGIN_DIR_NAME,
  PATCH_ENTRY_ID,
  DEP_SPEC,
  HOST_PACKAGES,
};
