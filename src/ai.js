import { safeJsonParse } from './utils.js';

function heuristic(topic) {
  const title = topic.canonical_title;
  return {
    summary: `「${title}」正在进入活跃讨论区间，可结合来源扩散和热度增速判断是否形成持续趋势。`,
    why_now: `当前综合热度 ${Math.round(topic.current_score)}，突破指数 ${Math.round(topic.breakout_score)}，覆盖 ${topic.source_count} 个来源。`,
    opportunities: [
      { type: '内容', idea: `围绕「${title}」制作解释型/对比型内容`, rationale: '热点早期的信息差通常大于成熟期', difficulty: '低', time_to_market: '当天', confidence: 55 },
      { type: '工具', idea: `寻找「${title}」相关的重复操作或信息整理需求，做轻量工具/目录`, rationale: '用搜索量和评论问题验证真实需求后再开发', difficulty: '中', time_to_market: '1-3天', confidence: 45 }
    ],
    risks: '热度不等于付费需求；避免把单平台榜单误判为跨平台趋势。'
  };
}

function extractJson(text) {
  if (!text) return null;
  const direct = safeJsonParse(text, null);
  if (direct) return direct;
  const m = String(text).match(/\{[\s\S]*\}/);
  return m ? safeJsonParse(m[0], null) : null;
}

export async function analyzeTopic(env, topic, evidence) {
  if (!env.AI) return heuristic(topic);
  const prompt = `你是互联网趋势分析师和产品机会研究员。请基于证据分析热点，不要把“热”直接等价为“能赚钱”。\n\n主题：${topic.canonical_title}\n分类：${topic.category}\n综合热度：${topic.current_score}\n突破指数：${topic.breakout_score}\n来源数：${topic.source_count}\n证据：${evidence.map(x => `${x.source_id} #${x.rank || '-'} ${x.title}`).join('\n')}\n\n只输出 JSON，不要 markdown：\n{"summary":"一句话发生了什么","why_now":"为什么现在变热，必须引用可观察信号，不要编造事件","opportunities":[{"type":"内容|工具|服务|电商|投资观察","idea":"具体可行动想法","rationale":"需求逻辑","difficulty":"低|中|高","time_to_market":"当天|1-3天|1周+","confidence":0}],"risks":"主要风险与验证方式"}\n最多3个 opportunities。confidence 为0-100。`;
  try {
    const out = await env.AI.run(env.AI_MODEL || '@cf/zai-org/glm-4.7-flash', {
      messages: [
        { role: 'system', content: '严格基于提供的趋势证据分析。不得承诺收益，不得捏造未提供的事实。' },
        { role: 'user', content: prompt }
      ],
      max_completion_tokens: 900,
      temperature: 0.25
    });
    const text = out?.response || out?.result?.response || out?.choices?.[0]?.message?.content || '';
    return extractJson(text) || heuristic(topic);
  } catch (err) {
    console.error('AI analysis failed', err);
    return heuristic(topic);
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
  for (const topic of results) {
    const { results: evidence = [] } = await env.DB.prepare(`
      SELECT source_id,title,url,rank,captured_at FROM topic_sources
      WHERE topic_id=? ORDER BY captured_at DESC LIMIT 12
    `).bind(topic.id).all();
    const analysis = await analyzeTopic(env, topic, evidence);
    await env.DB.prepare(`
      UPDATE topics SET ai_summary=?, ai_why_now=?, ai_opportunities_json=?, ai_risks=?, ai_updated_at=? WHERE id=?
    `).bind(analysis.summary || '', analysis.why_now || '', JSON.stringify(analysis.opportunities || []), analysis.risks || '', new Date().toISOString(), topic.id).run();
    count++;
  }
  return count;
}
