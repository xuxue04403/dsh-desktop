// scripts/vendor-email-bridge.mjs — 把 dsh-email-bridge 插件连同其运行依赖打包进 out\_vendor
//
// 用法：node scripts/vendor-email-bridge.mjs [--src <插件目录>]
// 默认源：D:\IDE\dsh\dsh-email-bridge
//
// 产物：out\_vendor\dsh-email-bridge\{package.json,lib\,README.md,node_modules\}
//   - 第三方运行依赖（imapflow/mailparser/nodemailer/js-yaml）扁平化安装（真实目录，
//     无 pnpm 符号链接，便于随 app 分发）
//   - **不**打包 @deepseek-ai/* 宿主包：安装到 dsh profile 时由 dsh-app 建立指向宿主
//     同名包的 junction（保证与宿主同一实例，避免 rc 版本漂移导致的 identity 问题）
//   - 之后由 build-portable.mjs / build-uat.mjs 复制到 <appDir>\resources\vendor\
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const srcArg = (() => { const i = args.indexOf('--src'); return i >= 0 ? args[i + 1] : ''; })();
const src = srcArg || 'D:\\IDE\\dsh\\dsh-email-bridge';
const destRoot = path.join(root, 'out', '_vendor');
const dest = path.join(destRoot, 'dsh-email-bridge');

if (!existsSync(path.join(src, 'package.json'))) {
  console.error('[错误] 找不到插件源: ' + src);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8'));
// 第三方运行依赖（扁平安装；@deepseek-ai/* 宿主包一律不打包——由 dsh 官方
// $DSH_HOME/profiles/node_modules 兜底闭包解析，见 default-plugins.js）。
// R25（审计修复）：移除 @deepseek-ai/schemastery——它是 HOST_PACKAGES 之一，
// 装进 vendor 会在插件 node_modules 形成嵌套副本，优先于宿主解析（实例漂移）。
const runtimeDeps = ['imapflow', 'mailparser', 'nodemailer', 'js-yaml'];

console.log('[..] 清理并复制插件源 → ' + dest);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const rel of ['package.json', 'README.md', 'lib']) {
  const from = path.join(src, rel);
  if (!existsSync(from)) { console.log('  (跳过缺失项 ' + rel + ')'); continue; }
  cpSync(from, path.join(dest, rel), { recursive: true });
}

// 生成用于分发的 package.json：保留 dsh 契约与 exports，依赖收敛为第三方运行依赖
const outPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: pkg.type ?? 'module',
  main: pkg.main ?? 'lib/index.js',
  exports: pkg.exports,
  license: pkg.license ?? 'MIT',
  dsh: pkg.dsh,
  dependencies: runtimeDeps.reduce((acc, name) => {
    const v = (pkg.dependencies ?? {})[name] || '*';
    acc[name] = v;
    return acc;
  }, {}),
  // R24（关键，2026-09-10 事故教训）：声明 bundleDependencies —— pnpm 对 file: 依赖
  // 打包安装时把这些包的 node_modules 原样带入（离线可装）。配合 profile
  // package.json 声明 "dsh-email-bridge": "file:vendor/dsh-email-bridge"，
  // pnpm 永远不会把该插件当"多余包"清除（悬空挂载条目会让 dsh 整树启动失败）。
  bundleDependencies: runtimeDeps.slice(),
  peerDependencies: {},
  peerDependenciesMeta: {},
};
// 宿主提供、运行时由 dsh-app 以 junction 注入的包（peer 声明便于诊断，不参与安装）
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  outPkg.peerDependencies[name] = range;
}
writeFileSync(path.join(dest, 'package.json'), JSON.stringify(outPkg, null, 2) + '\n', 'utf8');

console.log('[..] 扁平安装运行依赖: ' + runtimeDeps.join(', '));
const npmCli = (() => {
  const local = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(local)) return local;
  const beside = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(beside)) return beside;
  return null;
})();
const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock',
  '--install-strategy=hoisted',
  // R25（审计修复）：禁止 npm 自动安装 peerDependencies——vendor 的 package.json
  // peerDependencies 含 @deepseek-ai/cordis（可选），npm 7+ 会自动装上并在
  // node_modules/@deepseek-ai 混入 cordis/cosmokit 副本（已实证），与宿主实例漂移
  '--legacy-peer-deps',
  '--cache', path.join(root, 'out', '_npm-cache'),
  '--registry', process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com',
  ...runtimeDeps];
const r = npmCli
  ? spawnSync(process.execPath, [npmCli, ...npmArgs], { cwd: dest, stdio: 'inherit' })
  : spawnSync('npm', npmArgs, { cwd: dest, stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.error('[错误] 依赖安装失败（退出码 ' + r.status + '）');
  process.exit(1);
}

// 记录版本清单，便于安装端判断是否需要刷新
const meta = {
  name: outPkg.name,
  version: outPkg.version,
  vendoredAt: new Date().toISOString(),
  runtimeDeps: runtimeDeps.map((n) => {
    try {
      return n + '@' + JSON.parse(readFileSync(path.join(dest, 'node_modules', n, 'package.json'), 'utf8')).version;
    } catch (_) { return n + '@?'; }
  }),
};
writeFileSync(path.join(destRoot, 'vendor-meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

const size = (() => {
  let total = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else total += statSync(p).size;
    }
  };
  walk(dest);
  return (total / 1048576).toFixed(2);
})();
console.log('[OK] 已打包 ' + outPkg.name + '@' + outPkg.version + ' → ' + dest + '（' + size + ' MB）');
console.log('     meta: ' + path.join(destRoot, 'vendor-meta.json'));
