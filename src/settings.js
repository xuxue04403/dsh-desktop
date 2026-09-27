// settings.js — 设置持久化（userData/settings.json）
//
// 设计原则（升级兼容）：
//   * 只保存本壳关心的配置（端口/启动策略/安全模式状态），绝不改写 dsh 自己的配置；
//   * 安全模式状态独立持久化，崩溃重启后仍保持"禁用故障插件"（防止再次启动循环）。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
// 可移植性修复（2026-09-11）：workDir 可能来自另一台电脑 → 统一走"不可用就回退主目录"
const { dirUsable, workDirOrHome } = require('./paths');

const DEFAULTS = {
  port: 3080,               // dsh web 监听端口（与 --port 契约对应）
  workDir: '',              // 工作目录（空 = 用户主目录）
  autoStart: false,         // 开机自启
  autoStartService: false,  // 启动应用时自动启动 dsh 服务
  autoOpenBrowser: false,   // 就绪后自动用系统浏览器打开（默认关：内嵌窗口即界面，避免打扰）
  minimizeToTray: true,     // 关窗最小化到托盘
  checkUpdates: true,       // 启动时检查 dsh 新版本
  installDefaultPlugins: true,   // v1.7.0：随 app 分发默认插件（dsh-email-bridge 邮箱桥接）并挂载到 dsh profile
  trayBalloonShown: false,   // 托盘"首次运行"气泡是否已提示过（审计修复：旧版每次启动都弹）
  confirmQuitWhenBusy: true, // v1.9.0：退出时若检测到最近仍有活动（会话写入/网关流量）则先确认，避免误退打断任务
  // —— 安全模式状态（程序自身维护，勿手改）——
  safeMode: false,
  safeModeLevel: 0,         // 1=补丁禁用故障插件 2=临时剥离第三方插件
  safeModeNames: '',
};

// 设置键白名单 + 逐键类型（P0-3 修复）。
// 旧实现是 `Object.assign(this.data, patch)`——**任意键、任意类型**都直接落盘。IPC 是公共
// 入口，而 `workDir` 会直接成为 `dsh web` 子进程的 cwd（改变 dsh 可读写的文件树范围），
// `safeMode`/`installDefaultPlugins` 会改变启动行为，`confirmQuitWhenBusy` 会静默关掉退出
// 保护。渲染层正常只提交下面这些键，但守卫不该依赖"调用方都守规矩"。
const BOOL_KEYS = ['autoStart', 'autoStartService', 'autoOpenBrowser', 'minimizeToTray',
  'checkUpdates', 'installDefaultPlugins', 'trayBalloonShown', 'confirmQuitWhenBusy', 'safeMode'];
const INT_KEYS = ['safeModeLevel', 'port'];
const STR_KEYS = ['workDir', 'safeModeNames'];

/**
 * 过滤出可落盘的设置项（白名单 + 类型校验），未知键与非预期类型一律丢弃。
 *
 * @param {object} patch - 待应用的补丁。
 * @param {(msg: string) => void} [onDrop] - 丢弃回调（用于把静默丢弃变成可见日志）。
 * @returns {object} 只含合法键值的新对象。
 */
function sanitizePatch(patch, onDrop) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const k of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
      if (onDrop) onDrop('未知设置键已忽略：' + k);
      continue;
    }
    const v = patch[k];
    if (BOOL_KEYS.includes(k)) {
      if (typeof v === 'boolean') out[k] = v;
      else if (onDrop) onDrop('设置 ' + k + ' 类型不符（需 boolean）已忽略');
    } else if (INT_KEYS.includes(k)) {
      // 接受整数或纯数字字符串（手改 settings.json 常写成 "3100"）；越界由下游
      // 端口兜底统一处理（见 update()），这里只保证"是整数"。
      const n = typeof v === 'number'
        ? v
        : (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN);
      if (Number.isInteger(n)) out[k] = n;
      else if (onDrop) onDrop('设置 ' + k + ' 类型不符（需整数）已忽略');
    } else if (STR_KEYS.includes(k)) {
      if (typeof v === 'string') out[k] = v;
      else if (onDrop) onDrop('设置 ' + k + ' 类型不符（需字符串）已忽略');
    }
  }
  return out;
}

class Settings {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'settings.json');
    this.data = Object.assign({}, DEFAULTS);
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        // P0-3：手改 settings.json 同样过白名单与类型校验（否则 `"minimizeToTray": "false"`
        // 这种字符串会被当真值使用，复选框状态与实际行为不一致）
        Object.assign(this.data, DEFAULTS, sanitizePatch(raw));
      }
    } catch (err) {
      this.logError('settings load', err);
    }
    // R25（审计低-4）：load 路径也校验端口（IPC 保存路径有校验，手改 settings.json 没有）
    const p = Number(this.data.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) this.data.port = DEFAULTS.port;
    // 工作目录兜底（可移植性修复 2026-09-11）：settings.json 常随绿色目录一起被复制到
    // **另一台电脑**，里面的 workDir 是旧机器的绝对路径（C:\Users\旧用户名）。
    // 该路径不存在时必须换成当前用户主目录并落盘，否则 launcher 以它为 cwd → spawn ENOENT，
    // 表现为"双击后只有空白窗口"（与 cmd.exe 那条 ENOENT 是同一类故障）。
    const wanted = this.data.workDir;
    if (!dirUsable(wanted)) {
      const fixed = workDirOrHome(wanted);
      if (wanted && fs.existsSync(this.file)) {
        this.logError('workDir', new Error('工作目录不存在（可能来自其它电脑）已回退：' + wanted + ' → ' + fixed));
      }
      this.data.workDir = fixed;
      if (fs.existsSync(this.file)) this.save();   // 落盘，避免每次启动重复判定
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const text = JSON.stringify(this.data, null, 2);
      // P0-3：原子写（tmp + rename）。旧实现直接 writeFileSync 覆盖，写入过程中断电/崩溃
      // 会留下**半截 JSON**；而 load() 的 JSON.parse 失败被 logError 吞掉 → 静默退回全默认
      // 值（端口回 3080、safeMode 丢失、已卸载的默认插件被重装）。网关配置早已用
      // tmp+rename（gateway-manager.saveConfig），这里对齐。
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, this.file);   // Windows 上 rename 会替换已存在的目标
    } catch (err) {
      this.logError('settings save', err);
    }
  }

  update(patch) {
    // P0-3：白名单 + 类型校验后合并（丢弃项写日志，不静默）
    const clean = sanitizePatch(patch, (m) => this.logError('settings update', new Error(m)));
    Object.assign(this.data, clean);
    // 审计修复（P1）：端口在**写入路径**上就要兜底。旧版只在 load() 里校验，渲染层
    // 手填 99999 / 0 / 空串会原样落盘并被 launcher 拼进 `dsh web --port`（连不上端口 →
    // 走看门狗恢复），且 UI 显示与落盘值不一致。
    const p = Number(this.data.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) this.data.port = DEFAULTS.port;
    else this.data.port = p;
    this.save();
    return this.data;
  }

  get safePatchPath() {
    return path.join(this.dir, 'safe.yml');
  }

  logError(tag, err) {
    try {
      const { appendLog } = require('./logger');
      appendLog('[' + tag + '] ' + (err && err.message ? err.message : String(err)));
    } catch (_) { /* 忽略 */ }
  }
}

module.exports = { Settings, DEFAULTS, sanitizePatch };