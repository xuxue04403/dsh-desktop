// tests/email-scrub.test.js — R27 发布安全闸门回归测试
//
// 目标：确认「真实邮箱信息/密钥」在推送 GitHub 前会被拦下，且占位符/普通代码不会误报。
// 敏感值全部由本机 dsh 配置派生（源码内不出现真实邮箱地址、服务器或密钥）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRules, scanTree, scrubTree, mask, SKIP_DIRS, resolveTar, verifyZip, ruleMatchSpan } from '../scripts/email-scrub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'out', '_guard-test');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

let n = 0;
const ok = (name, extra) => { n++; console.log('✓ ' + name + (extra ? '  ' + extra : '')); };

const { rules, cfg } = buildRules();
const hasLive = cfg.addresses.length + cfg.hosts.length + cfg.secrets.length > 0;
console.log('[..] 规则 ' + rules.length + ' 条（本机地址 ' + cfg.addresses.length + ' / 主机 ' + cfg.hosts.length +
  ' / 凭据 ' + cfg.secrets.length + ' / 域名 ' + cfg.domains.length + '）');

// 1) 掩码不泄露明文
{
  const m = mask('someone@somewhere.example');
  assert.ok(!m.includes('someone'), 'mask 不应包含账号明文');
  ok('mask 掩码隐藏账号明文', m);
}

// 2) 占位符不产生规则（否则会误改自家模板 / 误报）
{
  assert.ok(!rules.some((r) => /example\.com/i.test(r.label) && r.literal), 'example.com 不应进入规则');
  ok('占位符（example.com）不进入规则');
}

// 3) 干净文件不命中
{
  fs.writeFileSync(path.join(tmp, 'clean.js'), "const host = 'imap.example.com';\nconst user = 'you@example.com';\n", 'utf8');
  const r = scanTree([tmp], { rules });
  assert.equal(r.findings.length, 0, '干净文件不应命中：' + JSON.stringify(r.findings));
  ok('干净占位符文件不命中', r.files + ' 文件');
}

// 4) 真实值命中（使用本机配置派生出的真实地址/主机/密码拼装测试样本）
if (hasLive) {
  const live = cfg.addresses[0] || cfg.addresses.length ? cfg.addresses[0] : '';
  const parts = [];
  if (live) parts.push('const user = ' + JSON.stringify(live) + ';');
  if (cfg.hosts[0]) parts.push('const host = ' + JSON.stringify(cfg.hosts[0]) + ';');
  if (cfg.secrets[0]) parts.push('const pass = ' + JSON.stringify(cfg.secrets[0]) + ';');
  const dirty = path.join(tmp, 'dirty.js');
  fs.writeFileSync(dirty, parts.join('\n') + '\n', 'utf8');
  const r = scanTree([tmp], { rules });
  assert.ok(r.findings.length >= parts.length, '真实值应全部命中，实际 ' + r.findings.length + '/' + parts.length);
  const kinds = new Set(r.findings.map((f) => f.rule));
  ok('真实邮箱/密钥命中并被掩码报告', '命中 ' + r.findings.length + ' 处 [' + [...kinds].join(',') + ']');
  assert.ok(r.findings.every((f) => !f.sample.includes('@') || f.sample.startsWith(f.sample[0] + '***')), '报告必须是掩码');

  // 5) --scrub 就地脱敏后复扫干净（干净文件不被改动）
  const before = fs.readFileSync(path.join(tmp, 'clean.js'), 'utf8');
  const s = scrubTree([tmp], { rules });
  assert.ok(s.changed >= 1, '应至少改写 1 个文件');
  assert.equal(fs.readFileSync(path.join(tmp, 'clean.js'), 'utf8'), before, '干净文件不应被改动');
  const after = scanTree([tmp], { rules });
  assert.equal(after.findings.length, 0, '脱敏后应无残留：' + JSON.stringify(after.findings.slice(0, 3)));
  ok('--scrub 脱敏后复扫无残留', '改写 ' + s.changed + ' 文件');
} else {
  console.log('[..] 本机无 email-bridge 配置，跳过真实值命中用例（仅验证规则空转）');
}

// 6) CLI 退出码：干净 → 0
{
  const cleanDir = path.join(tmp, 'cli-clean');
  fs.mkdirSync(cleanDir, { recursive: true });
  fs.writeFileSync(path.join(cleanDir, 'a.js'), "const h='imap.example.com';\n", 'utf8');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'email-scrub.mjs'), '--scan', cleanDir], { stdio: 'ignore' });
  assert.equal(r.status, 0, 'CLI 干净目录应退出 0，实际 ' + r.status);
  ok('CLI --scan 干净目录退出码 0');
}

// 7) CLI 退出码：命中 → 1（内容用真实值构造，一次性写入临时目录）
if (hasLive && (cfg.addresses[0] || cfg.hosts[0] || cfg.secrets[0])) {
  const dirtyDir = path.join(tmp, 'cli-dirty');
  fs.mkdirSync(dirtyDir, { recursive: true });
  const v = cfg.addresses[0] || cfg.hosts[0] || cfg.secrets[0];
  fs.writeFileSync(path.join(dirtyDir, 'leak.txt'), 'value = ' + JSON.stringify(v) + '\n', 'utf8');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'email-scrub.mjs'), '--scan', dirtyDir], { stdio: 'ignore' });
  assert.equal(r.status, 1, 'CLI 命中应退出 1，实际 ' + r.status);
  ok('CLI --scan 命中真实值退出码 1（发布被阻断）');
}

// 8) 二进制文件只做字面量匹配：随机 sk- 形态不应误报（Electron 二进制曾误报 238 处）
{
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const filler = Buffer.from('sk-' + 'A'.repeat(40) + '\x00\x01\x02', 'latin1');
  fs.writeFileSync(path.join(binDir, 'fake.exe'), filler);
  const r = scanTree([binDir], { rules });
  assert.equal(r.findings.length, 0, '二进制中的 api-key 形态不应命中：' + JSON.stringify(r.findings));
  ok('二进制文件跳过通用形态规则（只匹配真实值）');
}

// 9) 允许清单：第三方公共预设（nodemailer well-known）不误报
{
  const vendor = path.join(tmp, 'node_modules', 'nodemailer', 'lib', 'well-known');
  fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(path.join(vendor, 'services.json'), '{"host":"smtp.qq.com"}\n', 'utf8');
  const r = scanTree([tmp], { rules });
  const hit = r.findings.filter((f) => /well-known/.test(f.where));
  assert.equal(hit.length, 0, '允许清单文件不应命中');
  ok('第三方公共预设走允许清单', '跳过 ' + r.skipped + ' 文件');
}

// 10) 真实仓库当前状态：源码树无邮箱/密钥信息（发布前提）
{
  const r = scanTree([root], { rules, skipDirs: SKIP_DIRS });
  assert.equal(r.findings.length, 0, '源码树仍有命中：\n' + r.findings.slice(0, 5).map((f) => f.where + ':' + f.line + ' ' + f.label).join('\n'));
  ok('仓库源码树扫描干净', r.files + ' 文件');
}

// 11) 扫描根即使名字命中跳过名单也必须被扫描（曾导致产物闸门静默扫 0 个文件）
{
  const stageDir = path.join(root, 'out', '_guard-scanroot');   // 名字命中跳过名单/曾静默 0 文件的场景
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'resources', 'a.js'), "const h='imap.example.com';\n", 'utf8');
  const r = scanTree([stageDir], { rules });
  assert.equal(r.files, 1, '显式传入的产物目录必须被扫描，实际 ' + r.files + ' 文件');
  fs.rmSync(stageDir, { recursive: true, force: true });
  const selfDir = path.join(tmp, 'node_modules');       // 目录名命中跳过名单
  fs.mkdirSync(selfDir, { recursive: true });
  fs.writeFileSync(path.join(selfDir, 'b.txt'), 'ok\n', 'utf8');
  const r2 = scanTree([selfDir], { rules });
  assert.equal(r2.files, 1, '名为 node_modules 的扫描根也必须被扫描，实际 ' + r2.files);
  ok('扫描根不被跳过名单吞掉（产物闸门 0 文件的回归）');
}

// 12) 闸门 fail-closed（审计 P0）：派生不出任何真实值规则时**必须拒绝放行**。
//     复现方式：把脚本复制到临时目录（其 root 下没有 out\*\data\gateway.config.json），
//     并让 DSH_HOME_DIR 指向空目录 → literal 规则数为 0 → CLI 必须退出 2，而不是
//     旧版那样只剩通用形态规则还打印 [OK]。
{
  const iso = path.join(tmp, 'iso');
  fs.mkdirSync(path.join(iso, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts', 'email-scrub.mjs'), path.join(iso, 'scripts', 'email-scrub.mjs'));
  const emptyHome = path.join(iso, 'empty-home');
  fs.mkdirSync(emptyHome, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(iso, 'scripts', 'email-scrub.mjs'), '--scan', tmp], {
    stdio: 'ignore',
    env: Object.assign({}, process.env, { DSH_HOME_DIR: emptyHome, DSH_SCRUB_EXTRA: '' }),
  });
  assert.equal(r.status, 2, '无任何本机真实值规则时必须 fail-closed（退出 2），实际 ' + r.status);
  ok('闸门 fail-closed：规则源缺失时拒绝放行（退出 2）');
}

// 13) --scrub 备份（审计 P2）：就地改写前写 <文件>.bak-scrub；已存在则不覆盖（保留首次备份）；
//     且 *.bak-scrub（含原始真实值）走允许清单——既不参与扫描也不随源码上传。
if (hasLive && (cfg.addresses[0] || cfg.hosts[0] || cfg.secrets[0])) {
  const v = cfg.addresses[0] || cfg.hosts[0] || cfg.secrets[0];
  const bakDir = path.join(tmp, 'bak');
  fs.mkdirSync(bakDir, { recursive: true });
  const f = path.join(bakDir, 'cfg.js');
  const orig = 'const user = ' + JSON.stringify(v) + ';\n';
  fs.writeFileSync(f, orig, 'utf8');
  const first = scrubTree([bakDir], { rules });
  assert.equal(first.changed, 1, '应改写 1 个文件');
  assert.ok(first.backups.includes(f + '.bak-scrub'), '应写出 .bak-scrub 备份');
  assert.equal(fs.readFileSync(f + '.bak-scrub', 'utf8'), orig, '备份必须是改写前的原文');
  assert.equal(scanTree([bakDir], { rules }).findings.length, 0, '*.bak-scrub 不应被扫描（否则等于把真实值又扫出来）');
  fs.writeFileSync(f, 'const user = ' + JSON.stringify(v) + '; // again\n', 'utf8');
  const second = scrubTree([bakDir], { rules });
  assert.equal(second.changed, 1, '第二次改写应生效');
  assert.equal(second.backups.length, 0, '备份已存在时不得重复写（保留首次备份）');
  assert.equal(fs.readFileSync(f + '.bak-scrub', 'utf8'), orig, '首次备份不得被覆盖');
  assert.ok(!fs.readFileSync(f, 'utf8').includes(v), '改写后不得残留真实值');
  ok('--scrub 写 .bak-scrub 备份且不覆盖首次备份');
}

// 14) --scrub 对非 UTF-8（GBK/ANSI）文件 fail-closed（审计 P2）：跳过 + 计入报告，
//     绝不解码成 U+FFFD 后写回（那是不可逆损坏）。字节级断言原文件未被改动。
if (hasLive && (cfg.addresses[0] || cfg.hosts[0] || cfg.secrets[0])) {
  const v = cfg.addresses[0] || cfg.hosts[0] || cfg.secrets[0];
  const gbkDir = path.join(tmp, 'gbk');
  fs.mkdirSync(gbkDir, { recursive: true });
  const gbkFile = path.join(gbkDir, 'ansi.txt');
  const gbkBytes = Buffer.concat([
    Buffer.from([0xd6, 0xd0, 0xba, 0xc3]),                 // GBK「中文」= 非法 UTF-8 序列
    Buffer.from(' user=' + v + '\r\n', 'utf8'),
  ]);
  fs.writeFileSync(gbkFile, gbkBytes);
  const s = scrubTree([gbkDir], { rules });
  assert.ok(s.skippedNonUtf8.includes(gbkFile), '非 UTF-8 文件必须被跳过并计入报告');
  assert.equal(s.changed, 0, '非 UTF-8 文件不得被改写');
  assert.ok(fs.readFileSync(gbkFile).equals(gbkBytes), '非 UTF-8 文件必须逐字节保持原样（不得写入 U+FFFD）');
  ok('--scrub 跳过非 UTF-8 文件（fail-closed，不写 U+FFFD）');
}

// 15) zip 完整性校验（审计 P2）：完整 zip 可枚举条目；截断/空 zip 必须被判损坏
//     （tar 被打断留下的半截 zip 会被 reupload-zip.ps1 / publish.mjs 直接上传）。
{
  const tar = resolveTar();
  const zipDir = path.join(tmp, 'zip');
  fs.mkdirSync(path.join(zipDir, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(zipDir, 'inner', 'a.txt'), 'hello\n', 'utf8');
  fs.writeFileSync(path.join(zipDir, 'b.txt'), 'world\n', 'utf8');
  const empty = path.join(tmp, 'empty.zip');
  fs.writeFileSync(empty, Buffer.alloc(0));
  assert.equal(verifyZip(empty).ok, false, '空 zip 必须被拒绝');
  if (tar) {
    const zipPath = path.join(tmp, 'good.zip');
    const r = spawnSync(tar, ['-a', '-cf', zipPath, '-C', zipDir, '.'], { stdio: 'ignore' });
    assert.equal(r.status, 0, 'tar 打包应成功');
    const good = verifyZip(zipPath);
    assert.ok(good.ok, '完整 zip 应通过校验：' + good.reason);
    assert.ok(good.entries >= 2, '应能列出条目，实际 ' + good.entries);
    assert.ok(good.names.some((x) => /a\.txt$/.test(x)), '条目名应可枚举：' + good.names.join(','));
    const full = fs.readFileSync(zipPath);
    const trunc = path.join(tmp, 'trunc.zip');
    fs.writeFileSync(trunc, full.subarray(0, Math.max(1, full.length - 64)));
    const bad = verifyZip(trunc);
    assert.equal(bad.ok, false, '截断 zip 必须被判定为损坏');
    ok('zip 校验：完整可枚举 / 截断与空文件被拒绝', bad.reason);
    if (hasLive) {
      const rz = spawnSync(process.execPath, [path.join(root, 'scripts', 'email-scrub.mjs'), '--scan-zip', trunc], { stdio: 'ignore' });
      assert.equal(rz.status, 2, '--scan-zip 遇到半截 zip 必须 fail-closed（退出 2），实际 ' + rz.status);
      ok('--scan-zip 拒绝半截 zip（fail-closed 退出 2）');
    }
  } else {
    console.log('[..] 本机 PATH 与 System32 均无 tar，跳过 zip 打包/截断用例');
  }
}

// 16) CLI 入口判定大小写不敏感（审计 P2）：Windows 路径大小写不敏感，以小写盘符调用时
//     旧版 `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` 为 false →
//     脚本什么都不做却 **exit 0**（安全闸门静默失效）。这里用真实命中样本断言它照常执行。
if (hasLive && (cfg.addresses[0] || cfg.hosts[0] || cfg.secrets[0])) {
  const v = cfg.addresses[0] || cfg.hosts[0] || cfg.secrets[0];
  const dirtyDir = path.join(tmp, 'cli-lower');
  fs.mkdirSync(dirtyDir, { recursive: true });
  fs.writeFileSync(path.join(dirtyDir, 'leak.txt'), 'value = ' + JSON.stringify(v) + '\n', 'utf8');
  const lowerScrub = path.join(root, 'scripts', 'email-scrub.mjs').toLowerCase();
  const r = spawnSync(process.execPath, [lowerScrub, '--scan', dirtyDir], { stdio: 'ignore' });
  assert.equal(r.status, 1, '小写盘符调用必须照常命中并退出 1，实际 ' + r.status + '（旧版 fail-open 退出 0）');
  const r2 = spawnSync(process.execPath, [lowerScrub, '--list-rules'], { stdio: 'ignore' });
  assert.equal(r2.status, 0, '小写盘符 --list-rules 应退出 0');
  // extract-exe-icon.mjs 同类判定：小写盘符调用且 exe 不存在时必须报错退出（而非静默 exit 0）
  const lowerIcon = path.join(root, 'scripts', 'extract-exe-icon.mjs').toLowerCase();
  const r3 = spawnSync(process.execPath, [lowerIcon, path.join(tmp, 'nope.exe'), path.join(tmp, 'out.ico')], { stdio: 'ignore' });
  assert.notEqual(r3.status, 0, '小写盘符调用 extract-exe-icon.mjs 必须真的执行（exe 不存在 → 非零退出），实际 ' + r3.status);
  ok('CLI 入口判定大小写不敏感（小写盘符不再静默 exit 0）');
}

// 17) 分块扫描 overlap 必须按「实际可能匹配长度」预留（审计 P2）：
//     旧版用正则源码长度 → email-domain 的 local part 可远长于源码长度时预留不足。
{
  for (const r of rules) {
    assert.ok(ruleMatchSpan(r) >= r.re.source.length, r.id + ' 的 overlap 不得小于正则源码长度');
    if (r.maxMatch) assert.equal(ruleMatchSpan(r), r.maxMatch, r.id + ' 应使用显式 maxMatch');
  }
  const dom = rules.find((r) => r.id === 'email-domain');
  if (dom) assert.ok(ruleMatchSpan(dom) >= 320, 'email-domain 需要按上限预留 overlap');
  const unbounded = rules.find((r) => /[+*]/.test(r.re.source) && !r.maxMatch);
  if (unbounded) assert.equal(ruleMatchSpan(unbounded), 4096, '含无界量词的规则应预留 4096');
  ok('分块扫描 overlap 覆盖实际匹配长度上限');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n[OK] email-scrub 用例 ' + n + ' 项全部通过');
