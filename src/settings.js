// settings.js — 设置持久化（userData/settings.json）
//
// 设计原则（升级兼容）：
//   * 只保存本壳关心的配置（端口/启动策略/安全模式状态），绝不改写 dsh 自己的配置；
//   * 安全模式状态独立持久化，崩溃重启后仍保持"禁用故障插件"（防止再次启动循环）。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  port: 3080,               // dsh web 监听端口（与 --port 契约对应）
  workDir: '',              // 工作目录（空 = 用户主目录）
  autoStart: false,         // 开机自启
  autoStartService: false,  // 启动应用时自动启动 dsh 服务
  autoOpenBrowser: false,   // 就绪后自动用系统浏览器打开（默认关：内嵌窗口即界面，避免打扰）
  minimizeToTray: true,     // 关窗最小化到托盘
  checkUpdates: true,       // 启动时检查 dsh 新版本
  // —— 安全模式状态（程序自身维护，勿手改）——
  safeMode: false,
  safeModeLevel: 0,         // 1=补丁禁用故障插件 2=临时剥离第三方插件
  safeModeNames: '',
};

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
        Object.assign(this.data, DEFAULTS, raw);
      }
    } catch (err) {
      this.logError('settings load', err);
    }
    // 工作目录兜底
    if (!this.data.workDir) this.data.workDir = os.homedir();
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      this.logError('settings save', err);
    }
  }

  update(patch) {
    Object.assign(this.data, patch);
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

module.exports = { Settings, DEFAULTS };