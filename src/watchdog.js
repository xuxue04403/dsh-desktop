// watchdog.js — 启动看门狗 + 安全模式
//
// 根因背景：dsh 的插件加载器对「任一插件 apply 失败」采取 fail-loud（整体启动失败并回滚），
// 一个坏插件即可让 dsh web 起不来（且管理插件的 UI 恰在服务内，形成死锁）。
// 本模块在壳层兜底（不依赖上游改动）：
//   Level 1：解析失败日志插件名 → `--dump-config` 匹配条目 id → 写 safe.yml（disabled:true）→ 带 --patch 重启；
//   Level 2：无法定位条目时，备份 profile 配置并临时剥离全部第三方插件 → 启动 → 一键恢复。
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
// 可移植性修复（2026-09-11）：workDir 可能来自另一台电脑 → cwd 无效会让 spawnSync 抛 ENOENT
const { workDirOrHome } = require('./paths');

// 0.1.x 启动失败报错形态：
//   形态1: dsh: plugin(s) failed to load: a, b; Cordis startup failed because ...
//   形态2: dsh: N entr(ies) did not activate\n<name>: <错误摘要>\n(堆栈行…)
//   形态3（R24，2026-09-10 事故）: failed to import/apply loader entry <id> (<包名>) ——
//   挂载条目指向的包丢失/损坏（如被 pnpm 清理）时**整棵插件树拒绝启动**；捕获包名
//   （缺省用条目 id），走 Level 1 隔离让 dsh 仍能启动（dump-config 的 name 字段是
//   包名，resolveEntryIds 按包名配对条目 id）。
const RE_FAILED_TO_LOAD = /plugin\(s\) failed to load:\s*([^;]+)/;
const RE_DID_NOT_ACTIVATE = /(\d+)\s+entr(?:y|ies)\s+did\s+not\s+activate\s+([\s\S]*?)(?:\r?\n\s*\r?\n|$)/;
const RE_LOADER_ENTRY_FAILED = /failed to (?:import|apply) loader entry\s+(\S+?)(?:\s+\(([^)]+)\))?[\s:]/g;

// 从 dsh 启动日志提取"失败插件名"（跨版本容错）
function parseFailedPlugins(logText) {
  const names = [];
  if (!logText) return names;
  const m1 = RE_FAILED_TO_LOAD.exec(logText);
  if (m1) {
    for (const s of m1[1].split(',')) {
      const t = s.trim();
      if (t) names.push(t);
    }
  }
  const m2 = RE_DID_NOT_ACTIVATE.exec(logText);
  if (m2) {
    for (const raw of m2[2].split('\n')) {
      const t = raw.replace(/\r$/, '');
      if (!t || t[0] === ' ' || t[0] === '\t') continue;   // 跳过错行/堆栈缩进行
      const ci = t.indexOf(': ');
      if (ci > 0) names.push(t.slice(0, ci).trim());
    }
  }
  // 形态3：failed to import/apply loader entry —— 取**最内层**匹配（外层的
  // "loader entry include (cordis:include)" 是包装条目，真正失败的是内层插件）；
  // cordis:* 核心包装不可隔离，跳过。R25（审计）：收集**全部**有效 token——
  // 双插件同时故障时只禁用一个会导致第二次失败（旧版如此）。
  const entryMatches = [...logText.matchAll(RE_LOADER_ENTRY_FAILED)];
  if (entryMatches.length > 0) {
    // 收集全部有效 token（按文档序）；cordis:* 核心包装不可隔离，跳过
    for (const m of entryMatches) {
      const token = (m[2] || m[1] || '').trim();
      if (!token || /^cordis:/.test(token)) continue;
      if (!names.includes(token)) names.push(token);
    }
  }
  // 去重（保序）
  return names.filter((n, i) => names.indexOf(n) === i);
}

// 从 dump-config 的 YAML 文本解析 id→name 映射，返回与失败插件名匹配的条目 id
function resolveEntryIds(yaml, names) {
  const ids = [];
  if (!yaml || !names || !names.length) return ids;
  const nameSet = new Set(names.map((n) => String(n).trim()));
  const idByName = new Map();
  let curId = null;
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (t.startsWith('- id:')) curId = t.slice(5).trim().replace(/^["']|["']$/g, '');
    else if (t.startsWith('id:') && line[0] !== ' ') curId = t.slice(3).trim().replace(/^["']|["']$/g, '');
    else if (curId && t.startsWith('name:')) {
      const nm = t.slice(5).trim().replace(/^["']|["']$/g, '');
      if (nm && !idByName.has(nm)) idByName.set(nm, curId);
    } else if (curId && line[0] !== ' ' && line[0] !== '\t'
      && !t.startsWith('id:') && !t.startsWith('name:') && !t.startsWith('-')) {
      curId = null;   // 顶层出现其他键 → 停止配对
    }
    if (curId === '') curId = null;
  }
  const seen = new Set();
  for (const [name, id] of idByName) {
    if (nameSet.has(name) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

class Watchdog {
  /**
   * @param {object} opts { settings, launcher, state, logger, workDir }
   */
  constructor(opts) {
    this.settings = opts.settings;
    this.launcher = opts.launcher;
    this.state = opts.state;
    this.log = opts.logger.appendLog.bind(opts.logger);
    this.workDir = opts.workDir;
    this.triggered = false;
    // R25（审计）：尊重 DSH_HOME（与 default-plugins/market 一致；旧版硬编码 homedir）
    this.profileDir = path.join(
      process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'web',
    );
  }

  // 启动失败（未就绪即退出 / 或等待超时）时由 main 调用
  async tryRecover() {
    const logPath = path.join(this.settings.dir, 'logs', 'web.log');
    let logText = '';
    try {
      if (fs.existsSync(logPath)) {
        // R25（审计修复）：基线是**字节**数（logger.webLogSize 用 stat.size），旧版用
        // 字符串 length（字符数）切片——CJK 日志下错位，会把历史故障行当本次输出
        // （假安全模式）或切掉本次输出（漏报）。改为 Buffer 字节切分；轮转后
        // buf < base 时整文件即纯新内容，语义正确。
        const buf = fs.readFileSync(logPath);
        const base = (this.launcher && this.launcher.webLogBaseline) || 0;
        logText = base > 0 && buf.length > base ? buf.slice(base).toString('utf8') : buf.toString('utf8');
      }
    } catch (_) { /* 忽略 */ }
    const names = parseFailedPlugins(logText);

    const data = this.settings.data;

    // R25 复核（审计 P1）：本轮已触发过看门狗且**已在安全模式**（Level 1/2 重启后再次
    // 失败）→ 终止自动尝试并给出**终态**。旧版在这里直接 `return`，使下面「安全模式也
    // 未能启动服务」分支在同进程内不可达：UI 永久停在"正在重启…"，既没有失败原因，
    // 也拿不到「退出安全模式」入口（用户只能杀进程/手删配置）。
    if (this.triggered && data.safeMode) {
      this.state.update({
        service: 'failed',
        phase: '安全模式也未能启动服务',
        failReason: 'dsh 在禁用故障插件后仍无法启动。' + (names.length
          ? '（日志仍显示：' + names.join(', ') + '）'
          : '（日志未显示插件故障，请检查端口/网络/工作目录）'),
      });
      this.log('安全模式启动失败，等待用户处理（可在状态页「退出安全模式」恢复正常启动）。');
      return;
    }
    this.triggered = true;

    if (data.safeMode) {
      // 安全模式下仍失败：停止自动尝试，交还用户
      this.state.update({
        service: 'failed',
        phase: '安全模式也未能启动服务',
        failReason: 'dsh 在禁用故障插件后仍无法启动。' + (names.length ? '（日志仍显示：' + names.join(', ') + '）' : ''),
      });
      this.log('安全模式启动失败，等待用户处理。');
      return;
    }

    if (!names.length) {
      // 非插件故障（网络/环境/配置）：保留普通失败提示，避免误伤正常插件
      this.state.update({
        service: 'failed',
        phase: '启动失败（未检测到插件故障）',
        failReason: '常见原因：Node.js 未安装 / npm 源不可达 / 端口被占用 / 工作目录不存在。请打开日志排查。',
      });
      this.log('启动失败但未检测到插件故障，已跳过安全模式（避免误伤正常插件）。');
      return;
    }

    // —— 插件故障 → Level 1：按条目禁用 ——
    this.log('检测到故障插件: ' + names.join(', ') + '，尝试自动隔离…');
    // 审计修复（P2）：dump-config 失败（受限权限下会 EPERM）时退回 profile patch 索引，
    // 避免直接升级到"剥离全部第三方插件"的 Level 2。
    const yaml = this.runDumpConfig() || this.patchEntryIndex();
    const ids = resolveEntryIds(yaml, names);
    if (ids.length && this.writeSafePatch(ids)) {
      data.safeMode = true;
      data.safeModeLevel = 1;
      data.safeModeNames = names.join(', ');
      this.settings.save();
      this.state.update({
        safeMode: true,
        safePlugins: data.safeModeNames,
        phase: '安全模式：已禁用 ' + ids.length + ' 个故障插件，正在重启…',
      });
      this.log('已生成禁用补丁 ' + this.settings.safePatchPath + '（条目: ' + ids.join(', ') + '），以安全模式重启。');
      await this.relaunch();
      return;
    }

    // —— Level 2：备份配置并临时剥离全部第三方插件 ——
    if (this.backupProfile() && this.writeMinimalProfile()) {
      data.safeMode = true;
      data.safeModeLevel = 2;
      data.safeModeNames = '全部第三方插件（临时剥离）';
      this.settings.save();
      this.state.update({
        safeMode: true,
        safePlugins: data.safeModeNames,
        phase: '安全模式：已临时剥离全部第三方插件，正在重启…',
      });
      this.log('未能定位故障插件条目，已临时剥离全部第三方插件（原配置备份为 *.dshsafe.bak）。');
      await this.relaunch();
      return;
    }

    // —— 自动修复全部失败 → 交还用户 ——
    this.state.update({
      service: 'failed',
      phase: '启动失败，无法自动修复',
      failReason: '未能自动隔离故障插件，请通过「打开日志」定位问题。',
    });
  }

  async relaunch() {
    await this.launcher.stop();
    this.state.update({ service: 'starting' });
    this.launcher.start();
    // R25（审计修复）：relaunch 后无就绪等待兜底——挂起时 UI 永久"正在重启"。
    // 90 秒内未就绪 → 再次 tryRecover（triggered 闸已允许安全模式分支重入：
    // Level 1 重启失败会进入"安全模式也未能启动"终止；非插件失败会置 failed）。
    const deadline = Date.now() + 90 * 1000;
    const poll = async () => {
      while (Date.now() < deadline) {
        if (this.launcher.ready) return;
        if (await this.launcher.probeHealth(this.settings.data.port, 1500)) return;
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!this.launcher.ready) {
        this.log('安全模式重启后 90 秒未就绪，再次进入恢复流程。');
        this.tryRecover().catch(() => { /* 忽略 */ });
      }
    };
    poll().catch(() => { /* 忽略 */ });
  }

  // 退出安全模式：清状态/删补丁/还原备份 → 正常重启
  async exitSafeMode() {
    const data = this.settings.data;
    const lvl = data.safeModeLevel;
    data.safeMode = false;
    data.safeModeLevel = 0;
    data.safeModeNames = '';
    this.restoreProfile();
    try { if (fs.existsSync(this.settings.safePatchPath)) fs.unlinkSync(this.settings.safePatchPath); } catch (_) { /* 忽略 */ }
    this.settings.save();
    this.triggered = false;
    this.log('已退出安全模式（原级别 ' + lvl + '），恢复正常启动。');
    await this.relaunch();
  }

  // `dsh --profile web --dump-config`：不启动应用，仅打印装配树
  runDumpConfig() {
    // 可移植性修复（2026-09-11）：cwd 必须是本机存在的目录——workDir 可能来自另一台电脑
    // （settings.json 随绿色目录复制），无效 cwd 会让 spawnSync 直接抛 ENOENT。
    const safeCwd = () => (this.launcher && typeof this.launcher.safeWorkDir === 'function'
      ? this.launcher.safeWorkDir()
      : workDirOrHome(this.workDir));
    try {
      const node = this.launcher.nodePath || 'node';
      const bin = this.launcher.found ? this.launcher.found.bin : null;
      if (!bin || !fs.existsSync(bin)) return null;
      // R25（审计阻断修复）：必须合并 nodeInfo.env——内嵌模式 nodePath 是 DSH-App.exe，
      // 缺 ELECTRON_RUN_AS_NODE 时启动的是 GUI 本体 → 单实例锁令其秒退（status 0、
      // stdout 空）→ Level 1 恒失败，一律升级 Level 2 剥离全部第三方插件。
      const env = Object.assign({}, process.env,
        this.launcher.nodeInfo && this.launcher.nodeInfo.env ? this.launcher.nodeInfo.env : {});
      const r = spawnSync(node, [bin, '--profile', 'web', '--dump-config'], {
        cwd: safeCwd(), encoding: 'utf8', timeout: 30000, windowsHide: true, env,
      });
      if (r.status !== 0) {
        // 不再静默：失败原因写进日志，便于判断是否走了下面的兜底索引
        this.log('--dump-config 失败（退出码 ' + r.status + '）：'
          + String(r.stderr || r.stdout || '').trim().slice(0, 200));
        return null;
      }
      return r.stdout;
    } catch (err) {
      this.log('--dump-config 异常：' + (err && err.message ? err.message : err));
      return null;
    }
  }

  /**
   * dump-config 失败时的兜底索引（审计修复 P2）。
   * `dsh --profile web --dump-config` 会**先写 profile 根文件**——在受限权限/只读 profile
   * 下会 EPERM 失败（实测）。旧版此时直接升级到 Level 2（剥离**全部**第三方插件），
   * 用一个坏插件惩罚所有插件。这里直接从 cordis.patch.yml 提取 (id, name) 对，喂给
   * resolveEntryIds —— 结构与 dump-config 输出同形，足以定位故障条目。
   */
  patchEntryIndex() {
    try {
      const cp = path.join(this.profileDir, 'cordis.patch.yml');
      if (!fs.existsSync(cp)) return null;
      const lines = fs.readFileSync(cp, 'utf8').split(/\r?\n/);
      const entries = [];
      let cur = null;
      for (const raw of lines) {
        const t = raw.trim();
        const mi = t.match(/^-\s*id:\s*['"]?([^'"\s]+)['"]?$/);
        const mi2 = t.match(/^id:\s*['"]?([^'"\s]+)['"]?$/);
        if (mi || mi2) { cur = { id: (mi ? mi[1] : mi2[1]) }; entries.push(cur); continue; }
        const mn = t.match(/^name:\s*['"]?([^'"\s]+)['"]?$/);
        if (mn && cur && !cur.name) cur.name = mn[1];
      }
      const good = entries.filter((e) => e.id);
      if (!good.length) return null;
      this.log('已改用 profile patch 索引定位故障条目（' + good.length + ' 条）');
      return good.map((e) => '- id: ' + e.id + (e.name ? '\n  name: ' + e.name : '')).join('\n') + '\n';
    } catch (_) { return null; }
  }

  writeSafePatch(ids) {
    try {
      let text = '# generated by DSH App safe mode: disables plugins that failed to activate.\n'
        + '# Delete this file, or click "Exit safe mode" in the app, to restore.\n';
      for (const id of ids) {
        if (!/^[A-Za-z0-9@._:/\-]+$/.test(String(id))) continue;   // 防 YAML 注入
        text += '- id: ' + id + '\n  disabled: true\n';
      }
      fs.mkdirSync(this.settings.dir, { recursive: true });
      fs.writeFileSync(this.settings.safePatchPath, text, 'utf8');
      return true;
    } catch (_) { return false; }
  }

  // —— Level 2：备份/还原 profile 配置 ——
  // 审计修复（P2）：已存在备份时**不得覆盖**。否则第二次进入 Level 2（或上次 Level 2 后
  // 未正常退出安全模式就崩溃/重启）会把"已被剥离过的 profile"当成原始配置备份，
  // 原始 package.json / cordis.patch.yml 永久丢失。
  backupProfile() {
    try {
      if (!fs.existsSync(this.profileDir)) return false;
      const pj = path.join(this.profileDir, 'package.json');
      const cp = path.join(this.profileDir, 'cordis.patch.yml');
      if (fs.existsSync(pj) && !fs.existsSync(pj + '.dshsafe.bak')) fs.copyFileSync(pj, pj + '.dshsafe.bak');
      if (fs.existsSync(cp) && !fs.existsSync(cp + '.dshsafe.bak')) fs.copyFileSync(cp, cp + '.dshsafe.bak');
      return true;
    } catch (_) { return false; }
  }

  writeMinimalProfile() {
    try {
      if (!fs.existsSync(this.profileDir)) return false;
      const pj = path.join(this.profileDir, 'package.json');
      const cp = path.join(this.profileDir, 'cordis.patch.yml');
      const pjText = '{\n'
        + '  "name": "dsh-profile-web",\n'
        + '  "private": true,\n'
        + '  "dependencies": {},\n'
        + '  "dsh": {\n'
        + '    "profile": {\n'
        + '      "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app" ],\n'
        + '      "patchReload": "live"\n'
        + '    }\n'
        + '  }\n'
        + '}\n';
      fs.writeFileSync(pj, pjText, 'utf8');
      fs.writeFileSync(cp, '[]\n', 'utf8');
      return true;
    } catch (_) { return false; }
  }

  restoreProfile() {
    try {
      const pj = path.join(this.profileDir, 'package.json');
      const cp = path.join(this.profileDir, 'cordis.patch.yml');
      let any = false;
      if (fs.existsSync(pj + '.dshsafe.bak')) {
        fs.copyFileSync(pj + '.dshsafe.bak', pj);
        fs.unlinkSync(pj + '.dshsafe.bak');
        any = true;
      }
      if (fs.existsSync(cp + '.dshsafe.bak')) {
        fs.copyFileSync(cp + '.dshsafe.bak', cp);
        fs.unlinkSync(cp + '.dshsafe.bak');
        any = true;
      }
      if (any) this.log('已还原 profile 配置（package.json / cordis.patch.yml）。');
    } catch (err) {
      this.log('还原 profile 配置失败: ' + (err.message || err));
    }
  }
}

module.exports = { Watchdog, parseFailedPlugins, resolveEntryIds };