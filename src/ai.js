import { safeJsonParse } from './utils.js';

function extractJson(text) {
  if (!text) return null;
  const direct = safeJsonParse(text, null);
  if (direct) return direct;
  const m = String(text).match(/\{[\s\S]*\}/);
  return m ? safeJsonParse(m[0], null) : null;
}

function hasLowValuePhrase(text) {
  return /值得关注|热度较高|持续升温|具有重要意义|前景广阔|机会巨大/.test(String(text || ''));
}

export function isStoredAIValid(topic) {
  if (!topic) return false;
  const summary = String(topic.ai_summary || '').trim();
  const whyNow = String(topic.ai_why_now || '').trim();
  const opportunities = safeJsonParse(topic.ai_opportunities_json, []);
  if (summary.length < 20 || whyNow.length < 20) return false;
  if (!Array.isArray(opportunities) || opportunities.length < 1) return false;
  if (hasLowValuePhrase(summary) || hasLowValuePhrase(whyNow)) return false;
  return opportunities.every(o => String(o?.idea || '').trim() && String(o?.rationale || '').trim());
}

function normalizeAnalysis(parsed, model, topicTitle) {
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
  if (summary.length < 20 || whyNow.length < 20) return { analysis: null, failureReason: 'too-short' };
  if (hasLowValuePhrase(summary) || hasLowValuePhrase(whyNow)) return { analysis: null, failureReason: 'low-value-language' };
  if (summary === topicTitle || summary.includes(topicTitle)) return { analysis: null, failureReason: 'title-echo' };
  return { analysis: { summary, why_now: whyNow, opportunities, risks }, failureReason: null };
}

async function recordAttempt(env, topicId, model, result) {
  if (!env.DB) return;
  const excerpt = String(result?.rawText || '').replace(/\s+/g, ' ').slice(0, 600) || null;
  try {
    await env.DB.prepare(`
      INSERT INTO ai_attempts(topic_id,attempted_at,model,success,failure_reason,response_excerpt)
      VALUES(?,?,?,?,?,?)
    `).bind(
      topicId,
      new Date().toISOString(),
      model,
      result?.analysis ? 1 : 0,
      result?.failureReason || null,
      excerpt
    ).run();
  } catch (err) {
    console.warn('failed to persist AI attempt diagnostics', err);
  }
}

export async function analyzeTopicDetailed(env, topic, evidence) {
  if (!env.AI) return { analysis: null, failureReason: 'missing-ai-binding', rawText: '', model: null };
  const model = env.AI_MODEL || '@cf/zai-org/glm-4.7-flash';
  const prompt = `你是互联网趋势分析师和产品机会研究员。基于真实证据分析热点。
不要复述标题，不要写新闻摘要模板，不要把热度等同于商业价值。

主题：${topic.canonical_title}
分类：${topic.category}
综合热度：${topic.current_score}
突破指数：${topic.breakout_score}
来源数：${topic.source_count}
证据：${evidence.map(x => `${x.source_id} #${x.rank || '-'} ${x.title}`).join('\n')}

只输出 JSON：
{"summary":"发生了什么，说明事件本质而不是标题改写","why_now":"为什么现在发生，引用可观察信号（时间、来源、热度变化等）","opportunities":[{"type":"内容|工具|服务|电商|投资观察","idea":"具体谁可以做什么","rationale":"为什么存在需求和验证路径","difficulty":"低|中|高","time_to_market":"当天|1-3天|1周+","confidence":0}],"risks":"主要风险和如何验证"}

禁止：值得关注、热度很高、前景广阔等空泛表达。`;
  try {
    const out = await env.AI.run(model, {
      messages: [
        { role: 'system', content: '严格基于证据，不捏造事实，不承诺收益。' },
        { role: 'user', content: prompt }
      ],
      max_completion_tokens: 900,
      temperature: 0.2
    });
    const rawText = out?.response || out?.result?.response || out?.choices?.[0]?.message?.content || '';
    if (!String(rawText).trim()) return { analysis: null, failureReason: 'empty-model-response', rawText: '', model };
    const normalized = normalizeAnalysis(extractJson(rawText), model, topic.canonical_title);
    return { ...normalized, rawText, model };
  } catch (err) {
    console.error('AI analysis failed', err);
    const code = String(err?.code || err?.name || '').trim();
    return {
      analysis: null,
      failureReason: code ? `inference-error:${code}` : 'inference-error',
      rawText: String(err?.message || err).slice(0, 600),
      model
    };
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

export async function enrichTopTopics(env, options = {}) {
  const topN = Math.max(1, Math.min(20, Number(options.topN || env.AI_TOP_N || 8)));
  const retryMinutes = Math.max(5, Math.min(360, Number(env.AI_RETRY_MINUTES || 30)));
  const refreshHours = Math.max(1, Math.min(24, Number(env.AI_REFRESH_HOURS || 6)));
  const backfillOnly = options.backfillOnly === true;
  const retryModifier = `-${retryMinutes} minutes`;
  const refreshModifier = `-${refreshHours} hours`;

  const candidateSql = backfillOnly
    ? `
      SELECT * FROM topics
      WHERE current_score >= 45
        AND ${INVALID_STORED_AI_SQL}
        AND (ai_updated_at IS NULL OR julianday(ai_updated_at) < julianday('now', ?))
      ORDER BY
        CASE WHEN ai_updated_at IS NULL THEN 0 ELSE 1 END,
        breakout_score DESC,
        current_score DESC
      LIMIT ?`
    : `
      SELECT * FROM topics
      WHERE current_score >= 45
        AND (
          (${INVALID_STORED_AI_SQL} AND (ai_updated_at IS NULL OR julianday(ai_updated_at) < julianday('now', ?)))
          OR (NOT ${INVALID_STORED_AI_SQL} AND ai_updated_at IS NOT NULL AND julianday(ai_updated_at) < julianday('now', ?))
        )
      ORDER BY
        CASE WHEN ${INVALID_STORED_AI_SQL} THEN 0 ELSE 1 END,
        CASE WHEN ai_updated_at IS NULL THEN 0 ELSE 1 END,
        breakout_score DESC,
        current_score DESC
      LIMIT ?`;

  const stmt = env.DB.prepare(candidateSql);
  const { results = [] } = backfillOnly
    ? await stmt.bind(retryModifier, topN).all()
    : await stmt.bind(retryModifier, refreshModifier, topN).all();

  let count = 0;
  let failed = 0;
  const failureReasons = {};
  for (const topic of results) {
    const { results: evidence = [] } = await env.DB.prepare(`SELECT source_id,title,url,rank,captured_at FROM topic_sources WHERE topic_id=? ORDER BY captured_at DESC LIMIT 12`).bind(topic.id).all();
    const result = await analyzeTopicDetailed(env, topic, evidence);
    await recordAttempt(env, topic.id, result.model || env.AI_MODEL || 'unknown', result);
    const analysis = result.analysis;
    const now = new Date().toISOString();
    if (!analysis) {
      failed++;
      const reason = result.failureReason || 'unknown';
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      if (!isStoredAIValid(topic)) {
        await env.DB.prepare(`UPDATE topics SET ai_updated_at=? WHERE id=?`).bind(now, topic.id).run();
      }
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