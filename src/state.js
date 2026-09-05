// state.js — 壳级状态机：服务状态 + 变更广播
//
// service: stopped | starting | ready | failed | safe
//   ready/safe 均表示服务就绪；safe 表示处于安全模式（已禁用故障插件）
'use strict';

const { EventEmitter } = require('events');

class AppState extends EventEmitter {
  constructor() {
    super();
    this.service = 'stopped';   // stopped / starting / ready / failed / safe
    this.phase = '服务未运行';   // 引导页阶段文案
    this.port = 3080;
    this.authUrl = '';          // 从 dsh stdout 解析的真实 URL（含 token）
    this.safeMode = false;
    this.safePlugins = '';
    this.failReason = '';
    this.dshVersion = '';
  }

  // 更新并广播快照
  update(patch) {
    Object.assign(this, patch);
    this.emit('changed', this.snapshot());
    return this.snapshot();
  }

  snapshot() {
    return {
      service: this.service,
      phase: this.phase,
      port: this.port,
      authUrl: this.authUrl,
      safeMode: this.safeMode,
      safePlugins: this.safePlugins,
      failReason: this.failReason,
      dshVersion: this.dshVersion,
    };
  }
}

module.exports = { AppState };