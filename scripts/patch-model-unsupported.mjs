// 修复（2026-09-23）：上游明确说"我没有这个模型"时，应**继续 failover**，而不是终止。
//
// 现场证据（UAT 日志 17:00:41）：
//   upstream amd HTTP 400: {"...","message":"Requested model DeepSeek-V4.1-Flash not supported"}
//   upstream amd 确定性 4xx HTTP 400 → 终止 failover（回 400）
//   failover stopped (deepseek-v4.1-flash via amd HTTP 400 → 400, anthropic)
// 而同一逻辑模型在 workbuddy/cline 上可用 ⇒ 用户本该拿到回答，却拿到 400。
//
// 语义区分（关键）：
//   · "请求本身有错"（参数非法/体积超限）→ 换家重发只是 N 倍计费 ⇒ 终止（既有设计，保留）
//   · "**这家**没有这个模型" → 供应商侧问题，换家有意义 ⇒ 继续 failover（本次修复）
// 后者与既有的 PROVIDER_SIDE_4XX_RE（余额/额度/权限）同类，但**不熔断该家**
//（熔断器是按供应商的：该家对别的模型完全正常，熔断会连坐整家）。
import fs from 'node:fs';

const F = 'D:\\IDE\\dsh\\dsh-app\\src\\gateway\\model-gateway.mjs';
let src = fs.readFileSync(F, 'utf8');
const before = src.length;
const applied = [], failed = [];

function sub(name, find, replace, expect = 1) {
  const n = src.split(find).length - 1;
  if (n !== expect) { failed.push(`${name}: 期望 ${expect} 次，实际 ${n}`); return }
  src = src.split(find).join(replace);
  applied.push(name);
}

/* ① 定义"这家没有这个模型"的识别正则（锚在 MODEL_MISSING_RE 之后，避免碰长标识符） */
sub('① 新增 MODEL_UNSUPPORTED_BY_PROVIDER_RE',
  `const DETERMINISTIC_4XX_STATUS = { 400: 400, 404: 404, 413: 413, 422: 422 };`,
  `/**
 * 「**这家**没有这个模型」——与"请求本身有错"必须区分开（2026-09-23 实测事故）。
 * 现场：amd 回 400 \`Requested model DeepSeek-V4.1-Flash not supported\`，旧实现把它当确定性
 * 4xx **终止 failover**，用户直接拿到 400 —— 而同一逻辑模型在 workbuddy/cline 上完全可用。
 * 判据（都取自实测形态，措辞会变，故覆盖多种）：
 *   · "Requested model X not supported"        （amd，400；注意是 not supported 不是 unsupported）
 *   · "Model X is not available" / model_not_found（amd，404）
 *   · "unsupported model" / "model not offered" / "does not offer this model"
 * 只用于**继续 failover**，不用于判定"整个请求无解"。
 */
const MODEL_UNSUPPORTED_BY_PROVIDER_RE = /requested\\s+model[^.\\n]{0,60}not\\s+supported|model[^.\\n]{0,40}is\\s+not\\s+available|model_not_found|unsupported\\s+model|model\\s+not\\s+(?:offered|supported)|does\\s+not\\s+(?:offer|support)[^.\\n]{0,24}model|不提供[^。\\n]{0,12}模型|模型[^。\\n]{0,12}不支持/i;

const DETERMINISTIC_4XX_STATUS = { 400: 400, 404: 404, 413: 413, 422: 422 };`);

/* ② 直通路径（forward()）：这家没有该模型 → 继续 failover */
// 用前文的 `persistent ? 403 : 0` 唯一标识这一处（翻译路径那处用的是 lastDetail）
sub('② 直通路径：这家没有该模型 → 继续 failover（不熔断该家）',
  `        breakerRecordFail(provider.id, persistent ? 403 : 0);   // 403 → 长熔断（30 分钟）；0 → 短熔断
        return rawMode ? { retryable: upstream.status } : false;
      }
      const status = DETERMINISTIC_4XX_STATUS[upstream.status] || 400;
      log(\`upstream \${provider.id} 确定性 4xx HTTP \${upstream.status} → 终止 failover（回 \${status}，不回显上游原文）\`);
      return { stop: { status, upstreamStatus: upstream.status } };`,
  `        breakerRecordFail(provider.id, persistent ? 403 : 0);   // 403 → 长熔断（30 分钟）；0 → 短熔断
        return rawMode ? { retryable: upstream.status } : false;
      }
      // 2026-09-23 修复：**这家没有这个模型**不是"请求本身有错" —— 换下一家有意义，
      // 必须继续 failover（旧实现归入下面的"确定性 4xx"而终止，用户拿到 400 而非可用的下一家）。
      // 实测事故：amd 回 400 "Requested model DeepSeek-V4.1-Flash not supported"，
      // 而同一逻辑模型在 workbuddy/cline 上都可用，用户却直接拿到 400。
      // 刻意**不调 breakerRecordFail**：熔断器是按供应商粒度，该家对别的模型完全正常，
      // 记失败会连坐整家（正是上方 :2536 注释所警告的情形）。半开名额已在上方交还。
      if (MODEL_UNSUPPORTED_BY_PROVIDER_RE.test(detail)) {
        log(\`upstream \${provider.id} HTTP \${upstream.status} 判定为"这家没有该模型" → 继续 failover\`
          + \`（不熔断该家；若长期如此，请从配置的 models 里移除该映射）\`);
        return rawMode ? { retryable: upstream.status } : false;
      }
      const status = DETERMINISTIC_4XX_STATUS[upstream.status] || 400;
      log(\`upstream \${provider.id} 确定性 4xx HTTP \${upstream.status} → 终止 failover（回 \${status}，不回显上游原文）\`);
      return { stop: { status, upstreamStatus: upstream.status } };`);

/* ③ Anthropic→OpenAI 翻译路径：同样处理（那处用的是 lastDetail） */
sub('③ 翻译路径：同样继续 failover',
  `        breakerRecordFail(provider.id, PERSISTENT_ACCOUNT_RE.test(lastDetail) ? 403 : 0);
        return false;
      }
      const status = DETERMINISTIC_4XX_STATUS[upstream.status] || 400;
      log(\`upstream \${provider.id} 确定性 4xx HTTP \${upstream.status} → 终止 failover（回 \${status}，不回显上游原文）\`);
      return { stop: { status, upstreamStatus: upstream.status } };`,
  `        breakerRecordFail(provider.id, PERSISTENT_ACCOUNT_RE.test(lastDetail) ? 403 : 0);
        return false;
      }
      // 2026-09-23 修复：与直通路径同规则 —— "这家没有该模型"应继续 failover，不终止
      if (MODEL_UNSUPPORTED_BY_PROVIDER_RE.test(lastDetail)) {
        log(\`upstream \${provider.id} HTTP \${upstream.status} 判定为"这家没有该模型" → 继续 failover（不熔断该家）\`);
        return false;
      }
      const status = DETERMINISTIC_4XX_STATUS[upstream.status] || 400;
      log(\`upstream \${provider.id} 确定性 4xx HTTP \${upstream.status} → 终止 failover（回 \${status}，不回显上游原文）\`);
      return { stop: { status, upstreamStatus: upstream.status } };`);

if (failed.length) {
  console.error('=== 补丁中止（未写入）===');
  for (const f of failed) console.error('  ✗ ' + f);
  console.error(`（已匹配 ${applied.length} 处）`);
  process.exit(1);
}
fs.writeFileSync(F, src, 'utf8');
console.log('=== 补丁已写入 ===');
for (const a of applied) console.log('  ✓ ' + a);
console.log(`\n共 ${applied.length} 处；文件 ${before} → ${src.length} 字符`);
