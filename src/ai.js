import { safeJsonParse } from './utils.js';
import { currentSourcePredicate } from './source-health.js';

function balancedJsonObject(text) {
  const source = String(text || '');
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractJson(text) {
  if (!text) return null;
  const source = String(text).trim();
  const direct = safeJsonParse(source, null);
  if (direct) return direct;
  const unfenced = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const unfencedDirect = safeJsonParse(unfenced, null);
  if (unfencedDirect) return unfencedDirect;
  const candidate = balancedJsonObject(unfenced);
  return candidate ? safeJsonParse(candidate, null) : null;
}

function extractModelPayload(out) {
  const candidates = [out?.response, out?.result?.response, out?.choices?.[0]?.message?.content];
  for (const value of candidates) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return { parsed: value, rawText: JSON.stringify(value) };
    if (String(value || '').trim()) {
      const rawText = String(value);
      return { parsed: extractJson(rawText), rawText };
    }
  }
  return { parsed: null, rawText: '' };
}

function hasLowValuePhrase(text) {
  return /值得关注|热度较高|持续升温|具有重要意义|前景广阔|机会巨大/.test(String(text || ''));
}

function comparableText(text) {
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function isTitleEcho(summary, topicTitle) {
  const normalizedSummary = comparableText(summary);
  const normalizedTitle = comparableText(topicTitle);
  if (!normalizedTitle || !normalizedSummary.includes(normalizedTitle)) return false;
  if (normalizedSummary === normalizedTitle) return true;
  const novel = normalizedSummary.split(normalizedTitle).join('');
  return novel.length < 12;
}

function sanitizeErrorDetail(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\bauthorization\s*[:=]?\s*(?:bearer\s+)?[^\s,;]+/gi, 'authorization=[redacted]')
    .replace(/\b(?:bearer|token|api[_-]?key)\s*[:=]?\s*[^\s,;]+/gi, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferenceErrorMessages(err) {
  const values = [
    err?.message,
    err?.cause?.message,
    err?.error?.message,
    err?.error,
    err?.data?.message,
    err?.data?.error?.message,
    err?.response?.error?.message,
    err?.response?.error
  ];
  const seen = new Set();
  const messages = [];
  for (const value of values) {
    if (value == null) continue;
    const text = sanitizeErrorDetail(typeof value === 'object' ? value?.message || '' : value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    messages.push(text);
  }
  if (!messages.length) {
    const fallback = sanitizeErrorDetail(err);
    if (fallback && fallback !== '[object Object]') messages.push(fallback);
  }
  return messages;
}

function errorDetailSlug(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const detail = String(message || '')
      .toLowerCase()
      .replace(/\b(?:error|aierror)\b/g, ' ')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 72);
    if (detail) return detail;
  }
  return null;
}

function formatInferenceError(err) {
  const payload = {
    name: sanitizeErrorDetail(err?.name || '') || null,
    code: sanitizeErrorDetail(err?.code || '') || null,
    status: sanitizeErrorDetail(err?.status || '') || null,
    messages: inferenceErrorMessages(err).slice(0, 3)
  };
  return JSON.stringify(payload).slice(0, 600);
}

function classifyInferenceError(err, prefix = 'inference-error') {
  const rawCode = String(err?.code || err?.status || err?.name || '').trim();
  const messages = inferenceErrorMessages(err);
  const message = messages.join(' ').toLowerCase();
  let kind = 'unknown';
  if (/rate.?limit|too many requests|429/.test(message) || rawCode === '429') kind = 'rate-limit';
  else if (/quota|limit exceeded|capacity|used up.*(?:daily|free).*allocation|daily free allocation|neurons/.test(message)) kind = 'quota-or-capacity';
  else if (/unauthori[sz]ed|forbidden|permission|authentication|401|403/.test(message) || ['401', '403'].includes(rawCode)) kind = 'auth-or-permission';
  else if (/model.*not found|unknown model|does not exist|404/.test(message) || rawCode === '404') kind = 'model-not-found';
  else if (/timeout|timed out|deadline|abort/.test(message)) kind = 'timeout';
  else if (/invalid.*request|bad request|schema|response_format|json_schema|400/.test(message) || rawCode === '400') kind = 'invalid-request';
  else if (/internal|upstream|gateway|service unavailable|502|503|504/.test(message) || ['502', '503', '504'].includes(rawCode)) kind = 'upstream';
  const code = rawCode && rawCode !== 'Error' ? rawCode.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) : null;
  const genericCode = !code || /^(?:AiError|Error)$/i.test(code);
  const detail = genericCode && ['invalid-request', 'unknown'].includes(kind) ? errorDetailSlug(messages) : null;
  return `${prefix}:${kind}${code ? `:${code}` : ''}${detail ? `:${detail}` : ''}`;
}

function isRecoverableInferenceFailure(reason) {
  return /^inference-error:(rate-limit|model-not-found|timeout|upstream|unknown)(?::|$)/.test(String(reason || ''));
}

const OPPORTUNITY_TYPES = new Set(['内容', '工具', '服务', '电商', '投资观察', '风险管理观察', '观察']);

function evidenceCorpus(topic = {}, evidence = []) {
  const rawSignals = Array.isArray(topic.raw_signals) ? topic.raw_signals : [];
  const rawText = typeof topic.raw_evidence_text === 'string' ? topic.raw_evidence_text : '';
  return [
    topic.canonical_title, topic.category, topic.current_score, topic.breakout_score,
    topic.source_count, topic.mention_count, rawText,
    ...rawSignals.map(signal => JSON.stringify(signal)),
    ...(Array.isArray(evidence) ? evidence : []).map(item => JSON.stringify(item))
  ].filter(value => value !== null && value !== undefined).join(' ');
}

function numericClaims(text) {
  return [...String(text || '').matchAll(/\d{2,}/g)].map(match => match[0]);
}

export function validateAIEvidenceClaims(analysis, topic = {}, evidence = []) {
  const corpus = evidenceCorpus(topic, evidence);
  const text = [analysis?.summary, analysis?.why_now, analysis?.risks,
    ...(Array.isArray(analysis?.opportunities) ? analysis.opportunities.flatMap(item => [item?.idea, item?.rationale]) : [])]
    .filter(Boolean).join(' ');
  const unsupported = [...new Set(numericClaims(text).filter(number => !corpus.includes(number)))];
  if (unsupported.length) return `unsupported-evidence-number:${unsupported.slice(0, 3).join(',')}`;
  const invalidType = (analysis?.opportunities || []).find(item => {
    const type = String(item?.type || '').trim();
    return type && !OPPORTUNITY_TYPES.has(type);
  });
  if (invalidType) return 'invalid-opportunity-type';
  return null;
}

export function isStoredAIValid(topic) {
  if (!topic) return false;
  const summary = String(topic.ai_summary || '').trim();
  const whyNow = String(topic.ai_why_now || '').trim();
  const opportunities = safeJsonParse(topic.ai_opportunities_json, []);
  if (summary.length < 20 || whyNow.length < 20) return false;
  if (!Array.isArray(opportunities) || opportunities.length < 1) return false;
  if (hasLowValuePhrase(summary) || hasLowValuePhrase(whyNow)) return false;
  if (!opportunities.every(o => String(o?.idea || '').trim() && String(o?.rationale || '').trim())) return false;
  return !validateAIEvidenceClaims({ summary, why_now: whyNow, risks: topic.ai_risks, opportunities }, topic, topic.raw_signals || []);
}

export function isStoredAIUsable(topic, maxAgeHours = 6, now = Date.now()) {
  if (!isStoredAIValid(topic)) return false;
  const updatedAt = Date.parse(topic.ai_updated_at || '');
  if (!Number.isFinite(updatedAt)) return false;
  const ageMs = now - updatedAt;
  const maxAgeMs = Math.max(1, Number(maxAgeHours || 6)) * 3600000;
  return ageMs >= -5 * 60 * 1000 && ageMs <= maxAgeMs;
}

export function hasCurrentEvidence(topic, evidence = []) {
  const expectedSources = Math.max(1, Number(topic?.source_count || 1));
  const sourceIds = new Set((Array.isArray(evidence) ? evidence : [])
    .map(item => String(item?.source_id || '').trim())
    .filter(Boolean));
  return sourceIds.size >= expectedSources;
}

function normalizeAnalysis(parsed, model, topicTitle, topic, evidence) {
  if (!parsed || typeof parsed !== 'object') return { analysis: null, failureReason: 'invalid-json' };
  const summary = String(parsed.summary || '').trim();
  const whyNow = String(parsed.why_now || '').trim();
  const risks = String(parsed.risks || '').trim();
  const opportunities = Array.isArray(parsed.opportunities)
    ? parsed.opportunities.slice(0, 3).map(o => ({
        ...o,
        idea: String(o?.idea || '').trim(),
        rationale: String(o?.rationale || '').trim(),
        ai_generated: true,
        ai_model: model
      })).filter(o => o.idea && o.rationale)
    : [];
  if (!summary || !whyNow || opportunities.length < 1) return { analysis: null, failureReason: 'incomplete-output' };
  if (isTitleEcho(summary, topicTitle)) return { analysis: null, failureReason: 'title-echo' };
  if (summary.length < 20 || whyNow.length < 20) return { analysis: null, failureReason: 'too-short' };
  if (hasLowValuePhrase(summary) || hasLowValuePhrase(whyNow)) return { analysis: null, failureReason: 'low-value-language' };
  const evidenceFailure = validateAIEvidenceClaims({ summary, why_now: whyNow, risks, opportunities }, topic, evidence);
  if (evidenceFailure) return { analysis: null, failureReason: evidenceFailure };
  return { analysis: { summary, why_now: whyNow, opportunities, risks }, failureReason: null };
}

const AI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    why_now: { type: 'string' },
    opportunities: {
      type: 'array', minItems: 1, maxItems: 3,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...OPPORTUNITY_TYPES] }, idea: { type: 'string' }, rationale: { type: 'string' },
          difficulty: { type: 'string' }, time_to_market: { type: 'string' }, confidence: { type: 'number' }
        },
        required: ['idea', 'rationale']
      }
    },
    risks: { type: 'string' }
  },
  required: ['summary', 'why_now', 'opportunities', 'risks']
};

const JSON_MODE_MODELS = new Set([
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.1-70b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3-8b-instruct',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@hf/nousresearch/hermes-2-pro-mistral-7b',
  '@hf/thebloke/deepseek-coder-6.7b-instruct-awq',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'
]);

const FALLBACK_REASONS = new Set(['invalid-json', 'incomplete-output', 'too-short', 'low-value-language', 'title-echo', 'empty-model-response', 'invalid-opportunity-type']);

function buildPrompt(topic, evidence) {
  return `你是互联网趋势分析师和产品机会研究员。基于真实证据分析热点。
不要复述标题，不要写新闻摘要模板，不要把热度等同于商业价值。
summary 即使提到主题，也必须补充至少一个证据支持的新事实、状态变化或因果信息，不能只把标题换一种说法。

主题：${topic.canonical_title}
分类：${topic.category}
趋势指数（派生指标，不是平台原始热度）：${topic.current_score}
突破指数：${topic.breakout_score}
来源数：${topic.source_count}
证据：${evidence.map(x => `${x.source_id} #${x.rank || '-'} ${x.title}；source_kind=${x.source_kind || '未声明'}；原始 heat=${x.raw_heat ?? '未提供'}；engagement=${x.raw_engagement ?? '未提供'}；实际字段=${x.heat_metric_path || '未记录'} / ${x.engagement_metric_path || '未记录'}；指标定义=${x.metric_definition || '未声明'}；upstream=${x.upstream || '未记录'}；采集时间=${x.captured_at || '-'}`).join('\n')}

只输出 JSON：
{"summary":"发生了什么，说明事件本质而不是标题改写","why_now":"为什么现在发生，引用可观察信号（时间、来源、热度变化等）","opportunities":[{"type":"从内容、工具、服务、电商、投资观察、风险管理观察、观察中选择一个","idea":"具体谁可以做什么","rationale":"为什么存在需求和验证路径","difficulty":"低|中|高","time_to_market":"当天|1-3天|1周+","confidence":0}],"risks":"主要风险和如何验证"}

禁止：把趋势指数当成平台热度；禁止跨平台直接比较原始热度；禁止使用证据中没有出现的数字、日期、来源、产品事实或增长结论；证据没有提供时必须明确说“未提供”；禁止值得关注、热度很高、前景广阔等空泛表达。`;
}

async function runModel(env, model, topic, evidence, { structured = false } = {}) {
  const request = {
    messages: [
      { role: 'system', content: '严格基于证据，不捏造事实，不承诺收益。' },
      { role: 'user', content: buildPrompt(topic, evidence) }
    ],
    max_tokens: 900,
    temperature: structured ? 0.1 : 0.2
  };
  if (structured) request.response_format = { type: 'json_schema', json_schema: AI_RESPONSE_SCHEMA };
  const out = await env.AI.run(model, request);
  const payload = extractModelPayload(out);
  if (!payload.rawText) return { analysis: null, failureReason: 'empty-model-response', rawText: '', model };
  const normalized = normalizeAnalysis(payload.parsed, model, topic.canonical_title, topic, evidence);
  return { ...normalized, rawText: payload.rawText, model };
}

function asAttempt(result) {
  return {
    model: result?.model || 'unknown',
    analysis: result?.analysis || null,
    failureReason: result?.failureReason || null,
    rawText: result?.rawText || ''
  };
}

async function recordAttempt(env, topicId, model, result) {
  if (!env.DB) return;
  const excerpt = String(result?.rawText || '').replace(/\s+/g, ' ').slice(0, 600) || null;
  try {
    await env.DB.prepare(`
      INSERT INTO ai_attempts(topic_id,attempted_at,model,success,failure_reason,response_excerpt)
      VALUES(?,?,?,?,?,?)
    `).bind(topicId, new Date().toISOString(), model, result?.analysis ? 1 : 0, result?.failureReason || null, excerpt).run();
  } catch (err) {
    console.warn('failed to persist AI attempt diagnostics', err);
  }
}

async function runStructuredFallback(env, topic, evidence, primary, primaryFailureReason) {
  const fallbackModel = env.AI_FALLBACK_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';
  try {
    const fallback = await runModel(env, fallbackModel, topic, evidence, { structured: true });
    return {
      ...fallback,
      rawText: fallback.rawText || primary?.rawText || '',
      primaryFailureReason,
      fallbackUsed: true,
      attemptTrace: [asAttempt(primary), asAttempt(fallback)]
    };
  } catch (fallbackErr) {
    const fallback = {
      analysis: null,
      failureReason: classifyInferenceError(fallbackErr, 'fallback-inference-error'),
      rawText: formatInferenceError(fallbackErr) || primary?.rawText || '',
      model: fallbackModel
    };
    return {
      ...fallback,
      primaryFailureReason,
      fallbackUsed: true,
      attemptTrace: [asAttempt(primary), asAttempt(fallback)]
    };
  }
}

export async function analyzeTopicDetailed(env, topic, evidence) {
  if (!hasCurrentEvidence(topic, evidence)) {
    return { analysis: null, failureReason: 'no-current-evidence', rawText: '', model: null, attemptTrace: [] };
  }
  if (!env.AI) return { analysis: null, failureReason: 'missing-ai-binding', rawText: '', model: null, attemptTrace: [] };
  const model = env.AI_MODEL || '@cf/zai-org/glm-4.7-flash';
  try {
    const structuredPrimary = JSON_MODE_MODELS.has(model) && env.AI_DISABLE_JSON_MODE !== '1';
    const primary = await runModel(env, model, topic, evidence, { structured: structuredPrimary });
    if (primary.analysis || env.AI_DISABLE_FALLBACK === '1') return { ...primary, attemptTrace: [asAttempt(primary)] };
    if (FALLBACK_REASONS.has(primary.failureReason)) return runStructuredFallback(env, topic, evidence, primary, primary.failureReason);
    return { ...primary, attemptTrace: [asAttempt(primary)] };
  } catch (err) {
    console.error('AI analysis failed', err);
    const primaryFailureReason = classifyInferenceError(err);
    const primary = {
      analysis: null,
      failureReason: primaryFailureReason,
      rawText: formatInferenceError(err),
      model
    };
    if (env.AI_DISABLE_FALLBACK !== '1' && isRecoverableInferenceFailure(primaryFailureReason)) {
      return runStructuredFallback(env, topic, evidence, primary, primaryFailureReason);
    }
    return { ...primary, attemptTrace: [asAttempt(primary)] };
  }
}

export async function analyzeTopic(env, topic, evidence) {
  const result = await analyzeTopicDetailed(env, topic, evidence);
  return result.analysis;
}

const INVALID_STORED_AI_SQL = `(
  ai_summary IS NULL OR length(trim(ai_summary)) < 20
  OR ai_why_now IS NULL OR length(trim(ai_why_now)) < 20
  OR ai_opportunities_json IS NULL OR ai_opportunities_json = '[]'
  OR ai_summary LIKE '%值得关注%' OR ai_summary LIKE '%热度较高%' OR ai_summary LIKE '%持续升温%'
  OR ai_summary LIKE '%具有重要意义%' OR ai_summary LIKE '%前景广阔%' OR ai_summary LIKE '%机会巨大%'
  OR ai_why_now LIKE '%值得关注%' OR ai_why_now LIKE '%热度较高%' OR ai_why_now LIKE '%持续升温%'
  OR ai_why_now LIKE '%具有重要意义%' OR ai_why_now LIKE '%前景广阔%' OR ai_why_now LIKE '%机会巨大%'
)`;

async function dailyQuotaCircuit(env) {
  if (!env.DB || env.AI_DISABLE_QUOTA_CIRCUIT === '1') return null;
  try {
    const row = await env.DB.prepare(`
      SELECT attempted_at, failure_reason FROM ai_attempts
      WHERE success=0
        AND (failure_reason LIKE 'inference-error:quota-or-capacity%' OR failure_reason LIKE 'fallback-inference-error:quota-or-capacity%')
        AND substr(attempted_at,1,10)=substr(datetime('now'),1,10)
      ORDER BY attempted_at DESC LIMIT 1
    `).first();
    if (!row?.attempted_at) return null;
    const nextUtcDay = new Date();
    nextUtcDay.setUTCHours(24, 0, 0, 0);
    return {
      reason: 'daily-ai-quota-exhausted',
      detectedAt: row.attempted_at,
      retryAfter: nextUtcDay.toISOString(),
      failureReason: row.failure_reason || 'inference-error:quota-or-capacity'
    };
  } catch (err) {
    console.warn('AI quota circuit probe failed', err);
    return null;
  }
}

export async function enrichTopTopics(env, options = {}) {
  const topN = Math.max(1, Math.min(20, Number(options.topN || env.AI_TOP_N || 8)));
  const retryMinutes = Math.max(5, Math.min(360, Number(env.AI_RETRY_MINUTES || 30)));
  const refreshHours = Math.max(1, Math.min(24, Number(env.AI_REFRESH_HOURS || 6)));
  const backfillOnly = options.backfillOnly === true;
  const retryModifier = `-${retryMinutes} minutes`;
  const refreshModifier = `-${refreshHours} hours`;

  const quotaCircuit = await dailyQuotaCircuit(env);
  if (quotaCircuit) {
    return {
      updated: 0,
      failed: 0,
      selected: 0,
      failureReasons: {},
      backfillOnly,
      retryMinutes,
      refreshHours,
      skipped: true,
      skipReason: quotaCircuit.reason,
      quotaDetectedAt: quotaCircuit.detectedAt,
      retryAfter: quotaCircuit.retryAfter,
      quotaFailureReason: quotaCircuit.failureReason
    };
  }

  // Under a finite daily Workers AI budget, spend inference first on topics that are still
  // actively moving. Old backlog remains eligible, but cannot outrank a fresh breakout solely
  // because it once had a larger score.
  const freshnessPrioritySql = `CASE
    WHEN julianday(last_seen_at) >= julianday('now','-6 hours') THEN 0
    WHEN julianday(last_seen_at) >= julianday('now','-24 hours') THEN 1
    ELSE 2
  END`;

  const candidateSql = backfillOnly
    ? `
      SELECT * FROM topics
      WHERE current_score >= 45
        AND ${INVALID_STORED_AI_SQL}
        AND (ai_updated_at IS NULL OR julianday(ai_updated_at) < julianday('now', ?))
      ORDER BY ${freshnessPrioritySql}, CASE WHEN ai_updated_at IS NULL THEN 0 ELSE 1 END,
        breakout_score DESC, current_score DESC, source_count DESC, last_seen_at DESC
      LIMIT ?`
    : `
      SELECT * FROM topics
      WHERE current_score >= 45
        AND (
          (${INVALID_STORED_AI_SQL} AND (ai_updated_at IS NULL OR julianday(ai_updated_at) < julianday('now', ?)))
          OR (NOT ${INVALID_STORED_AI_SQL} AND ai_updated_at IS NOT NULL AND julianday(ai_updated_at) < julianday('now', ?))
        )
      ORDER BY CASE WHEN ${INVALID_STORED_AI_SQL} THEN 0 ELSE 1 END, ${freshnessPrioritySql},
        CASE WHEN ai_updated_at IS NULL THEN 0 ELSE 1 END, breakout_score DESC, current_score DESC,
        source_count DESC, last_seen_at DESC
      LIMIT ?`;

  const stmt = env.DB.prepare(candidateSql);
  const { results = [] } = backfillOnly
    ? await stmt.bind(retryModifier, topN).all()
    : await stmt.bind(retryModifier, refreshModifier, topN).all();

  let count = 0;
  let failed = 0;
  const failureReasons = {};
  for (const topic of results) {
    const { results: evidence = [] } = await env.DB.prepare(`
      SELECT ts.source_id,ts.title,ts.url,ts.rank,ts.captured_at,
             CASE
               WHEN r.id IS NULL THEN s.kind
               WHEN ts.source_id='xiaohongshu' OR json_extract(r.raw_json,'$.trendRadarUpstream') LIKE 'xiaohongshu-mcp:%' THEN 'external-bridge'
               WHEN json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%api-hot.imsyy.top%' OR json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%api.guole.fun%' THEN 'aggregator-fallback'
               WHEN json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%aa1.cn%' OR json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%luochen.sbs%' OR json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%fanyia.cn%' THEN 'mirror-fallback'
               WHEN ts.source_id='36kr' AND json_extract(r.raw_json,'$.trendRadarUpstream') LIKE 'https://www.36kr.com/feed%' THEN 'official-rss'
               WHEN ts.source_id IN ('hackernews','github','weibo','zhihu','douyin','v2ex','juejin','36kr','bilibili') THEN 'official-api'
               ELSE 'source-api'
             END AS source_kind,
             r.heat AS raw_heat,r.engagement AS raw_engagement,
             s.metadata_json AS metric_definition,
             json_extract(r.raw_json, '$.trendRadarUpstream') AS upstream,
             json_extract(r.raw_json, '$.trendRadarMetrics.heat_path') AS heat_metric_path,
             json_extract(r.raw_json, '$.trendRadarMetrics.engagement_path') AS engagement_metric_path
        FROM topic_sources ts
        JOIN sources active_source ON active_source.id = ts.source_id
         AND ${currentSourcePredicate('active_source')}
        JOIN sources s ON s.id = ts.source_id
        LEFT JOIN raw_items r ON r.source_id=ts.source_id
          AND r.external_id=ts.external_id AND r.captured_at=ts.captured_at
       WHERE ts.topic_id=?
         AND julianday(ts.captured_at) >= julianday('now','-24 hours')
       ORDER BY ts.captured_at DESC LIMIT 12
    `).bind(topic.id).all();
    if (!hasCurrentEvidence(topic, evidence)) {
      failed++;
      failureReasons['no-current-evidence'] = (failureReasons['no-current-evidence'] || 0) + 1;
      continue;
    }
    const result = await analyzeTopicDetailed(env, topic, evidence);
    const attempts = Array.isArray(result.attemptTrace) && result.attemptTrace.length ? result.attemptTrace : [asAttempt(result)];
    for (const attempt of attempts) await recordAttempt(env, topic.id, attempt.model, attempt);
    const analysis = result.analysis;
    const now = new Date().toISOString();
    if (!analysis) {
      failed++;
      const reason = result.failureReason || 'unknown';
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      if (!isStoredAIValid(topic)) await env.DB.prepare(`UPDATE topics SET ai_updated_at=? WHERE id=?`).bind(now, topic.id).run();
      continue;
    }
    await env.DB.prepare(`UPDATE topics SET ai_summary=?, ai_why_now=?, ai_opportunities_json=?, ai_risks=?, ai_updated_at=? WHERE id=?`).bind(analysis.summary, analysis.why_now, JSON.stringify(analysis.opportunities), analysis.risks, now, topic.id).run();
    count++;
  }

  try {
    await env.DB.prepare(`DELETE FROM ai_attempts WHERE julianday(attempted_at) < julianday('now','-7 days')`).run();
  } catch (err) {
    console.warn('failed to prune AI attempt diagnostics', err);
  }

  return { updated: count, failed, selected: results.length, failureReasons, backfillOnly, retryMinutes, refreshHours };
}
