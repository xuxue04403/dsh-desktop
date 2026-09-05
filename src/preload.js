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