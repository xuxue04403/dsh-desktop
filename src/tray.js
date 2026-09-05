// tray.js — 系统托盘：图标由 src/icon.js 程序化生成（品牌蓝 + 状态变色），无外部资源依赖
'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const { iconDataURL, COLORS } = require('./icon');

// 按状态取主色；未识别状态用品牌蓝
function colorFor(service) {
  switch (service) {
    case 'starting': return COLORS.starting;
    case 'ready': return COLORS.ready;
    case 'failed': return COLORS.failed;
    case 'safe': return COLORS.safe;
    default: return COLORS.stopped;
  }
}

function trayImage(size, service) {
  try {
    const c = colorFor(service);
    return nativeImage.createFromDataURL(iconDataURL(size, c));
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
    this.tray = new Tray(trayImage(16, 'stopped'));
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

  // 状态变更时刷新 tooltip 与图标颜色（灰=停止 黄=启动中 绿=就绪 红=失败 橙=安全）
  refresh(state) {
    if (!this.tray) return;
    const svc = (state && state.service) || 'stopped';
    try {
      this.tray.setImage(trayImage(16, svc));
    } catch (_) { /* 忽略 */ }
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