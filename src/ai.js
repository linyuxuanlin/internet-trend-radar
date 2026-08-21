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

function normalizeAnalysis(parsed, model, topicTitle) {
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
  if (summary.length < 20 || whyNow.length < 20) return null;
  if (hasLowValuePhrase(summary) || hasLowValuePhrase(whyNow)) return null;
  if (summary === topicTitle || summary.includes(topicTitle)) return null;
  return { summary, why_now: whyNow, opportunities, risks };
}

export async function analyzeTopic(env, topic, evidence) {
  if (!env.AI) return null;
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
    const text = out?.response || out?.result?.response || out?.choices?.[0]?.message?.content || '';
    return normalizeAnalysis(extractJson(text), model, topic.canonical_title);
  } catch (err) {
    console.error('AI analysis failed', err);
    return null;
  }
}

export async function enrichTopTopics(env) {
  const topN = Math.max(1, Math.min(20, Number(env.AI_TOP_N || 8)));
  const { results = [] } = await env.DB.prepare(`SELECT * FROM topics WHERE current_score >= 45 AND (ai_updated_at IS NULL OR julianday(ai_updated_at) < julianday('now','-6 hours')) ORDER BY breakout_score DESC, current_score DESC LIMIT ?`).bind(topN).all();
  let count = 0;
  for (const topic of results) {
    const { results: evidence = [] } = await env.DB.prepare(`SELECT source_id,title,url,rank,captured_at FROM topic_sources WHERE topic_id=? ORDER BY captured_at DESC LIMIT 12`).bind(topic.id).all();
    const analysis = await analyzeTopic(env, topic, evidence);
    if (!analysis) continue;
    await env.DB.prepare(`UPDATE topics SET ai_summary=?, ai_why_now=?, ai_opportunities_json=?, ai_risks=?, ai_updated_at=? WHERE id=?`).bind(analysis.summary, analysis.why_now, JSON.stringify(analysis.opportunities), analysis.risks, new Date().toISOString(), topic.id).run();
    count++;
  }
  return count;
}
