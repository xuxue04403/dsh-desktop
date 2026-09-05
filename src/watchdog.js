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

// 0.1.x 两种启动失败报错形态：
//   形态1: dsh: plugin(s) failed to load: a, b; Cordis startup failed because ...
//   形态2: dsh: N entr(ies) did not activate\n<name>: <错误摘要>\n(堆栈行…)
const RE_FAILED_TO_LOAD = /plugin\(s\) failed to load:\s*([^;]+)/;
const RE_DID_NOT_ACTIVATE = /(\d+)\s+entr(?:y|ies)\s+did\s+not\s+activate\s+([\s\S]*?)(?:\r?\n\s*\r?\n|$)/;

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
    this.profileDir = path.join(os.homedir(), '.dsh', 'profiles', 'web');
  }

  // 启动失败（未就绪即退出 / 或等待超时）时由 main 调用
  async tryRecover() {
    if (this.triggered) return;
    this.triggered = true;

    const logPath = path.join(this.settings.dir, 'logs', 'web.log');
    let logText = '';
    try { if (fs.existsSync(logPath)) logText = fs.readFileSync(logPath, 'utf8'); } catch (_) { /* 忽略 */ }
    const names = parseFailedPlugins(logText);

    const data = this.settings.data;
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
    const yaml = this.runDumpConfig();
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
    try {
      const node = this.launcher.nodePath || 'node';
      const bin = this.launcher.found ? this.launcher.found.bin : null;
      if (!bin || !fs.existsSync(bin)) return null;
      const r = spawnSync(node, [bin, '--profile', 'web', '--dump-config'], {
        cwd: this.workDir, encoding: 'utf8', timeout: 30000, windowsHide: true,
      });
      return r.status === 0 ? r.stdout : null;
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
  backupProfile() {
    try {
      if (!fs.existsSync(this.profileDir)) return false;
      const pj = path.join(this.profileDir, 'package.json');
      const cp = path.join(this.profileDir, 'cordis.patch.yml');
      if (fs.existsSync(pj)) fs.copyFileSync(pj, pj + '.dshsafe.bak');
      if (fs.existsSync(cp)) fs.copyFileSync(cp, cp + '.dshsafe.bak');
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