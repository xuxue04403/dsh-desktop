// spawn 能力探针：inherit 与 pipe 两种 stdio
const { spawn } = require('child_process');
const p1 = spawn('node', ['-e', "console.log('inherit-ok')"], { stdio: 'inherit' });
p1.on('exit', (c) => {
  console.log('inherit exit', c);
  const p2 = spawn('node', ['-e', "console.log('pipe-ok')"]);
  p2.stdout.on('data', (d) => process.stdout.write('OUT:' + d));
  p2.on('exit', (c2) => console.log('pipe exit', c2));
});