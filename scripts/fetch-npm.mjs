// 一次性工具：获取一份自包含的 npm 包，供绿目录构建内嵌（与 out/_pnpm11 同模式）。
// 背景：本机没有独立 Node.js（`node` 就是 Electron），因此项目里没有任何 node_modules\npm
// 可复制 —— 三个构建脚本的 npm 候选源全部落空，导致产物缺少内嵌 npm，
// dsh 自动升级回退到 PATH 的 `npm` 而失败（2026-09-25 实际发生）。
// npm 的发布 tarball 自带 node_modules（其依赖已 bundle），所以解压即自包含。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 第二轮审计修复：项目根由本文件位置推导，不再硬编码开发机路径。
// 旧实现写死 `D:\IDE\dsh\dsh-app` —— 在其它路径的克隆/副本上运行时，它会去**那个固定路径**
// 下载并覆盖 out\_npm，而当前仓库的 out\_npm 始终缺失 → 依赖它的 build-portable /
// build-uat / prepare-extra 三个候选源全部落空（只打印一行"未找到内嵌 npm"），
// 产物缺少内嵌 npm，dsh 自动升级回退到 PATH 的 npm 而失败（正是本文件注释里那次事故的形态）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', '_npm');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const VERSION = process.argv[2] || '12.1.0';
const REGISTRY = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';

if (!existsSync(TAR)) { console.error('找不到 tar.exe: ' + TAR); process.exit(1); }
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const url = REGISTRY.replace(/\/+$/, '') + '/npm/-/npm-' + VERSION + '.tgz';
const tgz = path.join(OUT, 'npm.tgz');
console.log('下载 ' + url);
const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
if (!res.ok) { console.error('下载失败 HTTP ' + res.status); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync(tgz, buf);
console.log('  ' + (buf.length / 1048576).toFixed(2) + ' MB → ' + tgz);

console.log('解压 …');
const r = spawnSync(TAR, ['-xzf', tgz, '-C', OUT], { encoding: 'utf8' });
if (r.status !== 0) { console.error('解压失败: ' + (r.stderr || r.stdout)); process.exit(1); }

const pkg = path.join(OUT, 'package');
const cli = path.join(pkg, 'bin', 'npm-cli.js');
if (!existsSync(cli)) { console.error('缺少 bin/npm-cli.js —— tarball 结构异常'); process.exit(1); }

// 自包含性检查：npm 发布包含己方依赖时才有 node_modules
const bundled = existsSync(path.join(pkg, 'node_modules'));
const version = JSON.parse((await import('node:fs')).readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;

function dirSize(dir) {
  let total = 0, files = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const s = dirSize(p); total += s.total; files += s.files; }
    else { try { total += statSync(p).size; files++; } catch (_) { /* 跳过 */ } }
  }
  return { total, files };
}
const s = dirSize(pkg);
console.log('');
console.log('版本      : ' + version);
console.log('自包含    : ' + (bundled ? '是（自带 node_modules）' : '否 —— 需要额外依赖，内嵌会失败'));
console.log('体积      : ' + (s.total / 1048576).toFixed(2) + ' MB / ' + s.files + ' 文件');
console.log('产物      : ' + pkg);
console.log('');
console.log(bundled ? '[OK] 可内嵌' : '[FAIL] 不可内嵌');
process.exit(bundled ? 0 : 1);
