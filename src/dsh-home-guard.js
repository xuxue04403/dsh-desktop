// dsh-home-guard.js — 共用 dsh home 的「版本守卫」（v1.9.1 新增）
//
// 事故背景（2026-09-27 实测，用户报"重启进 UAT 后历史会话丢失"）：
//   本应用**不设置 DSH_HOME**（launcher 的 spawnEnv 只叠加 ELECTRON_RUN_AS_NODE/PATH），
//   所以 dsh 的 home 永远是默认的 `~/.dsh` —— 多个绿色目录（主目录 / UAT）**共用同一个 home**。
//   当两者跑着**不同版本的 dsh** 时，较旧的那个会按自己的理解改写共享状态：
//   实测 UAT（dsh 0.1.5-rc.3）启动 13 秒后，`~/.dsh/settings.yaml` 被改名为
//   `settings.yaml.imported`、`storages/workspace.json` 被重写 —— 主目录随即"历史会话丢失"。
//   而版本之所以分叉，是因为安装/升级原先写死 `@latest`（UAT 装回旧版），主目录却是手工装的 `next`。
//
// 本模块的职责**不是**去改写 dsh 的状态文件（那是 dsh 的地盘，壳不该越界），而是：
//   ① 在每次启动时把「谁在用这个 home、用的是哪个 dsh 版本」记到一个标记文件里；
//   ② 发现**版本变了**就醒目告警，把"静默损坏"变成"可解释的现象"，
//      并给出可执行的处置建议（对齐版本 / 让两个实例各用各的 home）。
//
// 全程 try/catch 兜底：守卫本身绝不能阻断启动。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_NAME = '.dsh-app-version-guard.json';

/** dsh home 解析（与 default-plugins / market / watchdog / quit-guard 同一约定） */
function resolveDshHome(explicit) {
  if (explicit) return explicit;
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeJson(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return true;
  } catch (_) { return false; }
}

/**
 * 记录本次使用情况，并在 dsh 版本与上次不同时返回告警信息。
 *
 * @param {object} o
 * @param {string} o.dshVersion  本次检测到的 dsh 版本（空则跳过）
 * @param {string} o.dataDir     本次实例的数据目录（用于指出"是谁在用"）
 * @param {string} [o.dshHome]   覆盖 dsh home
 * @param {(s:string)=>void} [o.log]
 * @returns {{checked:boolean, versionChanged:boolean, previous:string|null, current:string, home:string, markerPath:string}}
 */
function checkAndRecord(o) {
  const opts = o || {};
  const home = resolveDshHome(opts.dshHome);
  const markerPath = path.join(home, MARKER_NAME);
  const current = String(opts.dshVersion || '');
  const base = { checked: false, versionChanged: false, previous: null, current, home, markerPath };
  if (!current) return base;   // 没检测到 dsh（未安装）→ 无从判断

  try {
    const prev = readJson(markerPath);
    const previous = prev && prev.dshVersion ? String(prev.dshVersion) : null;
    const versionChanged = !!(previous && previous !== current);

    // 记录/更新（无论是否变化都要更新，否则下次比较无意义）
    writeJson(markerPath, {
      dshVersion: current,
      dataDir: String(opts.dataDir || ''),
      at: new Date().toISOString(),
    });

    if (versionChanged) {
      const log = opts.log || (() => { });
      const prevDir = (prev && prev.dataDir) ? prev.dataDir : '(未知)';
      log('[版本守卫] ⚠ 共用同一个 dsh home 的实例换了 dsh 版本：'
        + (previous || '?') + ' → ' + current);
      log('[版本守卫]   上次使用：' + prevDir);
      log('[版本守卫]   本次使用：' + String(opts.dataDir || '(未知)'));
      log('[版本守卫]   风险：多个绿色目录共用 ' + home + '（dsh 默认 home），'
        + '不同版本的 dsh 对同一份 settings.yaml / 会话索引理解不同，'
        + '旧版可能改写或改名它们 → 另一侧表现为「历史会话丢失」。');
      log('[版本守卫]   处置：让两个实例跟同一条版本流（设 DSH_DSH_TAG=next 或 =latest 后重装 dsh），'
        + '或给其中一个设独立的 DSH_HOME 目录。');
    }
    return { ...base, checked: true, versionChanged, previous };
  } catch (err) {
    try { (opts.log || (() => { }))('[版本守卫] 检查异常（不阻断启动）：' + (err && err.message ? err.message : err)); } catch (_) { /* 忽略 */ }
    return base;
  }
}

module.exports = { checkAndRecord, resolveDshHome, MARKER_NAME };
