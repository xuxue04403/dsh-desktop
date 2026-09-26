// 审计缺陷修复补丁（2026-09-23）。
//
// 为什么用脚本而不是逐条编辑：本会话读到的文件内容**经过网关自身的 R9c 降敏**
//（desensitizeLongTokens，把 ≥32 字符的 [A-Za-z0-9_-] 串换成 [sha256:NN]/[token:NN]），
// 因此任何含长标识符的原文我都拿不到字面量，直接以读到的文本做查找替换会把占位符写进源码。
// 本脚本逐个断言"锚点必须恰好命中 1 次"，任何一处对不上就整体放弃、不写文件。
import fs from 'node:fs';

const F = 'D:\\IDE\\dsh\\dsh-app\\src\\gateway\\model-gateway.mjs';
let src = fs.readFileSync(F, 'utf8');
const before = src;
const applied = [];
const failed = [];

/** 精确替换，断言命中次数 */
function sub(name, find, replace, expect = 1) {
  const n = src.split(find).length - 1;
  if (n !== expect) { failed.push(`${name}: 期望命中 ${expect} 次，实际 ${n}`); return; }
  src = src.split(find).join(replace);
  applied.push(name);
}
/** 正则替换（用于需要捕获组保留原文的场合） */
function subRe(name, re, replace, expect = 1) {
  const m = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  const n = m ? m.length : 0;
  if (n !== expect) { failed.push(`${name}: 正则期望命中 ${expect} 次，实际 ${n}`); return; }
  src = src.replace(re, replace);
  applied.push(name);
}

/* ==================== D5：思维链字段名兼容 ==================== */
// 旧实现只认 reasoning_content（DeepSeek 系）。OpenRouter 系（含 Cline）用 reasoning /
// reasoning_details —— 实测 Cline：delta.reasoning="The" + reasoning_details[{type:'reasoning.text',text:'The'}]。
// 只认一个字段名 → 思维链被**静默丢弃**（不报错、不告警）。
const REASONING_HELPER = `/**
 * 从上游的 delta / message 中提取推理（思维链）文本。
 * 2026-09-23（审计 D5 修复）：旧实现只认 \`reasoning_content\`（DeepSeek 系写法），而 OpenRouter
 * 系（含 Cline）用的是 \`reasoning\`（字符串或对象）与 \`reasoning_details\`
 *（\`[{type:'reasoning.text',text:'…'}]\`）。实测 Cline 的 SSE 分片同时带这两个字段且内容相同，
 * 因此**按优先级取第一个非空者**，不能相加（否则思维链会重复两遍）。
 * 只认一个字段名的后果是思维链被静默丢弃——客户端只看到最终答案，不报错也不告警，最难排查。
 * 返回 '' 表示本次分片不含推理内容。
 */
function reasoningTextOf(src) {
  if (!src || typeof src !== 'object') return '';
  if (typeof src.reasoning_content === 'string' && src.reasoning_content) return src.reasoning_content;
  if (typeof src.reasoning === 'string' && src.reasoning) return src.reasoning;
  if (src.reasoning && typeof src.reasoning === 'object' && !Array.isArray(src.reasoning)) {
    const t = src.reasoning.text !== undefined ? src.reasoning.text : src.reasoning.content;
    if (typeof t === 'string' && t) return t;
  }
  if (Array.isArray(src.reasoning_details)) {
    let out = '';
    for (const d of src.reasoning_details) {
      if (d && typeof d === 'object' && typeof d.text === 'string' && d.text) out += d.text;
    }
    return out;
  }
  return '';
}

`;

sub('D5-helper: 插入 reasoningTextOf（锚在 aggregateOpenAIStream 注释块）',
  `/**
 * OpenAI SSE → 单个 chat.completion（聚合）：用于"上游强制流式、而客户端要非流式"的直通路径。`,
  REASONING_HELPER + `/**
 * OpenAI SSE → 单个 chat.completion（聚合）：用于"上游强制流式、而客户端要非流式"的直通路径。`);

// ① 直通聚合路径：流式分片
sub('D5-1: aggregateOpenAIStream 认 reasoning / reasoning_details',
  `      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;`,
  `      reasoning += reasoningTextOf(d);   // D5：兼容 reasoning_content / reasoning / reasoning_details`);

// ② Anthropic 路径：非流式 message
sub('D5-2: openaiToAnthropicMessage 认 reasoning / reasoning_details',
  `  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: '' });
  }`,
  `  // D5：兼容 reasoning_content / reasoning / reasoning_details（旧实现只认第一个）
  const msgReasoning = reasoningTextOf(msg);
  if (msgReasoning) {
    content.push({ type: 'thinking', thinking: msgReasoning, signature: '' });
  }`);

// ③ Anthropic 路径：SSE 翻译
sub('D5-3: SSE 翻译认 reasoning / reasoning_details',
  `    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (openKind !== 'thinking') { closeBlock(); startBlock('thinking', { type: 'thinking', thinking: '' }); }
      outThinking += delta.reasoning_content;
      if (!aggregateOnly) {
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
      }
    }`,
  `    // D5：兼容 reasoning_content / reasoning / reasoning_details（旧实现只认第一个）
    const deltaReasoning = reasoningTextOf(delta);
    if (deltaReasoning) {
      if (openKind !== 'thinking') { closeBlock(); startBlock('thinking', { type: 'thinking', thinking: '' }); }
      outThinking += deltaReasoning;
      if (!aggregateOnly) {
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: deltaReasoning } });
      }
    }`);

/* ==================== D6：账户失败原因未脱敏（唯一裸输出点） ==================== */
sub('D6-1: markAccountFailure 的 reason 脱敏',
  `    reason: String(detail || kind).replace(/\\s+/g, ' ').slice(0, 120),`,
  `    // D6（安全）：必须过 maskSecrets —— 上游鉴权失败时回显收到的 Authorization 是常见实现，
    // 不过滤会让用户的统一网关 key 明文进 /health（免鉴权）与日志。这是同文件里唯一的裸输出点。
    reason: maskSecrets(String(detail || kind)).replace(/\\s+/g, ' ').slice(0, 120),`);

sub('D6-2: markAccountFailure 的日志脱敏',
  `  log(\`account \${providerId}#\${acct.id}\${scoped ? ' 模型 ' + model : ''} 标记为 \${kind}（冷却 \${Math.round(ms / 1000)}s）：\${String(detail || '').slice(0, 120)}\`);`,
  `  // D6（安全）：同上——日志与 /health 的 reason 是两个出口，都要脱敏
  log(\`account \${providerId}#\${acct.id}\${scoped ? ' 模型 ' + model : ''} 标记为 \${kind}（冷却 \${Math.round(ms / 1000)}s）：\${maskSecrets(String(detail || '')).slice(0, 120)}\`);`);

/* ==================== D13：accountPool 过期条目无回收 ==================== */
sub('D13: markAccountFailure 顺带回收已过期条目（防 /health 体单调增长）',
  `function markAccountFailure(providerId, acct, kind, detail, model) {
  const ms = kind === 'credit' ? ACCOUNT_CREDIT_COOLDOWN_MS`,
  `function markAccountFailure(providerId, acct, kind, detail, model) {
  // D13：账户池只在"标记失败"与"成功"时增删，冷却条目过期后**不会被删除**（coolEntryUsable 是懒判定），
  // 而键里含上游模型 ID（provider#acct@model）→ 多供应商×多账户×多模型的 429 只增不减，
  // 且这些孤儿条目会被 accountPoolSnapshot 全量列进 /health，响应体随时间单调膨胀。
  // 这里借"标记失败"这一低频时机顺带清理（无需定时器，也不影响正在冷却的条目）。
  if (accountPool.size > 64) {
    const now = Date.now();
    for (const [k, st] of accountPool) {
      if (st && st.state !== 'ok' && now >= st.until) accountPool.delete(k);
    }
  }
  const ms = kind === 'credit' ? ACCOUNT_CREDIT_COOLDOWN_MS`);

/* ==================== D9：translateBody 的密钥打码漏掉数组形态 content ==================== */
sub('D9: translateBody 处理数组形态 content（chat 路径此前不打码）',
  `      // 文本内容打码（content 为字符串时；跳过 tool_calls 参数与 tool 结果中的结构化值）
      if (typeof n.content === 'string') {
        const masked = maskSecretTokens(n.content);
        if (masked !== n.content) { n = { ...n, content: masked }; changed = true; }
      }
      return n;`,
  `      // 文本内容打码（跳过 tool_calls 参数与 tool 结果中的结构化值）
      // D9：旧实现只处理**字符串** content，而块数组（[{type:'text',text}]）完全不处理 ——
      // 同一份会话内容走 /v1/chat/completions（块格式）时不打码、走 /v1/messages 时打码，
      // 等于防泄露过滤在一个入口失效。与 handleMessages / translateResponsesBody 对齐。
      if (typeof n.content === 'string') {
        const masked = maskSecretTokens(n.content);
        if (masked !== n.content) { n = { ...n, content: masked }; changed = true; }
      } else if (Array.isArray(n.content)) {
        let blocksChanged = false;
        const blocks = n.content.map((b) => {
          if (b && typeof b === 'object' && typeof b.text === 'string') {
            const masked = maskSecretTokens(b.text);
            if (masked !== b.text) { blocksChanged = true; return { ...b, text: masked }; }
          }
          return b;
        });
        if (blocksChanged) { n = { ...n, content: blocks }; changed = true; }
      }
      return n;`);

/* ==================== D1：半开探测名额泄漏 + 时间兜底 ==================== */
sub('D1-a: 新增 BREAKER_STALE_MS 常量（锚在熔断状态机注释块，避开含长标识符的行）',
  `/* 熔断状态机（审计修复 P2，本次）：closed / open / half-open`,
  `/* 2026-09-23（审计 D1 修复）：半开探测名额的**兜底回收期**。
 * half-open 是"单飞"状态——占了名额的那个请求必须最终调用 breakerRecordFail 或
 * breakerRecordSuccess 之一才会释放。审计确认 forward() 里存在**漏释放的 early return**
 *（账户级失败交回账户池那一支）。一旦命中，该家就永久卡在 half-open：breakerIsOpen() 对任何
 * 请求都返回 true → 该家再也不会被选中，直到进程重启，而日志里只有满屏 \`skip X (breaker …)\`，
 * 用户完全无从判断。现在给 half-open 加时间兜底：超期仍未结算的探测名额视为"遗弃"，
 * 允许重新占用。这条兜底不依赖"把所有 return 都改对"——即使将来又漏一处也不会永久卡死。
 *（env 名刻意取短，避免自身被降敏成占位符而无法在源码里检索。） */
const BREAKER_STALE_MS = envMs('DSH_GW_BREAKER_STALE_MS', 180_000);

/* 熔断状态机（审计修复 P2，本次）：closed / open / half-open`);

sub('D1-b: breakerIsOpen 识别"遗弃的半开名额"',
  `  if (b.state === 'half-open') return true;                  // 已有探测在途 → 其它并发请求跳过`,
  `  // D1：半开名额若已被占用且超过兜底期仍未结算 → 视为遗弃，放行新探测（否则永久卡死）
  if (b.state === 'half-open') return !probeSlotStale(b);    // 已有探测在途 → 其它并发请求跳过`);

sub('D1-c: breakerAcquire 记录探测开始时间 + 允许回收遗弃名额',
  `  if (b.state === 'half-open') return false;                 // 单飞：探测名额已被占
  if (Date.now() < b.openUntil) return false;                // 冷却未到点（并发窗口内）
  b.state = 'half-open';
  b.fails = BREAKER_THRESHOLD - 1;                           // 探测失败 → 立刻回到 open
  breaker.set(providerId, b);
  log(\`breaker HALF-OPEN: \${providerId} 冷却到点，放行一次探测（single-flight）\`);`,
  `  // D1：单飞——但"遗弃名额"（超过 BREAKER_STALE_MS 未结算）允许被回收，否则该家永久失联
  if (b.state === 'half-open' && !probeSlotStale(b)) return false;
  if (b.state !== 'half-open' && Date.now() < b.openUntil) return false;   // 冷却未到点（并发窗口内）
  if (b.state === 'half-open') {
    log(\`breaker HALF-OPEN: \${providerId} 上一个探测名额已超期（\${Math.round(BREAKER_STALE_MS / 1000)}s）未结算，回收后重新放行\`);
  }
  b.state = 'half-open';
  b.probeAt = Date.now();                                    // D1：结算兜底的时间基准
  b.fails = BREAKER_THRESHOLD - 1;                           // 探测失败 → 立刻回到 open
  breaker.set(providerId, b);
  log(\`breaker HALF-OPEN: \${providerId} 冷却到点，放行一次探测（single-flight）\`);`);

sub('D1-d: 新增 probeSlotStale 辅助函数',
  `/** 纯读：该 provider 当前是否不可用（冷却窗口内，或半开探测名额已被别的请求占用）。 */`,
  `/** D1：半开探测名额是否已被"遗弃"（占用超过兜底期仍未调用 recordFail/recordSuccess）。纯读。 */
function probeSlotStale(b) {
  if (!b || b.state !== 'half-open') return false;
  return !!b.probeAt && (Date.now() - b.probeAt) > BREAKER_STALE_MS;
}

/** 纯读：该 provider 当前是否不可用（冷却窗口内，或半开探测名额已被别的请求占用）。 */`);

// 账户级失败那一支：交回账户池前必须释放半开名额
sub('D1-e: forward() 账户级失败分支释放半开名额（原泄漏点）',
  `      if (acctKind) {
        log(\`upstream \${provider.id} HTTP \${upstream.status} 判定为账户级失败（\${acctKind}）→ 交回账户池处理（不计供应商熔断）\`);
        return rawMode ? { retryable: upstream.status } : false;
      }`,
  `      if (acctKind) {
        log(\`upstream \${provider.id} HTTP \${upstream.status} 判定为账户级失败（\${acctKind}）→ 交回账户池处理（不计供应商熔断）\`);
        // D1（审计修复）：账户级失败说明"这家上游是健康的、只是这个账户不行"，**不计供应商失败**，
        // 因此必须把刚占用的半开探测名额交还。旧实现直接 return 不释放 → 该家永久卡在
        // half-open（breakerIsOpen 恒真）再也不会被选中，直到进程重启。
        breakerRecordSuccess(provider.id);
        return rawMode ? { retryable: upstream.status } : false;
      }`);

/* ==================== D2：200 + 错误 SSE 无法熔断 ==================== */
sub('D2-a: 移除 SSE 偷看**之前**的成功清零（否则 fails 恒为 1，永不开闸）',
  `  breakerRecordSuccess(provider.id);   // V1：成功清零熔断计数
  let bodyStream = upstream.body;`,
  `  // D2（审计修复）：成功清零**移到 SSE 首事件偷看之后**。
  // 旧实现在此处（2xx 即清零）就删掉熔断条目，而"200 + 首事件是错误"的判定在其后 ——
  // 于是那条路径上的 breakerRecordFail 用 breaker.get(id) || {fails:0} 取到**全新**条目，
  // fails 恒为 1、state 恒为 'closed' → \`fails >= 3\` 永不成立 → **熔断器完全失效**。
  // 对恒回 200 + event:error 的上游（实测 api.chiyi.cc 形态），每个请求都白打一轮上游
  //（延迟 + 计费），设计意图（连续 3 次即退避保护账号）完全落空。
  let bodyStream = upstream.body;`);

sub('D2-b: 在偷看块之后记录成功',
  `  // 上游被强制流式、而客户端要非流式 → 聚合后回单条 JSON（2026-09-16：直通路径补齐 quirk 语义）
  if (needAggregate && bodyStream && /event-stream/i.test(ctype)) {`,
  `  // D2（审计修复）：到这里才确认"上游确实给出了正常事件"（用了流式则已通过首事件偷看），
  // 此时清零熔断计数才是诚实的；提前到 2xx 处会让"200 + 错误 SSE"永远无法熔断。
  breakerRecordSuccess(provider.id);
  // 上游被强制流式、而客户端要非流式 → 聚合后回单条 JSON（2026-09-16：直通路径补齐 quirk 语义）
  if (needAggregate && bodyStream && /event-stream/i.test(ctype)) {`);

/* ==================== D4：账户池耗尽却记供应商级熔断（自相矛盾） ==================== */
sub('D4: 全部账户因账户级原因失败时，不得记供应商级熔断',
  `  // 所有账户都不行：把最后一次的失败按供应商级处理
  log(\`provider \${provider.id} 全部账户不可用（最后 HTTP \${lastStatus}）：\${maskSecrets(lastDetail).slice(0, 160)}\`);
  if (lastStatus === 401 || lastStatus === 403 || lastStatus === 429 || lastStatus >= 500) {
    catalogCache.set(provider.id, { models: null, ts: Date.now(), failed: true });
    breakerRecordFail(provider.id, lastStatus);
  }
  return false;`,
  `  // 所有账户都不行。
  // D4（审计修复）：能走到这里的只有两条路径 —— 账户级失败（classifyAccountFailure 命中后 continue）
  // 与凭据不可用（continue）。两者都是**账户**问题、不是供应商问题，而旧实现却在这里记
  // **供应商级**熔断（与 :2536 注释宣称的"账户级失败不计供应商熔断"直接矛盾）：后果是该家被
  // 熔断 30 分钟，等账户冷却结束也回不来，账户池等于被自己废掉。
  // 另：凭据不可用路径**不赋值 lastStatus**（保持 0），旧实现判 false 后同样滞留。
  // 现在：交还半开探测名额、不记供应商失败，把"这家的账户暂时都不可用"如实交给下一家。
  log(\`provider \${provider.id} 全部账户不可用（最后 HTTP \${lastStatus}）：\${maskSecrets(lastDetail).slice(0, 160)}\`);
  breakerRecordSuccess(provider.id);
  log(\`provider \${provider.id} 的失败均为账户级/凭据级 → 不计供应商熔断（账户冷却结束后自动恢复）\`);
  return false;`);

/* ==================== D7：/v1/responses 路径 quirks 失效 ==================== */
sub('D7-a: applyOpenAIQuirks 支持 Responses 语义',
  `function applyOpenAIQuirks(body, provider) {`,
  `function applyOpenAIQuirks(body, provider, opts) {
  const responsesMode = !!(opts && opts.responses);`);

sub('D7-b: quirks 门控纳入 responsesMode',
  `    if (!rawMode && !isAnthropicPath && !responsesMode) {
      const q = applyOpenAIQuirks(outBody, provider);`,
  `    // D7（审计修复）：旧门控 \`&& !responsesMode\` 让 /v1/responses 的 quirks **全部失效**
    //（stringify-tool-choice 失效 → 上游 400；实测该 quirk 就是为这个 400 加的）。
    // 现在纳入 Responses：其中 force-stream 需要 Responses 形状的聚合，暂不在该路径启用
    //（由 applyOpenAIQuirks 内部跳过），避免回错响应形状。
    if (!rawMode && !isAnthropicPath) {
      const q = applyOpenAIQuirks(outBody, provider, { responses: responsesMode });`);

sub('D7-c: force-stream 在 Responses 路径跳过（避免响应形状错误）',
  `  let needAggregate = false;
  if (quirks.has('force-stream') && out.stream !== true) {`,
  `  let needAggregate = false;
  // D7：Responses 协议的流式聚合会产出 chat.completion 形状（错），故该路径不用 force-stream；
  // stringify-tool-choice 是纯请求侧改写，对 Responses 同样安全有效，照常生效。
  if (!responsesMode && quirks.has('force-stream') && out.stream !== true) {`);

/* ==================== D10：SSE 转发无背压 ==================== */
sub('D10: 尊重 res.write 返回值，等待 drain（把背压传回上游）',
  `        try {
          res.write(Buffer.from(value));
        } catch (writeErr) {`,
  `        try {
          // D10（审计修复）：write 返回 false = 下游内部缓冲已满（慢客户端 + 快上游）。
          // 旧实现丢弃返回值继续读上游 → 缓冲无上限增长（网关内存暴涨直至 OOM）。
          // 现在等待 drain 或客户端断开后再继续读，把背压如实传回上游。
          if (res.write(Buffer.from(value)) === false) {
            await new Promise((resolve) => {
              const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
              res.once('drain', done);
              res.once('close', done);
            });
          }
        } catch (writeErr) {`);

/* ==================== D11：readTextWithTimeout 读完才截断 ==================== */
sub('D11: 边读边截断（旧实现先读完整响应体再 slice，上限形同虚设）',
  `    const bodyPromise = resp.text().then((t) => String(t).slice(0, limit));`,
  `    // D11（审计修复）：改为**边读边截断**。旧实现 \`resp.text().then(t => t.slice(0, limit))\`
    // 是"读完整个响应体再截断"——limit=500 时仍可能先把数十 MB 读进内存（Buffer + String 双份峰值），
    // 调用点之一更是 limit=4MB。触发极简：上游回一个超大 JSON 体即可。现在读满 limit 即停并取消。
    const bodyPromise = (async () => {
      const reader = (resp.body && typeof resp.body.getReader === 'function') ? resp.body.getReader() : null;
      if (!reader) return String(await resp.text()).slice(0, limit);
      const chunks = [];
      let total = 0;
      try {
        while (total < limit) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          chunks.push(buf);
          total += buf.length;
        }
      } finally {
        try { await reader.cancel(); } catch { /* 已读完或已取消 */ }
      }
      return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
    })();`);

/* ==================== 需求 2：Cline 客户端仿真 ==================== */
sub('需求2-a: 新增 clineClientHeaders()',
  `// V2 防屏蔽：Codex 客户端完全仿真（OpenAI 系特征，供 new-api/one-api 白名单识别为 Codex）`,
  `// 2026-09-23：Cline 客户端完全仿真（实测收敛版）。
// 上游 api.cline.bot 只对"Cline 产品面"开放：**完全裸头**会被拒
//   403 {"code":"API_REQUEST_ERROR_CODE","message":"Error 403: <model> is only available via Cline product surfaces…"}
// 实测最小充分集是单个 X-CLIENT-TYPE: cline-sdk（仅它即可 200）；UA 内容不校验但**存在性必需**
//（只有 UA 没有 X-CLIENT-TYPE 仍 403）；版本号不是硬门禁（0.0.1 也能过）。
// 这里照全量发送，与 Cline 官方 SDK 形态一致，最稳。
function clineClientHeaders() {
  return {
    'user-agent': 'Cline/3.0.47',
    'http-referer': 'https://cline.bot',
    'x-title': 'Cline',
    'x-is-multiroot': 'false',
    'x-client-type': 'cline-sdk',
    'x-client-version': '3.0.47',
    'x-platform': 'terminal',
    'x-platform-version': '3.0.47',
    'x-core-version': '0.0.66',
    accept: 'application/json, text/event-stream',
  };
}

// V2 防屏蔽：Codex 客户端完全仿真（OpenAI 系特征，供 new-api/one-api 白名单识别为 Codex）`);

sub('需求2-b: upstreamRequestHeaders 增加 cline 分支',
  `  if (clientProfile === 'codex') {
    // Codex 完全仿真（V2）：不透传任何 dsh 头
    Object.assign(out, codexClientHeaders());`,
  `  if (clientProfile === 'cline') {
    // Cline 完全仿真（2026-09-23）：不透传任何 dsh 头；clientUA 仍允许覆盖具体 UA 值
    Object.assign(out, clineClientHeaders());
    if (clientUA) out['user-agent'] = clientUA;
  } else if (clientProfile === 'codex') {
    // Codex 完全仿真（V2）：不透传任何 dsh 头
    Object.assign(out, codexClientHeaders());`);

sub('需求2-c: 新增 providerClientProfile（按上游主机自动推断 cline 仿真）',
  `/** 构造发往上游的最终请求头。
 * clientProfile='codex' → Codex 完全仿真（不留任何客户端透传痕迹）`,
  `/**
 * 该供应商实际应使用的客户端仿真档（2026-09-23，需求："cline 调用时默认使用 cline 客户端仿真"）。
 *  ① 供应商显式声明 \`clientProfile\` → 用它（可逐家覆盖，如同时接 Cline 与 new-api）；
 *  ② 否则按 baseURL 主机推断：*.cline.bot 只认 Cline 产品面，自动套用 cline 仿真，
 *     用户无需在每家的 headers 里手抄那 9 个头；
 *  ③ 都没有 → 返回 ''（由调用方回落到全局 cfg.clientProfile，保持既有行为不变）。
 * 刻意不改全局 clientProfile 的语义：它是**下行协议**与**上行仿真**的双重开关
 *（见 writeDshConfig），全局改成 cline 会连带把 dsh 的 api 改成 openai-completions。
 */
function providerClientProfile(provider) {
  const declared = String((provider && provider.clientProfile) || '').trim().toLowerCase();
  if (declared) return declared;
  try {
    const host = new URL(String((provider && provider.baseURL) || '')).hostname.toLowerCase();
    if (host === 'api.cline.bot' || host.endsWith('.cline.bot')) return 'cline';
  } catch { /* baseURL 非法：不推断 */ }
  return '';
}

/** 构造发往上游的最终请求头。
 * clientProfile='cline'  → Cline 完全仿真（api.cline.bot 的硬性要求）
 * clientProfile='codex' → Codex 完全仿真（不留任何客户端透传痕迹）`);

sub('需求2-d: 新增 effectiveClientProfile（逐家优先，回落全局）',
  `function passthroughHeaders(reqHeaders, apiKey, clientUA, clientProfile) {
  return upstreamRequestHeaders(reqHeaders, apiKey, clientUA, false, clientProfile);
}`,
  `function passthroughHeaders(reqHeaders, apiKey, clientUA, clientProfile) {
  return upstreamRequestHeaders(reqHeaders, apiKey, clientUA, false, clientProfile);
}

/** 逐家仿真档优先于全局档（providerClientProfile 为空时回落 cfg.clientProfile，行为不变）。 */
function effectiveClientProfile(cfg, provider) {
  return providerClientProfile(provider) || String((cfg && cfg.clientProfile) || '').trim();
}`);

// 把各调用点从 cfg.clientProfile 切到 effectiveClientProfile(cfg, p)
subRe('需求2-e: 调用点改用 effectiveClientProfile',
  /cfg\.clientUA, cfg\.clientProfile\)/g,
  `cfg.clientUA, effectiveClientProfile(cfg, p))`,
  5);
sub('需求2-f: /v1/messages 翻译路径的调用点',
  `    const baseHeaders = upstreamRequestHeaders(req.headers, p.apiKey, cfg.clientUA, !toOpenAI, cfg.clientProfile);`,
  `    const baseHeaders = upstreamRequestHeaders(req.headers, p.apiKey, cfg.clientUA, !toOpenAI, effectiveClientProfile(cfg, p));`);

/* ==================== 写盘 ==================== */
if (failed.length) {
  console.error('=== 补丁中止：以下锚点未按预期命中（未写入任何内容）===');
  for (const f of failed) console.error('  ✗ ' + f);
  console.error('\n已成功匹配但因中止未写入: ' + applied.length + ' 处');
  process.exit(1);
}
if (src === before) { console.error('=== 无任何变更 ==='); process.exit(1) }
fs.writeFileSync(F, src, 'utf8');
console.log('=== 补丁已写入 ===');
for (const a of applied) console.log('  ✓ ' + a);
console.log(`\n共 ${applied.length} 处；文件 ${before.length} → ${src.length} 字符`);
