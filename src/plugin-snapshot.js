// plugin-snapshot.js — 迁移快照（个人迁移：绿色目录整体复制到新电脑后，首次运行自动装回插件与 dsh 配置）
//
// 要解决的问题（2026-09-11 需求）：
//   把 out\DSH-App 复制到另一台电脑后，应用壳、内置 dsh、网关配置都能直接用，**但两样东西不在**：
//     ① 用户自己装的插件（在 `~/.dsh/profiles/web`）——新机器上搜索插件没了、邮箱桥接要重填密码；
//     ② dsh 自己的配置（`~/.dsh/settings.yaml` 的模型路由/接入点、`.credentials.yaml` 的供应商密钥、
//        AGENTS.md/皮肤等）——新机器上 dsh 会"不认识任何模型"。
//   两者都在 `~/.dsh`，而 `~/.dsh` 不随绿色目录走。
//
// 做法（快照 + 应用，全部落在**数据目录**里，随绿色目录一起被复制）：
//   1) capture()：
//      · 插件：当前 profile 的插件清单（注册表插件名 + 版本范围）、插件提供的 `dsh.profile.bundles`
//        挂载项、`cordis.patch.yml` 里的用户配置条目（含邮箱账号密码）→ `<data>\plugin-snapshot.json`；
//        并把插件包及其非宿主依赖复制到 `<data>\plugin-bundle\<name>`（离线可装）。
//      · dsh 配置：`~/.dsh` 下的 settings.yaml / .credentials.yaml / AGENTS.md / pet.json /
//        skin-center-active.json 与 .agent-presets、llm-deepseek → `<data>\dsh-config\`。
//   2) applyIfNeeded()：新机器首次启动前读取快照——缺哪个插件装哪个（优先随目录带来的本地包
//      `file:vendor/<名>`，失败回退注册表），补 bundles 与 patch 条目；`~/.dsh` 缺失的配置**按缺失补齐**
//      （已存在的一律不动，尊重目标机器自己的配置）。全程幂等、失败只记日志（绝不阻断 dsh 启动）。
//
// 安全边界：快照含用户配置与凭据（邮箱密码、供应商密钥），因此**只写数据目录**——发布版 zip 会剔除
// `data\`，不会外泄；而个人复制整个目录时它会跟着走，这正是本功能的目的。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
// 时间戳口径与日志一致（缺省北京时间，见 timestamp.js）
const { stamp } = require('./timestamp');

const SNAPSHOT_NAME = 'plugin-snapshot.json';
const APPLIED_NAME = 'plugin-snapshot.applied.json';
const BUNDLE_DIR_NAME = 'plugin-bundle';
const DSH_CONFIG_DIR_NAME = 'dsh-config';
const SCHEMA = 2;
const BUNDLE_COPY_MAX_BYTES = 50 * 1024 * 1024;   // 单插件包体积上限（超过不随包，改为联网安装）
const CONFIG_COPY_MAX_BYTES = 5 * 1024 * 1024;    // dsh 配置类目录的体积上限

// dsh 自身配置中"随目录迁移"的部分（都是纯配置，实测不含本机绝对路径）：
//   settings.yaml        模型路由/接入点、UI、各插件配置（email-bridge / web-search-free …）
//   .credentials.yaml    供应商密钥库
//   AGENTS.md            全局指令
//   pet.json / skin-center-active.json  个性化
// 刻意**不含**：sessions（会话历史，体积大且按需求不需要）、attachments、dsh-chat-import、
//               storages/market/task-board（运行期缓存/状态）。
const DSH_CONFIG_FILES = ['settings.yaml', '.credentials.yaml', 'AGENTS.md', 'pet.json', 'skin-center-active.json'];
const DSH_CONFIG_DIRS = ['.agent-presets', 'llm-deepseek'];

// ---------------- 路径 ----------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function resolveProfileDir(profile) {
  return path.join(dshHome(), 'profiles', profile || 'web');
}

function snapshotPath(dataDir) {
  return path.join(dataDir, SNAPSHOT_NAME);
}

function appliedPath(dataDir) {
  return path.join(dataDir, APPLIED_NAME);
}

function bundleRoot(dataDir) {
  return path.join(dataDir, BUNDLE_DIR_NAME);
}

function bundleDirFor(dataDir, name) {
  return path.join(bundleRoot(dataDir), name);
}

function dshConfigRoot(dataDir) {
  return path.join(dataDir, DSH_CONFIG_DIR_NAME);
}

// ---------------- 小工具 ----------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function backupFile(file, tag) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-' + tag + '-' + Date.now());
  } catch (_) { /* 备份失败继续（原文件仍在） */ }
}

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else if (e.isFile()) total += fs.statSync(f).size;
      } catch (_) { /* 忽略 */ }
    }
  };
  walk(p);
  return total;
}

/** 目录复制（跳过 .bin 之类的软链；插件包本身是普通文件树） */
function copyTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true, dereference: false, errorOnExist: false });
}

/** 文本归一（用于 patch 条目去重/比对：忽略空白差异） */
function normalizeBlock(s) {
  return String(s || '').replace(/\r\n/g, '\n').trim().replace(/[ \t]+$/gm, '');
}

/** 该依赖名是否"宿主内置"（不纳入快照） */
function isHostPackage(name) {
  return !name || name.startsWith('@deepseek-ai/');
}

/** 随包元数据文件名：记录插件的原始注册表规格。
 *  迁移后 profile 里的规格会变成 `file:vendor/<名>`（本地装），没有这份元数据就无法在
 *  下一跳回退注册表安装，也认不出"这仍是用户自己的插件"（曾因此把快照清空、
 *  并把随包目录删掉——第二次复制就丢插件）。 */
const BUNDLE_META_NAME = 'dsh-app-bundle.json';

function bundleMeta(dataDir, name) {
  return readJson(path.join(bundleDirFor(dataDir, name), BUNDLE_META_NAME)) || null;
}

/** 该 file: 规格是否指向 profile 内的 vendor 副本（= 我们迁移时写入的形态） */
function isVendorSpec(name, spec) {
  const s = String(spec || '');
  return s === 'file:vendor/' + name || s.startsWith('file:vendor/' + name + '/');
}

/** 默认插件（邮箱桥接）：由 default-plugins 机制独立负责，不纳入快照 */
function isDefaultPlugin(name) {
  return name === 'dsh-email-bridge';
}

/**
 * 把插件的**非宿主依赖**从 profile 的（hoisted）node_modules 一起复制进随包目录，
 * 使新机器上的 `file:` 安装无需联网解析依赖。
 * @returns {string[]} 实际带走的依赖名
 */
function copyPluginDeps(profile, pluginName, bundleDir, log) {
  const out = [];
  const pkg = readJson(path.join(profile, 'node_modules', pluginName, 'package.json'));
  const deps = Object.keys((pkg && pkg.dependencies) || {});
  for (const d of deps) {
    if (d.startsWith('@deepseek-ai/')) continue;    // 宿主包由 default-plugins 负责链接
    const from = path.join(profile, 'node_modules', d);
    if (!fs.existsSync(path.join(from, 'package.json'))) continue;
    let size = 0;
    try { size = dirSize(from); } catch (_) { /* 忽略 */ }
    if (size > BUNDLE_COPY_MAX_BYTES) {
      if (log) log('依赖 ' + d + ' 体积过大，未随包（新机器将联网解析）');
      continue;
    }
    try {
      copyTree(from, path.join(bundleDir, 'node_modules', d));
      out.push(d);
    } catch (err) {
      if (log) log('依赖复制失败（' + d + '）：' + (err && err.message ? err.message : err));
    }
  }
  return out;
}

// ---------------- cordis.patch.yml 顶层条目解析 ----------------

/**
 * 把 patch 文件切成顶层"`- ` 开头的列表项"。
 * 返回 { isList, blocks: string[] } —— isList=false 表示文件结构不是顶层列表（不参与合并）。
 */
function splitPatchBlocks(text) {
  if (typeof text !== 'string') return { isList: false, blocks: [] };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let cur = null;
  let sawItem = false;
  for (const line of lines) {
    if (/^-\s/.test(line) || line.trim() === '-') {
      if (cur !== null) blocks.push(cur.join('\n'));
      cur = [line];
      sawItem = true;
    } else if (cur !== null) {
      cur.push(line);
    }
  }
  if (cur !== null) blocks.push(cur.join('\n'));
  const cleaned = blocks
    .map((b) => b.replace(/\n+(#[^\n]*\n?)*\s*$/g, '').trim())   // 去掉条目尾部的空行/尾随注释
    .filter((b) => b.length > 0);
  return { isList: sawItem, blocks: cleaned };
}

/** patch 条目里引用到的包名（`name: xxx` 或裸包名出现） */
function blockReferences(block, names) {
  const b = String(block || '');
  for (const n of names) {
    if (!n) continue;
    if (b.includes(n)) return true;
  }
  return false;
}

// ---------------- ① 采集快照 ----------------

/**
 * 采集当前 profile 的插件快照到数据目录。
 * @param {object} o { dataDir, profile, log }
 * @returns {{ok:boolean, action:string, message:string, snapshot?:object}}
 */
function capture(o) {
  const log = (o && o.log) || (() => { });
  const dataDir = o && o.dataDir;
  if (!dataDir) return { ok: false, action: 'skip', message: '缺少数据目录' };
  const profile = resolveProfileDir(o.profile);
  const pkgFile = path.join(profile, 'package.json');
  const pkg = readJson(pkgFile);
  if (!pkg) return { ok: false, action: 'skip', message: 'profile 尚未生成（' + profile + '）' };

  const deps = (pkg && pkg.dependencies) || {};
  const allNames = Object.keys(deps);
  const plugins = [];
  for (const name of allNames) {
    const spec = String(deps[name] || '');
    if (isHostPackage(name)) continue;                       // @deepseek-ai/* 宿主包
    if (isDefaultPlugin(name)) continue;                     // 默认插件机制独立负责
    if (spec.startsWith('file:')) {
      // 迁移后本地装的插件（file:vendor/<名>）仍要留在快照里，否则第二次复制就丢插件。
      // 规格取随包元数据里记着的**原始注册表规格**（registry 回退时用）。
      if (!isVendorSpec(name, spec)) continue;               // 其它本地路径依赖：不认，跳过
      const meta = bundleMeta(dataDir, name);
      plugins.push({ name, spec: (meta && meta.spec) || null, localSpec: spec, fromVendor: true });
      continue;
    }
    plugins.push({ name, spec });
  }
  plugins.sort((a, b) => (a.name < b.name ? -1 : 1));

  // 插件自带的 bundle 挂载（dsh.profile.bundles 里非宿主包的那部分）
  const bundles = (((pkg.dsh || {}).profile || {}).bundles || [])
    .filter((n) => typeof n === 'string' && n && !n.startsWith('@deepseek-ai/'));
  // 插件相关的用户 patch 条目（含配置：邮箱账号/SMTP 密码、搜索提供方禁停等）
  // 注意：**全量采集**顶层条目。只挑"提到插件名"的条目会漏掉间接配置——例如
  // `- id: web-search-deepseek / disabled: true` 这条并不含插件名字符串，却是搜索插件
  // 正常工作的配套配置。个人迁移场景下"把我自己的配置带回来"才是目的；应用时只补缺失、
  // 同 id 用来源机器的配置覆盖本机占位（见 applyIfNeeded），不会破坏目标机已有内容。
  const patchFile = path.join(profile, 'cordis.patch.yml');
  const patchText = readText(patchFile);
  const parsed = splitPatchBlocks(patchText || '');
  const patchEntries = parsed.isList ? parsed.blocks.slice() : [];
  const relatedCount = patchEntries.filter((b) => blockReferences(b, allNames)).length;
  if (patchText && !parsed.isList) log('patch 文件不是顶层列表结构，本次不采集挂载条目');

  // 把插件包本身复制到数据目录（离线可装；体积过大则不复制，改为联网安装）
  const bundled = [];
  let copyFail = 0;
  for (const p of plugins) {
    const src = path.join(profile, 'node_modules', p.name);
    if (!fs.existsSync(path.join(src, 'package.json'))) continue;
    let size = 0;
    try { size = dirSize(src); } catch (_) { /* 忽略 */ }
    if (size > BUNDLE_COPY_MAX_BYTES) {
      log('插件 ' + p.name + ' 体积 ' + Math.round(size / 1048576) + 'MB，超过随包上限——新机器将改为联网安装');
      continue;
    }
    try {
      const dst = bundleDirFor(dataDir, p.name);
      copyTree(src, dst);
      // 连同它的**非宿主依赖**一起带走（pnpm 的 hoisted 布局里依赖是同级目录）：
      // 只带插件本体的话，新机器上 pnpm 仍要联网解析依赖；带上即可离线装。
      const depsCopied = copyPluginDeps(profile, p.name, dst, log);
      // 记下"原始注册表规格"：迁移后 profile 里只剩 file: 规格，没有它下一跳就无法回退注册表，
      // 也认不出这是用户插件（历史上曾因此把快照清空并把随包目录删掉）
      const prevMeta = bundleMeta(dataDir, p.name);
      const specForMeta = (p.spec && !String(p.spec).startsWith('file:'))
        ? p.spec
        : ((prevMeta && prevMeta.spec) || null);
      try {
        fs.writeFileSync(path.join(dst, BUNDLE_META_NAME), JSON.stringify({
          name: p.name,
          spec: specForMeta,
          bundledDeps: depsCopied,
          capturedAt: new Date().toISOString(),
          capturedAtLocal: stamp(),
          capturedFrom: os.hostname() + '|' + os.userInfo().username,
        }, null, 2), 'utf8');
      } catch (_) { /* 元数据写失败不影响随包本身 */ }
      p.bundled = true;
      if (specForMeta && !p.spec) p.spec = specForMeta;   // 补齐快照里的规格（供下一跳注册表回退）
      if (depsCopied) p.bundledDeps = depsCopied;
      bundled.push(p.name);
    } catch (err) {
      copyFail++;
      log('插件包复制失败（' + p.name + '）：' + (err && err.message ? err.message : err));
    }
  }

  // 清理已不在插件清单里的旧随包目录（卸载过的插件不该继续随包走）
  try {
    const root = bundleRoot(dataDir);
    if (fs.existsSync(root)) {
      for (const d of fs.readdirSync(root)) {
        if (!plugins.some((p) => p.name === d && p.bundled)) {
          fs.rmSync(path.join(root, d), { recursive: true, force: true });
        }
      }
    }
  } catch (_) { /* 忽略 */ }

  // dsh 自身配置（settings.yaml / .credentials.yaml / AGENTS.md / …）→ 数据目录
  const dshConfig = captureDshConfig(dataDir, log);

  const snapshot = {
    schema: SCHEMA,
    capturedAt: new Date().toISOString(),
    capturedAtLocal: stamp(),     // 人类可读（北京时间口径，与日志一致）
    machine: os.hostname(),
    user: os.userInfo().username,
    dshHome: dshHome(),
    profile: o.profile || 'web',
    plugins,
    bundles,
    patchEntries,
    dshConfig,
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    writeJsonAtomic(snapshotPath(dataDir), snapshot);
  } catch (err) {
    return { ok: false, action: 'failed', message: '快照写入失败：' + (err && err.message ? err.message : err) };
  }
  return {
    ok: true,
    action: 'captured',
    message: plugins.length + ' 个插件（随包 ' + bundled.length + ' 个）'
      + (bundles.length ? ' / bundle 挂载 ' + bundles.length : '')
      + (patchEntries.length ? ' / 配置条目 ' + patchEntries.length + '（其中 ' + relatedCount + ' 条直接关联插件）' : '')
      + (copyFail ? ' / 复制失败 ' + copyFail : ''),
    snapshot,
  };
}

// ---------------- ①b 采集/恢复 dsh 自身配置 ----------------

/** 把 `~/.dsh` 下的配置文件/小目录复制进数据目录，返回清单 */
function captureDshConfig(dataDir, log) {
  const home = dshHome();
  const root = dshConfigRoot(dataDir);
  const files = [];
  const dirs = [];
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const f of DSH_CONFIG_FILES) {
      const src = path.join(home, f);
      try {
        if (!fs.statSync(src).isFile()) continue;
        fs.copyFileSync(src, path.join(root, f));
        files.push(f);
      } catch (_) { /* 不存在则跳过 */ }
    }
    for (const d of DSH_CONFIG_DIRS) {
      const src = path.join(home, d);
      try {
        if (!fs.statSync(src).isDirectory()) continue;
        const size = dirSize(src);
        if (size > CONFIG_COPY_MAX_BYTES) {
          if (log) log('配置目录 ' + d + ' 体积 ' + Math.round(size / 1048576) + 'MB，超过上限未随包');
          continue;
        }
        copyTree(src, path.join(root, d));
        dirs.push(d);
      } catch (_) { /* 不存在则跳过 */ }
    }
  } catch (err) {
    if (log) log('dsh 配置采集失败：' + (err && err.message ? err.message : err));
  }
  return { files, dirs };
}

/** 配置副本是否"有内容"（空文件不覆盖目标机器） */
function fileHasContent(p) {
  try { return fs.statSync(p).size > 0; } catch (_) { return false; }
}

/**
 * 按缺失补齐 dsh 配置：目标 `~/.dsh` 里**已存在的文件一律不动**（尊重目标机器自己的配置），
 * 缺失的才从快照恢复。返回恢复的文件名列表。
 */
function restoreDshConfig(dataDir, log) {
  const home = dshHome();
  const root = dshConfigRoot(dataDir);
  const snap = readJson(snapshotPath(dataDir)) || {};
  const list = (snap.dshConfig && snap.dshConfig.files) || [];
  const dirList = (snap.dshConfig && snap.dshConfig.dirs) || [];
  const restored = [];
  const restoredDirs = [];
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch (err) {
    if (log) log('无法创建 ' + home + '：' + (err && err.message ? err.message : err));
  }
  for (const f of list) {
    const src = path.join(root, f);
    const dst = path.join(home, f);
    if (!fileHasContent(src)) continue;
    if (fs.existsSync(dst) && fileHasContent(dst)) continue;   // 目标已有内容 → 不动
    try {
      if (fs.existsSync(dst)) backupFile(dst, 'snapshot');     // 空文件才被覆盖，仍留备份
      fs.copyFileSync(src, dst);
      restored.push(f);
    } catch (err) {
      if (log) log('恢复 ' + f + ' 失败：' + (err && err.message ? err.message : err));
    }
  }
  for (const d of dirList) {
    const src = path.join(root, d);
    const dst = path.join(home, d);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) continue;                          // 目标已有该目录 → 不动
    try {
      copyTree(src, dst);
      restoredDirs.push(d);
    } catch (err) {
      if (log) log('恢复目录 ' + d + ' 失败：' + (err && err.message ? err.message : err));
    }
  }
  if (restored.length) log('已恢复 dsh 配置（目标机缺失的部分）：' + restored.join(', '));
  if (restoredDirs.length) log('已恢复配置目录：' + restoredDirs.join(', '));
  return { files: restored, dirs: restoredDirs };
}

// ---------------- ② 应用快照（新机器首次运行） ----------------

function pluginPresent(profile, name) {
  return fs.existsSync(path.join(profile, 'node_modules', name, 'package.json'));
}

/** 删除路径（junction 安全）：junction/symlink 用 unlink，真实目录才 recursive 删 */
function removePathSafe(p) {
  let st = null;
  try { st = fs.lstatSync(p); } catch (_) { return; }
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(p); } catch (_) { try { fs.rmdirSync(p); } catch (_) { /* 忽略 */ } }
    return;
  }
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
}

/** Node 解析宿主包时的查找根（与 default-plugins.hostPackagesResolvable 同序） */
function hostResolveRoots() {
  return [
    path.join(dshHome(), 'profiles', 'node_modules', '@deepseek-ai'),   // dsh 官方兜底闭包
    path.join(dshHome(), 'node_modules', '@deepseek-ai'),               // DSH_HOME 根
  ];
}

/**
 * 让已安装插件的 `@deepseek-ai/*` 依赖在**目标机本地**可解析：
 *   · 先在既有查找根（profiles/node_modules 等）里找；
 *   · 找不到就从 dsh 安装目录 junction 一份到 `<profile>/node_modules/@deepseek-ai/<名>`。
 * 目的：dsh 启动时在 profile 里跑 pnpm 时无需访问注册表（冷机器/受限网络下那是 30-60 秒的等待）。
 * @returns {string[]} 实际建立链接的包名
 */
function linkHostDepsForPlugins(profile, hostDshDir, pluginNames, log) {
  const needed = new Set();
  for (const name of pluginNames || []) {
    const pkg = readJson(path.join(profile, 'node_modules', name, 'package.json'));
    for (const d of Object.keys((pkg && pkg.dependencies) || {})) {
      if (d.startsWith('@deepseek-ai/')) needed.add(d);
    }
  }
  if (needed.size === 0) return [];
  const roots = hostResolveRoots();
  const scope = path.join(profile, 'node_modules', '@deepseek-ai');
  const linked = [];
  for (const dep of needed) {
    const resolvable = roots.some((r) => fs.existsSync(path.join(r, dep, 'package.json')));
    if (resolvable) continue;                                    // 已有兜底闭包 → 不动
    if (!hostDshDir) continue;
    const source = path.join(hostDshDir, 'node_modules', dep);
    if (!fs.existsSync(path.join(source, 'package.json'))) continue;
    try {
      fs.mkdirSync(path.dirname(path.join(scope, dep)), { recursive: true });
      removePathSafe(path.join(scope, dep));
      fs.symlinkSync(source, path.join(scope, dep), 'junction');
      linked.push(dep);
    } catch (err) {
      if (log) log('宿主依赖链接失败（' + dep + '）：' + (err && err.message ? err.message : err));
    }
  }
  if (linked.length && log) log('已把宿主依赖链接到 profile（离线解析，启动不再等网络）：' + linked.join(', '));
  return linked;
}

/**
 * 应用快照：把缺失的插件装回 profile，并补齐 bundles 与 patch 挂载条目。
 * 幂等：全部已就位时只做一次文件读取，不触发任何安装。
 * @param {object} o { dataDir, profile, marketOps, log, force }
 */
async function applyIfNeeded(o) {
  const log = (o && o.log) || (() => { });
  const dataDir = o && o.dataDir;
  if (!dataDir) return { ok: false, action: 'skip', message: '缺少数据目录' };
  const snap = readJson(snapshotPath(dataDir));
  if (!snap || !Array.isArray(snap.plugins)) {
    return { ok: true, action: 'noop', message: '无插件快照（本机自用，无需迁移）' };
  }
  const profilePath = resolveProfileDir(o.profile || snap.profile);
  const pkgFile = path.join(profilePath, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    // profile 还没生成（dsh 从未启动过）→ 交给下次启动；不阻断
    return { ok: true, action: 'deferred', message: 'profile 尚未生成，等待 dsh 首次启动后再应用' };
  }
  const pkg = readJson(pkgFile) || {};
  const deps = pkg.dependencies || {};
  const installed = [];
  const failed = [];

  // 0) 本机是否已应用过（数据目录会跟着复制走 → 用机器指纹区分：
  //    已应用的机器上不再自动装回，尊重用户之后的手工卸载；换机器则重新装回）
  const markerPrev = readJson(appliedPath(dataDir));
  const sameMachine = !!(markerPrev && markerPrev.machine === machineId());
  if (sameMachine && !(o && o.force)) {
    return { ok: true, action: 'ready', message: '本机已应用过快照（' + (markerPrev.appliedAtLocal || markerPrev.appliedAt) + '）——不再自动装回，尊重此后的人工改动' };
  }

  // 1) 缺哪个装哪个（优先随包本地目录，失败回退注册表）
  for (const p of snap.plugins) {
    if (!p || !p.name) continue;
    if (deps[p.name] && pluginPresent(profilePath, p.name) && !(o && o.force)) continue;
    const local = bundleDirFor(dataDir, p.name);
    const hasLocal = fs.existsSync(path.join(local, 'package.json'));
    const specRemote = p.spec ? p.name + '@' + p.spec : p.name;   // 回退：按快照里的版本范围从注册表装
    let done = false;
    if (hasLocal && o.marketOps && typeof o.marketOps.install === 'function') {
      // 与「默认插件」同款做法：先把随包目录放进 profile 的 vendor\（pnpm 不管这个目录），
      // 再用**相对规格** `file:vendor/<name>` 安装——这样：
      //   ① 不带盘符/绝对路径，直接过 MarketOps 的 file: 白名单校验（绝对路径会被拒）；
      //   ② 插件源码常驻 profile，之后任何 pnpm 操作都能从 vendor 自愈重装。
      const vendorDst = path.join(profilePath, 'vendor', p.name);
      try {
        copyTree(local, vendorDst);
        fs.rmSync(path.join(vendorDst, BUNDLE_META_NAME), { force: true });   // 随包元数据不进 profile
      } catch (err) {
        log('随包插件复制到 profile\\vendor 失败（' + p.name + '）：' + (err && err.message ? err.message : err));
      }
      const specLocal = 'file:vendor/' + p.name;
      log('安装插件（随包本地）' + p.name + ' …');
      const r = await o.marketOps.install(specLocal, (line) => { if (/error|ERR/i.test(line)) log('[pnpm] ' + line); }, { allowFile: true });
      done = !!(r && r.ok) || (!!(readJson(pkgFile) || {}).dependencies?.[p.name] && pluginPresent(profilePath, p.name));
      if (!done) log('随包本地安装失败（' + p.name + '）→ 回退注册表安装');
    }
    if (!done && o.marketOps && typeof o.marketOps.install === 'function') {
      log('安装插件（注册表）' + specRemote + ' …');
      const r = await o.marketOps.install(specRemote, (line) => { if (/error|ERR/i.test(line)) log('[pnpm] ' + line); });
      done = !!(r && r.ok);
    }
    const nowPkg = readJson(pkgFile) || {};
    done = done || !!((nowPkg.dependencies || {})[p.name] && pluginPresent(profilePath, p.name));
    if (done) installed.push(p.name); else failed.push(p.name);
  }

  // 1.5) 让插件的**宿主依赖**在目标机本地可解析（离线化）：
  //      dsh 每次启动都会在 profile 里跑 pnpm 同步依赖；插件的 `@deepseek-ai/*` 依赖若只能从
  //      注册表取，冷机器/受限网络下每次启动都要等网络超时（实测新机器启动 53-69 秒的
  //      头号嫌疑）。用 junction 直接指向 dsh 安装目录里的同名包即可完全离线解析。
  let hostLinked = [];
  try {
    hostLinked = linkHostDepsForPlugins(profilePath, o.hostDshDir, installed, log);
  } catch (err) {
    log('宿主依赖链接失败：' + (err && err.message ? err.message : err));
  }

  // 2) 补齐 bundle 挂载（dsh.profile.bundles）
  let bundlesAdded = 0;
  const bundlesAddedNames = [];
  try {
    const want = (snap.bundles || []).filter((n) => typeof n === 'string' && n);
    if (want.length) {
      const cur = readJson(pkgFile) || {};
      cur.dsh = cur.dsh || {};
      cur.dsh.profile = cur.dsh.profile || {};
      const list = Array.isArray(cur.dsh.profile.bundles) ? cur.dsh.profile.bundles.slice() : [];
      for (const n of want) {
        if (!list.includes(n)) { list.push(n); bundlesAdded++; bundlesAddedNames.push(n); }
      }
      if (bundlesAdded > 0) {
        cur.dsh.profile.bundles = list;
        backupFile(pkgFile, 'pluginsnapshot');
        writeJsonAtomic(pkgFile, cur);
        log('已补挂 bundle：' + bundlesAddedNames.join(', '));
      }
    }
  } catch (err) {
    log('bundle 挂载补齐失败：' + (err && err.message ? err.message : err));
  }

  // 3) 合并 cordis.patch.yml（只补不覆盖 + 同 id 用来源机器的配置替换本机占位；写前备份）
  //    为什么需要"同 id 替换"：新机器上「默认插件」机制会**先**写一份占位配置（邮箱桥接的
  //    空账号），随后本次应用才跑——若只按文本追加，会出现两条 `insert: id: email`，
  //    轻则重复挂载、重则加载器报错。用户自己机器上的那份才是真配置，替换它即可。
  let patchAdded = 0;
  let patchReplaced = 0;
  try {
    const patchFile = path.join(profilePath, 'cordis.patch.yml');
    const text = readText(patchFile);
    const snapBlocks = (snap.patchEntries || []).map((b) => String(b).replace(/\r\n/g, '\n').trim()).filter(Boolean);
    if (snapBlocks.length) {
      const cur = splitPatchBlocks(text || '');
      const curBlocks = cur.isList ? cur.blocks.slice() : [];
      const existingNorm = normalizeBlock(text || '');
      const next = curBlocks.slice();
      const idOf = (b) => {
        const m = /(^|\n)\s*-?\s*id:\s*([^\s#]+)/.exec('\n' + String(b));
        return m ? m[2] : null;
      };
      const addedNames = [];
      for (const b of snapBlocks) {
        const nb = normalizeBlock(b);
        if (!nb || existingNorm.includes(nb)) continue;      // 已在文件里（文本级）
        const id = idOf(b);
        const idx = id ? next.findIndex((x) => idOf(x) === id) : -1;
        if (idx >= 0) {
          // 同 id 的占位条目 → 用来源机器的真配置替换
          next[idx] = b;
          patchReplaced++;
          continue;
        }
        next.push(b);
        patchAdded++;
        addedNames.push(id || '(匿名条目)');
      }
      if (patchAdded || patchReplaced) {
        const header = '# ── 以下条目由 dsh-app 插件迁移快照同步（来源机器：' + (snap.machine || '未知')
          + ' @ ' + (snap.capturedAtLocal || snap.capturedAt || '') + '）──\n';
        const out = (cur.isList ? header : header) + next.join('\n\n') + '\n';
        backupFile(patchFile, 'pluginsnapshot');
        fs.writeFileSync(patchFile, out, 'utf8');
        if (patchAdded) log('已补回 ' + patchAdded + ' 条 cordis.patch.yml 条目：' + addedNames.join(', '));
        if (patchReplaced) log('已用本机迁移快照的配置替换 ' + patchReplaced + ' 条同 id 占位条目');
      }
    }
  } catch (err) {
    log('patch 条目合并失败：' + (err && err.message ? err.message : err));
  }

  // 3.5) 恢复 dsh 自身配置（settings.yaml/.credentials.yaml/…）：目标机缺失的才补
  //      ——在 dsh 启动前完成，新机器首次启动就"已经认识所有模型与密钥"。
  let configRestored = { files: [], dirs: [] };
  try {
    configRestored = restoreDshConfig(dataDir, log);
  } catch (err) {
    log('dsh 配置恢复失败：' + (err && err.message ? err.message : err));
  }

  const result = {
    ok: failed.length === 0,
    action: (installed.length || bundlesAdded || patchAdded || patchReplaced || configRestored.files.length || configRestored.dirs.length) ? 'applied' : 'ready',
    message: '插件 ' + installed.length + '/' + snap.plugins.length
      + (failed.length ? '（失败：' + failed.join(', ') + '）' : '')
      + (bundlesAdded ? ' / bundle +' + bundlesAdded : '')
      + (patchAdded ? ' / 配置条目 +' + patchAdded : '')
      + (patchReplaced ? ' / 同 id 配置替换 ' + patchReplaced : '')
      + (configRestored.files.length ? ' / dsh 配置恢复 ' + configRestored.files.join(',') : '')
      + (hostLinked.length ? ' / 宿主依赖本地链接 ' + hostLinked.join(',') : ''),
    installed,
    failed,
    configRestored: configRestored.files,
    hostLinked,
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    writeJsonAtomic(appliedPath(dataDir), Object.assign({
      appliedAt: new Date().toISOString(),
      appliedAtLocal: stamp(),
      machine: machineId(),   // 机器指纹：决定下次是否还需要应用（见上面的 sameMachine）
    }, result));
  } catch (_) { /* 标记写失败不影响本次结果 */ }
  return result;
}

/** 本机指纹（决定"快照是否已在本机应用过"）：数据目录会随绿色目录复制到别的电脑，
 *  只有指纹不同才需要重新应用——否则「在新机器上卸载了某个插件」会被下次启动装回去。 */
function machineId() {
  let user = '';
  try { user = os.userInfo().username; } catch (_) { user = process.env.USERNAME || ''; }
  return (os.hostname() || '') + '|' + user;
}

/** 快照概要（日志/诊断用） */
function status(dataDir) {
  const snap = readJson(snapshotPath(dataDir));
  if (!snap) return { exists: false };
  const applied = readJson(appliedPath(dataDir));
  return {
    exists: true,
    capturedAt: snap.capturedAt,
    capturedAtLocal: snap.capturedAtLocal,
    plugins: (snap.plugins || []).map((p) => p.name + (p.bundled ? '（随包）' : '')),
    bundles: snap.bundles || [],
    patchEntries: (snap.patchEntries || []).length,
    dshConfig: snap.dshConfig || { files: [], dirs: [] },
    appliedAt: applied ? (applied.appliedAtLocal || applied.appliedAt) : null,
  };
}

module.exports = {
  capture,
  applyIfNeeded,
  status,
  snapshotPath,
  appliedPath,
  bundleDirFor,
  dshConfigRoot,
  splitPatchBlocks,
  resolveProfileDir,
  SNAPSHOT_NAME,
  BUNDLE_DIR_NAME,
  DSH_CONFIG_DIR_NAME,
  DSH_CONFIG_FILES,
};
