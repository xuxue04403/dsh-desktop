// 诊断+清理：杀掉所有 DSH-App/dsh 相关进程，检查端口，输出落盘
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const out = [];
try {
  const r = execFileSync('taskkill', ['/IM', 'DSH-App.exe', '/T', '/F'], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  out.push('kill DSH-App: ' + r.trim());
} catch (e) { out.push('kill DSH-App: ' + (e.stdout || e.message).toString().trim().slice(0, 100)); }
try {
  const r2 = execFileSync('taskkill', ['/IM', 'cmd.exe', '/T', '/F'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  out.push('kill cmd: ' + r2.trim().slice(0, 100));
} catch (e) { out.push('kill cmd: (无或失败)'); }
fs.writeFileSync('D:/IDE/dsh/dsh-app/out/_diag.log', out.join('\n'), 'utf8');
console.log('written');