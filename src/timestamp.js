// timestamp.js — 日志时间戳（时区可移植性修复，2026-09-11）
//
// 背景（真实故障）：绿色目录复制到另一台电脑后，日志时间比北京时间早 8 小时——
// 旧实现用 `new Date().toISOString()`（**永远是 UTC**）。镜像/克隆的 Windows 常把时区留在
// UTC，于是日志出现 02:41 而用户看到的是 10:41，排查"几点出的问题/先后顺序"时严重误导。
//
// 策略：**缺省固定按北京时间（UTC+8）输出**——与机器时区、区域设置完全无关，跨机器一致。
// 需要别的口径时用环境变量 DSH_LOG_TZ 覆盖：
//   （未设置）    → UTC+8（北京时间）
//   local|system  → 跟随系统时区（旧行为）
//   ±HH:MM        → 指定偏移，如 +09:00 / -05:30 / +0530
'use strict';

/** 解析日志时区偏移（分钟）；null = 跟随系统时区 */
function tzOffsetMin() {
  const v = String(process.env.DSH_LOG_TZ || '').trim().toLowerCase();
  if (v === 'local' || v === 'system') return null;
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(v);
  if (m) {
    const mins = Number(m[2]) * 60 + Number(m[3] || 0);
    return m[1] === '-' ? -mins : mins;
  }
  return 480;   // 缺省：北京时间
}

/** 取"墙上时间"各字段：固定偏移时用 UTC getter 读移位后的钟面，避免再叠加系统时区 */
function parts(d) {
  const t = d === undefined || d === null ? new Date() : new Date(d);
  const off = tzOffsetMin();
  if (off === null) {
    return {
      Y: t.getFullYear(), M: t.getMonth() + 1, D: t.getDate(),
      h: t.getHours(), m: t.getMinutes(), s: t.getSeconds(), ms: t.getMilliseconds(),
    };
  }
  const u = new Date(t.getTime() + off * 60000);
  return {
    Y: u.getUTCFullYear(), M: u.getUTCMonth() + 1, D: u.getUTCDate(),
    h: u.getUTCHours(), m: u.getUTCMinutes(), s: u.getUTCSeconds(), ms: u.getUTCMilliseconds(),
  };
}

const p2 = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD HH:mm:ss */
function stamp(d) {
  const x = parts(d);
  return x.Y + '-' + p2(x.M) + '-' + p2(x.D) + ' ' + p2(x.h) + ':' + p2(x.m) + ':' + p2(x.s);
}

/** YYYY-MM-DD HH:mm:ss.mmm（网关日志用） */
function stampMs(d) {
  const x = parts(d);
  return stamp(d) + '.' + String(x.ms).padStart(3, '0');
}

/** 当前生效口径的人类可读说明（写进 app.log 头部，便于事后核对时间口径） */
function tzLabel() {
  const off = tzOffsetMin();
  if (off === null) return 'local(system)';
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return 'UTC' + sign + p2(Math.floor(a / 60)) + ':' + p2(a % 60) + (off === 480 ? ' (Asia/Shanghai)' : '');
}

module.exports = { stamp, stampMs, tzOffsetMin, tzLabel };
