// quit-guard.js — 退出前"是否还在跑任务"的确认（v1.9.0 新增）
//
// 设计来源：官方 DeepSeek Harness Desktop 在退出前会问 Host"这次退出会打断什么"
// （活跃任务 + 已武装的定时提醒），Host 通过**私有 IPC** 回答，2 秒不应答就按"有任务"处理。
//
// DSH-App 的架构差异：它是**进程外薄宿主**——dsh 是独立子进程，壳与它之间只有
// "stdout 就绪行 + HTTP" 这两个稳定契约，没有可以问"你在忙吗"的私有通道。
// 因此这里改用**旁路可观测信号**，全部只读、全部有实测依据：
//
//   信号 1｜dsh 会话状态写入：dsh 在每次 agent 事件（工具调用、消息、会话状态变更）落盘时
//          刷新 `$DSH_HOME/storages/session_projcache/sessions/*.json` 的 mtime。
//          2026-09-25 实测：与活动严格同步；145 个文件全量 stat 约 12ms，退出路径可接受。
//   信号 2｜模型网关流量：网关是每次模型请求的必经通道，其 stdout 有请求开始/结束行
//          （经 GatewayManager.pushLog 归集）。"最近仍有输出" ≈ "最近仍有模型调用"，
//          这条能覆盖"模型正在思考、会话尚未落盘"的空档。
//
// 已知局限（如实记录，不粉饰）：
//   · 这是**概率性**判定，不是权威答案。长时间无输出的上游（实测有 105 秒的模型）
//     可能让信号过期；反过来"刚答完就退出"会在窗口期内被提示一次。
//   · 因此对话框的措辞是"最近仍有活动"，而不是断言"有任务在跑"；默认按钮也按
//     "用户本来就想退出"来设置（与官方一致：Quit 为默认，Esc 取消）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 判定窗口。取值理由：太小 → "刚答完就退出"被反复打扰；太大 → 任务间隙漏报。
// 20 秒同时覆盖了"工具调用之间的思考间隔"这个最常见的空档。
const DEFAULT_WINDOW_MS = 20 * 1000;

// 目录异常膨胀时的扫描上限：退出路径绝不能因为 readdir/stat 卡住。
const MAX_ENTRIES = 2000;

/** 解析 DSH_HOME（与 default-plugins / market / watchdog 同一约定）。 */
function resolveDshHome(explicit) {
  if (explicit) return explicit;
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 目录下最新的文件 mtime（只扫一层，不递归）。
 * @param {string} dir - 目标目录。
 * @returns {number} 毫秒时间戳；目录不存在或不可读时为 0。
 */
function newestMtime(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  const limit = Math.min(names.length, MAX_ENTRIES);
  let newest = 0;
  for (let i = 0; i < limit; i++) {
    // 只认普通文件：缓存目录里可能混有子目录（如 sessions 的子级），递归代价不值当
    try {
      const st = fs.statSync(path.join(dir, names[i]));
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    } catch (_) { /* 单个条目读不到 → 跳过，不影响其余判断 */ }
  }
  return newest;
}

/**
 * 评估"此刻退出会不会打断正在跑的任务"。
 *
 * 纯只读：不写文件、不改状态，可安全地反复调用（对话框失败重试、单测）。
 *
 * @param {object} [options] - 评估参数。
 * @param {string} [options.dshHome] - 覆盖 DSH_HOME（缺省读环境变量或 ~/.dsh）。
 * @param {number} [options.gatewayLastActivityAt] - 网关最近一次输出的时间戳（ms）。
 * @param {number} [options.now] - 注入"当前时间"，便于单测。
 * @param {number} [options.windowMs] - 判定窗口（ms），缺省 20000。
 * @returns {{busy: boolean, signals: Array<{kind: string, ageMs: number, detail: string}>, checkedAt: number, windowMs: number}}
 *   busy=true 表示窗口期内观察到活动，应当询问用户。
 */
function assess(options) {
  const o = options || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const windowMs = (typeof o.windowMs === 'number' && o.windowMs > 0) ? o.windowMs : DEFAULT_WINDOW_MS;
  const home = resolveDshHome(o.dshHome);
  const signals = [];

  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  const sessionAt = newestMtime(cacheDir);
  if (sessionAt > 0 && now - sessionAt <= windowMs) {
    const age = Math.max(0, Math.round((now - sessionAt) / 1000));
    signals.push({ kind: 'session', ageMs: now - sessionAt, detail: '会话状态 ' + age + ' 秒前仍在更新' });
  }

  const gwAt = Number(o.gatewayLastActivityAt) || 0;
  if (gwAt > 0 && now - gwAt <= windowMs) {
    const age = Math.max(0, Math.round((now - gwAt) / 1000));
    signals.push({ kind: 'gateway', ageMs: now - gwAt, detail: '模型网关 ' + age + ' 秒前仍有请求流量' });
  }

  return { busy: signals.length > 0, signals, checkedAt: now, windowMs };
}

/**
 * 弹模态确认框。
 *
 * 失败放行（返回 true）是刻意的：对话框弹不出来时把用户锁在一个关不掉的应用里，
 * 比"偶尔少问一次"严重得多。失败会写进 app.log 以便事后发现。
 *
 * @param {object} dialog - Electron 的 dialog 模块。
 * @param {object|null} parentWindow - 父窗口（可为 null，此时用无主对话框）。
 * @param {object} assessment - {@link assess} 的结果。
 * @param {(msg: string) => void} [log] - 日志回调。
 * @returns {Promise<boolean>} true = 用户确认退出。
 */
async function confirm(dialog, parentWindow, assessment, log) {
  const detail = [
    '检测到最近仍有活动，现在退出会中断正在进行的任务：',
    '',
    ...assessment.signals.map((s) => '  · ' + s.detail),
    '',
    '正在执行的命令会被终止；已经写入会话记录的内容不受影响。',
    '（这是一项基于旁路信号的判断——本应用与 dsh 之间没有"你在忙吗"的查询通道。）',
  ].join('\n');

  const opts = {
    type: 'warning',
    buttons: ['退出', '取消'],
    defaultId: 0,      // 与官方一致：Quit 为默认，Esc 走 cancelId
    cancelId: 1,
    noLink: true,
    title: 'DSH App',
    message: '确认退出 DSH App？',
    detail,
  };

  let result;
  try {
    result = (parentWindow && !parentWindow.isDestroyed())
      ? await dialog.showMessageBox(parentWindow, opts)
      : await dialog.showMessageBox(opts);
  } catch (err) {
    if (log) log('[退出确认] 对话框不可用，按"确认退出"处理：' + (err && err.message ? err.message : err));
    return true;
  }
  return result.response === 0;
}

module.exports = { assess, confirm, newestMtime, resolveDshHome, DEFAULT_WINDOW_MS };
