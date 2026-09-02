#!/usr/bin/env node
/**
 * Gateway E2E test (localhost only; no external network needed).
 * Spawns 3 mock upstreams + 1 gateway with a test config, then asserts routes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 3190;
const GATEWAY_PORT = 3199;
const API_KEY = 'test-key-123';
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
const CONFIG = path.join(APP_DIR, 'gateway.config.json');
const LOG = path.join(APP_DIR, 'gateway.log');
const BASE = `http://127.0.0.1:${GATEWAY_PORT}`;

const config = {
  port: GATEWAY_PORT,
  apiKey: API_KEY,
  providers: [
    { id: 'A', baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'k-a', models: ['deepseek-v4-flash'], priority: 1, enabled: true },
    { id: 'B', baseURL: `http://127.0.0.1:${MOCK_PORT + 1}/v1`, apiKey: 'k-b', models: ['deepseek-v4-flash'], priority: 2, enabled: true },
    { id: 'C', baseURL: `http://127.0.0.1:${MOCK_PORT + 2}/v1`, apiKey: 'k-c', models: ['glm-5.2'], priority: 3, enabled: true },
  ],
};
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));

function start(script, env) {
  // NOTE: stdio must be 'ignore' — the harness sandbox blocks piped stdio
  // capture for spawned children (documented EPERM boundary).
  return spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${extra}`); }
}

async function main() {
  const mockA = start(path.join(__dirname, '_mock-upstreams.mjs'), { MOCK_PORT: String(MOCK_PORT) });
  const gw = start(path.join(__dirname, 'model-gateway.mjs'), {
    DSH_GATEWAY_CONFIG: CONFIG,
    DSH_GATEWAY_LOG: LOG,
    DSH_GATEWAY_VERBOSE: '0',
  });
  await sleep(1200);

  const call = async (pathname, opts = {}) => {
    const res = await fetch(`${BASE}${pathname}`, {
      method: opts.method || 'GET',
      headers: { ...(opts.headers || {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  };

  try {
    // 1) auth
    let r = await call('/v1/models');
    check('401 without key', r.status === 401, `got ${r.status}`);
    r = await call('/v1/models', { headers: { authorization: `Bearer ${API_KEY}` } });
    check('200 with key', r.status === 200, `got ${r.status}`);

    // 2) merged catalog
    const cat = JSON.parse(r.text);
    const ids = cat.data.map((m) => m.id).sort();
    check('catalog merged A+B+C', JSON.stringify(ids) === JSON.stringify(['deepseek-v4-flash', 'glm-5.2']), `got ${ids}`);

    // 3) route to healthy A (B down -> failover must pick A)
    r = await call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    check('served by A (failover past dead B)', r.status === 200 && r.text.includes('mock-A'), `got ${r.status} ${r.text.slice(0, 120)}`);

    // 4) glm-5.2 only on C
    r = await call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    check('glm-5.2 served by C', r.status === 200 && r.text.includes('mock-C'), `got ${r.status} ${r.text.slice(0, 120)}`);

    // 5) SSE streaming passthrough
    r = await call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    check('SSE passthrough', r.status === 200 && r.text.includes('mock-A') && r.text.includes('[DONE]'), `got ${r.status} ${r.text.slice(0, 200)}`);

    // 6) unknown model -> 404
    r = await call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { model: 'no-such-model', messages: [] },
    });
    check('unknown model 404', r.status === 404, `got ${r.status}`);

    // 7) unsupported route
    r = await call('/v1/whatever', { headers: { authorization: `Bearer ${API_KEY}` } });
    check('unsupported route 404', r.status === 404, `got ${r.status}`);
  } finally {
    gw.kill();
    mockA.kill();
    fs.rmSync(APP_DIR, { recursive: true, force: true });
  }

  console.log(`\n===== ${passed} passed, ${failed} failed =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });