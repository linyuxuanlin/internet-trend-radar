import { safeJsonParse } from './utils.js';

function extractJson(text) {
  if (!text) return null;
  const direct = safeJsonParse(text, null);
  if (direct) return direct;
  const m = String(text).match(/\{[\s\S]*\}/);
  return m ? safeJsonParse(m[0], null) : null;
}

function normalizeAnalysis(parsed, model) {
  if (!parsed || typeof parsed !== 'object') return null;
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
  if (!summary || !whyNow || opportunities.length < 1) return null;
  return { summary, why_now: whyNow, opportunities, risks };
}

export async function analyzeTopic(env, topic, evidence) {
  if (!env.AI) return null;
  const model = env.AI_MODEL || '@cf/zai-org/glm-4.7-flash';
  const prompt = `你是互联网趋势分析师和产品机会研究员。请基于证据分析热点，不要把“热”直接等价为“能赚钱”。\n\n主题：${topic.canonical_title}\n分类：${topic.category}\n综合热度：${topic.current_score}\n突破指数：${topic.breakout_score}\n来源数：${topic.source_count}\n证据：${evidence.map(x => `${x.source_id} #${x.rank || '-'} ${x.title}`).join('\n')}\n\n只输出 JSON，不要 markdown：\n{"summary":"一句话发生了什么","why_now":"为什么现在变热，必须引用可观察信号，不要编造事件","opportunities":[{"type":"内容|工具|服务|电商|投资观察","idea":"具体可行动想法","rationale":"需求逻辑","difficulty":"低|中|高","time_to_market":"当天|1-3天|1周+","confidence":0}],"risks":"主要风险与验证方式"}\n最多3个 opportunities。confidence 为0-100。`;
  try {
    const out = await env.AI.run(model, {
      messages: [
        { role: 'system', content: '严格基于提供的趋势证据分析。不得承诺收益，不得捏造未提供的事实。' },
        { role: 'user', content: prompt }
      ],
      max_completion_tokens: 900,
      temperature: 0.25
    });
    const text = out?.response || out?.result?.response || out?.choices?.[0]?.message?.content || '';
    return normalizeAnalysis(extractJson(text), model);
  } catch (err) {
    console.error('AI analysis failed', err);
    return null;
  }
}

export async function enrichTopTopics(env) {
  const topN = Math.max(1, Math.min(20, Number(env.AI_TOP_N || 8)));
  const { results = [] } = await env.DB.prepare(`
    SELECT * FROM topics
    WHERE current_score >= 45
      AND (ai_updated_at IS NULL OR julianday(ai_updated_at) < julianday('now','-6 hours'))
    ORDER BY breakout_score DESC, current_score DESC LIMIT ?
  `).bind(topN).all();
  let count = 0;
  let skipped = 0;
  for (const topic of results) {
    const { results: evidence = [] } = await env.DB.prepare(`
      SELECT source_id,title,url,rank,captured_at FROM topic_sources
      WHERE topic_id=? ORDER BY captured_at DESC LIMIT 12
    `).bind(topic.id).all();
    const analysis = await analyzeTopic(env, topic, evidence);
    if (!analysis) {
      skipped++;
      continue;
    }
    await env.DB.prepare(`
      UPDATE topics SET ai_summary=?, ai_why_now=?, ai_opportunities_json=?, ai_risks=?, ai_updated_at=? WHERE id=?
    `).bind(analysis.summary, analysis.why_now, JSON.stringify(analysis.opportunities), analysis.risks, new Date().toISOString(), topic.id).run();
    count++;
  }
  if (skipped) console.warn(`AI analysis skipped ${skipped} topics because no verified model output was available`);
  return count;
}
