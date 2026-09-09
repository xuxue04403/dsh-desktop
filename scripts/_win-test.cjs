// 验证：cmd.exe 包裹（windowsHide）下，孙进程 pwsh 不弹窗
'use strict';
const { spawn } = require('child_process');
// 模拟 dsh 行为：spawn pwsh（无 windowsHide）——通过 cmd 链验证是否弹窗
// 链：node(本进程) → cmd.exe(windowsHide) → DSH-App.exe(RUN_AS_NODE) → pwsh -Command
const app = 'D:/IDE/dsh/dsh-app/out/DSH-App/DSH-App.exe';
const inner = `const {spawn}=require('child_process');`
  + `const c=spawn('pwsh',['-NoProfile','-Command','Write-Output hidden-ok'],{stdio:['ignore','pipe','pipe']});`
  + `let o='';c.stdout.on('data',d=>o+=d);`
  + `c.on('exit',()=>{console.log('grandchild:',o.trim());process.exit(0)});`;
const viaCmd = spawn('cmd.exe', ['/d', '/s', '/c', `"${app}" -e ${JSON.stringify(inner)}`], {
  windowsHide: true,
  env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
viaCmd.stdout.on('data', (d) => { out += d; });
viaCmd.on('exit', (code) => {
  console.log('cmd 链退出:', code, '| 输出:', out.trim());
  console.log('（请目视确认：执行期间是否弹出 PowerShell 黑窗）');
});