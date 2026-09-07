// 全树扫描：查找真实 key/token（github_pat_/sk- 真值、代理等）——排除 out/node_modules/dist/.git
'use strict';
const fs = require('fs');
const path = require('path');
const root = 'D:/IDE/dsh/dsh-app';
const SKIP = new Set(['node_modules', 'out', 'dist', '.git']);
const pats = [
  { name: 'github_pat', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'sk-key', re: /\bsk-[A-Za-z0-9]{16,}/g },
  { name: 'ghp-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'sk-ant', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
];
const whitelist = /(github_pat_\*\*\*|sk-\*\*\*|sk-xxx|FAKE|TESTFAKE|example|change-me|dsh-gateway)/;
let issues = 0, files = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { walk(fp); continue; }
    files++;
    const ext = path.extname(e.name).toLowerCase();
    if (!['.js', '.mjs', '.cjs', '.json', '.html', '.md', '.ps1', '.yml', '.yaml', '.txt', '.gitignore'].includes(ext)) continue;
    const text = fs.readFileSync(fp, 'utf8');
    for (const p of pats) {
      let m;
      while ((m = p.re.exec(text))) {
        if (whitelist.test(m[0])) continue;
        const ln = text.slice(0, m.index).split('\n').length;
        console.log(`[泄露] ${path.relative(root, fp)}:${ln} ${p.name}: ${m[0].slice(0, 12)}…(len=${m[0].length})`);
        issues++;
      }
    }
  }
}
walk(root);
console.log(`\n扫描 ${files} 个文件，发现 ${issues} 处真实 key`);
process.exit(issues > 0 ? 1 : 0);