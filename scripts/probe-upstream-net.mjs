// probe-upstream-net.mjs — 上游链路体检：区分"网关没走代理" / "代理节点坏了" / "上游挂了"
// 用法：node scripts/probe-upstream-net.mjs [--config <gateway.config.json 路径>]
// 背景（2026-09-18 事故）：三家境外上游 5.0s ECONNRESET，日志提示"代理未运行"，
// 实为 Clash 节点侧抖动——本脚本把判定做实：
//   · 代理端口在听吗（TCP）
//   · 每个上游域名：直连 vs 走代理 CONNECT+TLS+GET，各自成败与耗时
//   · 该域名是否在 NO_PROXY 直连清单里（网关是否"按要求走代理"）
// 判定：走代理成功 → 链路与代理正常（网关侧没问题）；直连也失败且代理也失败 → 节点/规则问题，去 Clash 换节点。
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import path from 'node:path';

const argv = process.argv.slice(2);
const cfgPath = (() => {
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return path.join(process.cwd(), 'out', 'DSH-App', 'data', 'gateway.config.json');
})();
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const proxyUrl = cfg.proxy && cfg.proxy.enabled !== false ? cfg.proxy.url : null;
const proxy = proxyUrl ? new URL(proxyUrl) : null;
const noProxy = (cfg.proxy && cfg.proxy.noProxy) || [];
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

const tcp = (host, port, ms = 3000) => new Promise((res) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); res('超时'); }, ms);
  s.on('connect', () => { clearTimeout(t); s.destroy(); res('OPEN'); });
  s.on('error', (e) => { clearTimeout(t); res(e.code); });
});

const httpsProbe = (host, pathName, viaProxy, ms = 10000) => new Promise((res) => {
  const t0 = Date.now();
  const finish = (label, sock) => { try { sock.destroy(); } catch { /* 忽略 */ } res(`${label} ${Date.now() - t0}ms`); };
  const doTls = (socket) => {
    const s = tls.connect({ socket, ...(viaProxy ? { servername: host } : { host, port: 443, servername: host }) });
    const t = setTimeout(() => finish('超时', s), ms);
    s.on('secureConnect', () => s.write(`GET ${pathName} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: probe\r\nConnection: close\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\r\n')) { clearTimeout(t); finish(buf.split('\r\n')[0].trim() || '空响应', s); } });
    s.on('error', (e) => { clearTimeout(t); finish('TLS-' + e.code, s); });
    s.on('close', () => { clearTimeout(t); finish(buf ? '半截数据' : 'TLS-未握手即断开', s); });
  };
  if (!viaProxy) return doTls(undefined);
  const req = http.request({ host: proxy.hostname, port: proxy.port || 7890, method: 'CONNECT', path: `${host}:443`, timeout: ms });
  req.on('connect', (r, socket) => { if (r.statusCode !== 200) { socket.destroy(); return res(`CONNECT-${r.statusCode} ${Date.now() - t0}ms`); } doTls(socket); });
  req.on('timeout', () => { req.destroy(); res(`CONNECT-超时 ${Date.now() - t0}ms`); });
  req.on('error', (e) => res(`CONNECT-${e.code} ${Date.now() - t0}ms`));
  req.end();
});

const inNoProxy = (host) => directList.some((d) => host === d || host.endsWith('.' + d) || host === 'www.' + d);
// 与 gateway-manager.computeNoProxy() 保持一致：回环 + 内置国内直连 + proxy.noProxy + 供应商级 proxy:false
const directList = LOOPBACK.concat(noProxy, (cfg.providers || [])
  .filter((p) => p && p.enabled !== false && (p.proxy === false || p.noProxy === true))
  .map((p) => { try { return new URL(p.baseURL).hostname; } catch { return ''; } })
  .filter(Boolean));

console.log(`配置: ${cfgPath}`);
console.log(`代理: ${proxyUrl || '(未启用)'}   直连清单: ${directList.join(', ')}`);
if (proxy) console.log(`代理端口 ${proxy.hostname}:${proxy.port || 7890} → ${await tcp(proxy.hostname, proxy.port || 7890)}`);
console.log('');
for (const p of cfg.providers || []) {
  if (p.enabled === false) continue;
  let host = '';
  try { host = new URL(p.baseURL).host; } catch { console.log(`  ${String(p.id).padEnd(12)} baseURL 无法解析: ${p.baseURL}`); continue; }
  const direct = await httpsProbe(host, '/', false);
  const prox = proxy ? await httpsProbe(host, '/', true) : '(未配置代理)';
  const tag = inNoProxy(host) ? '直连清单内' : (proxy ? '走代理' : '直连');
  console.log(`  ${String(p.id).padEnd(12)} ${host.padEnd(30)} [${tag}]`);
  console.log(`      ${''.padEnd(30)} 直连: ${String(direct).padEnd(26)} 走代理: ${prox}`);
}
console.log('\n提示：401/403/404 都算"链路通"（只是没带 Key 或路径不对）；ECONNRESET/超时才算不通。');
