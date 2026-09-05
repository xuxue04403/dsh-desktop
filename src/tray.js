// tray.js — 系统托盘：图标与 DSH-App.exe 内嵌图标完全一致（官方 electron-icon.ico，
// 从 electron.exe 资源提取，见 scripts/extract-exe-icon.mjs）。服务状态通过 tooltip 与菜单体现。
'use strict';

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

function trayImage() {
  try {
    const ico = path.join(__dirname, 'assets', 'electron-icon.ico');
    const img = nativeImage.createFromPath(ico);
    if (!img.isEmpty()) return img;
    // 兜底：parser 未能提取时降级到进程自身图标不可行（exe 图标在文件资源中），
    // 用 256 PNG 缩放为托盘常驻尺寸
    const png = nativeImage.createFromPath(path.join(__dirname, 'assets', 'electron-icon.png'));
    return png.isEmpty() ? nativeImage.createEmpty() : png.resize({ width: 16, height: 16 });
  } catch (_) {
    return nativeImage.createEmpty();
  }
}

class TrayController {
  /**
   * @param {object} opts { getState, actions }
   *   actions: { showMain, start, stop, openBrowser, openSettings, openLogs, quit }
   */
  constructor(opts) {
    this.actions = opts.actions;
    this.getState = opts.getState;
    this.tray = null;
    this.badged = false;   // 首次气泡提示已展示
  }

  create() {
    this.tray = new Tray(trayImage());
    this.tray.setToolTip('DSH App');

    const menu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => this.actions.showMain() },
      { label: '启动 dsh 服务', click: () => this.actions.start() },
      { label: '停止 dsh 服务', click: () => this.actions.stop() },
      { label: '在系统浏览器中打开', click: () => this.actions.openBrowser() },
      { type: 'separator' },
      { label: '设置', click: () => this.actions.openSettings() },
      { label: '模型网关', click: () => (this.actions.openGateway ? this.actions.openGateway() : this.actions.openSettings('gateway')) },
      { label: '打开日志目录', click: () => this.actions.openLogs() },
      { type: 'separator' },
      { label: '退出', click: () => this.actions.quit() },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.on('double-click', () => this.actions.showMain());

    // 首次运行气泡提示：帮助发现托盘图标（Windows 可能默认收起新图标到溢出区）
    try {
      this.tray.displayBalloon({
        title: 'DSH App 已启动',
        content: '程序驻留在系统托盘。若此处看不到图标，点击任务栏「^」展开隐藏图标即可找到。',
      });
      this.badged = true;
    } catch (_) { /* 部分平台不支持气泡 */ }
  }

  // 状态变更时刷新 tooltip（图标恒为官方 electron 图标，与主程序 exe 一致）
  refresh(state) {
    if (!this.tray) return;
    this.tray.setToolTip(
      'DSH App · ' + labelOf(state) + (state.safeMode ? '（安全模式）' : '')
    );
  }
}

function labelOf(state) {
  switch (state.service) {
    case 'starting': return '启动中…';
    case 'ready': return '运行中 :' + state.port;
    case 'failed': return '启动失败';
    case 'safe': return '安全模式运行中 :' + state.port;
    default: return '已停止';
  }
}

module.exports = { TrayController };