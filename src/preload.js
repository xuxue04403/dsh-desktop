// preload.js — 渲染进程安全桥（contextIsolation 模式）
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshApp', {
  // 读取当前状态 / 设置
  getState: () => ipcRenderer.invoke('dsh:state'),
  getSettings: () => ipcRenderer.invoke('dsh:settings'),
  getVersions: () => ipcRenderer.invoke('dsh:versions'),

  // 触发壳动作（启动/停止/打开日志/浏览器/设置/退出安全模式/复制升级命令/选择目录）
  action: (name) => ipcRenderer.invoke('dsh:action', name),

  // 模型网关：状态 / 动作（start|stop|save-config|write-dsh|load-example|get-config|clear-log）
  gwState: () => ipcRenderer.invoke('gw:state'),
  gwAction: (name, payload) => ipcRenderer.invoke('gw:action', name, payload),

  // 订阅网关状态推送（main.js broadcastGw() → 'gw:state'，载荷含状态与日志尾部）
  // 审计修复（P2）：主进程本来就推送该事件，桥里却漏了这条订阅 → 设置页只能 2 秒轮询，
  // 且每次都重置日志框。返回取消函数，供不再需要时解绑。
  onGwState: (cb) => {
    const listener = (_e, snap) => cb(snap);
    ipcRenderer.on('gw:state', listener);
    return () => ipcRenderer.removeListener('gw:state', listener);
  },

  // 插件市场（v1.5.18）：发现 / 安装预览 / 已安装 / 安装卸载
  mkDiscover: (payload) => ipcRenderer.invoke('mk:discover', payload),
  mkPreview: (pkgName) => ipcRenderer.invoke('mk:preview', pkgName),
  mkInstalled: () => ipcRenderer.invoke('mk:installed'),
  mkAction: (name, pkgName) => ipcRenderer.invoke('mk:action', name, pkgName),

  // 复制文本到剪贴板（主进程 clipboard，渲染进程无权限问题）
  copyText: (text) => ipcRenderer.invoke('dsh:clipboard', String(text == null ? '' : text)),

  // 保存设置（patch 为扁平对象）
  saveSettings: (patch) => ipcRenderer.invoke('dsh:save-settings', patch),

  // 订阅状态变更（返回取消函数）
  onState: (cb) => {
    const listener = (_e, snap) => cb(snap);
    ipcRenderer.on('dsh:state', listener);
    return () => ipcRenderer.removeListener('dsh:state', listener);
  },

  // 订阅"定位到某个设置卡片"（如模型网关）事件：section 字符串
  onFocusSection: (cb) => {
    const listener = (_e, section) => cb(section);
    ipcRenderer.on('dsh:focus-section', listener);
    return () => ipcRenderer.removeListener('dsh:focus-section', listener);
  },
});

// —— 主窗口（dsh web 页面）用的**单向、无权限**通道 ——
// 主窗口先加载本地状态页、再导航到 dsh web 页面，preload 对两者都可见（因此上面的
// dshApp 桥必须由主进程按来源帧拒绝，见 main.js fromLocalPage）。这里额外提供的
// __dshAppIh 只用于把「输入框当前值/光标是否在文首」上报给主进程，供 ↑↓ 历史做
// **同步**决策（Electron 的 before-input-event 必须同步 preventDefault）。
// 它不返回任何数据、不能触发任何动作，故即使被 dsh 页面内的第三方插件脚本调用也无风险。
contextBridge.exposeInMainWorld('__dshAppIh', {
  report: (state) => {
    try { ipcRenderer.send('dsh:ih-state', state || null); } catch (_) { /* 忽略 */ }
  },
});