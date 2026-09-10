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
import { buildRules, scanTree, scrubTree, mask, SKIP_DIRS } from '../scripts/email-scrub.mjs';

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
  const stageDir = path.join(root, 'out', '_zip-stage');
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n[OK] email-scrub 用例 ' + n + ' 项全部通过');
