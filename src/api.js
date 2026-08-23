import { json, fingerprintTitle, safeJsonParse, categoryFor } from './utils.js';
import { collectAll, ingestExternal } from './collector.js';
import { isStoredAIValid } from './ai.js';

const DEFAULT_REAL_DASHBOARD_FALLBACK = 'https://linyuxuanlin.github.io/internet-trend-radar/data/dashboard.json';

function previewData(category = '') {
  const now = new Date();
  const seed = [
    ['preview-ai-agents','AI Agent 工具进入新一轮产品化','AI',88,94,'多个开发者社区同时出现 Agent 工作流、浏览器自动化和本地执行工具讨论。','把重复工作流做成小而专的 Agent 工具，先验证单一高频场景。'],
    ['preview-local-ai','本地 AI 与隐私优先应用升温','AI',81,86,'端侧模型、私有知识库和离线推理持续获得关注。','面向个人资料、企业文档做隐私优先的本地 AI 助手。'],
    ['preview-creator-tools','AI 内容生产从生成转向工作流','科技',76,82,'用户关注点从一次性生成转向素材管理、审核和发布闭环。','围绕创作者真实发布流程做可复用模板和自动化。'],
    ['preview-consumption','高性价比消费决策工具受关注','消费',72,78,'价格历史、口碑聚合和避坑信息在多个平台持续有需求。','把分散评价整理成可解释的购买决策雷达。'],
    ['preview-open-source','开源 AI 项目迭代速度继续提高','科技',84,89,'GitHub 等开发者平台的新工具和模型封装保持高频更新。','追踪增长速度而非绝对 Star 数，寻找刚出现的开发机会。'],
    ['preview-sports','大众运动的轻量训练服务增长','体育',64,71,'网球、跑步等运动内容更强调入门体验与持续训练。','设计低压力、可量化的练习记录与教练匹配工具。']
  ];
  let topics = seed.map((x,i)=>({id:x[0],canonical_title:x[1],category:x[2],current_score:x[3],breakout_score:x[4],source_count:2+i%3,status:x[4]>=85?'rising':'watch',ai_summary:x[5],opportunities:[{idea:x[6]}],preview:true}));
  if (category && category !== '全部') topics = topics.filter(t=>t.category===category);
  const counts = {};
  for (const t of topics) counts[t.category]=(counts[t.category]||0)+1;
  const timeline = Array.from({length:12},(_,i)=>({t:new Date(now.getTime()-(11-i)*2*3600e3).toISOString(),score:55+i*2.3+(i%3)*3,breakout:43+i*3.2+(i%4)*2}));
  return {generatedAt:now.toISOString(),preview:true,topics,categories:Object.entries(counts).map(([category,count])=>({category,count,avg_score:Math.round(topics.filter(t=>t.category===category).reduce((a,b)=>a+b.current_score,0)/count)})),timeline,sources:[
    {id:'preview-cn',name:'中文互联网聚合',region:'CN',kind:'preview',last_success_at:now.toISOString(),last_error:null,last_item_count:36},
    {id:'preview-dev',name:'开发者社区',region:'GLOBAL',kind:'preview',last_success_at:now.toISOString(),last_error:null,last_item_count:24},
    {id:'preview-news',name:'新闻与科技媒体',region:'GLOBAL',kind:'preview',last_success_at:now.toISOString(),last_error:null,last_item_count:18}
  ]};
}

function notReady(error, extra = {}) {
  return {
    generatedAt: new Date().toISOString(),
    ready: false,
    preview: false,
    error,
    topics: [],
    categories: [],
    timeline: [],
    sources: [],
    ...extra
  };
}

function publicTopic(topic) {
  const opportunities = safeJsonParse(topic.ai_opportunities_json, []) || [];
  if (isStoredAIValid(topic)) return { ...topic, opportunities };
  return {
    ...topic,
    ai_summary: null,
    ai_why_now: null,
    ai_risks: null,
    opportunities: [],
    ai_verified: false
  };
}

function nextBudgetReleaseIso(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
}

function nextUtcDayIso(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

export async function aiBudgetStatus(env, now = new Date()) {
  if (!env.DB) return { ok: false, error: 'missing DB binding' };
  const dailyBudget = Math.max(24, Math.min(240, Number(env.AI_DAILY_MODEL_CALL_BUDGET || 96)));
  const maxCallsPerTopic = env.AI_DISABLE_FALLBACK === '1' ? 1 : 2;
  const utcHour = now.getUTCHours();
  const cumulativeBudget = Math.ceil(dailyBudget * (utcHour + 1) / 24);
  const row = await env.DB.prepare(`
    SELECT count(*) AS attempts FROM ai_attempts
    WHERE substr(attempted_at,1,10)=substr(datetime('now'),1,10)
  `).first();
  const attemptsToday = Math.max(0, Number(row?.attempts || 0));
  const remainingHeadroom = Math.max(0, cumulativeBudget - attemptsToday);
  const remainingDaily = Math.max(0, dailyBudget - attemptsToday);
  const topicHeadroom = Math.floor(remainingHeadroom / maxCallsPerTopic);
  return {
    ok: true,
    generatedAt: now.toISOString(),
    timezone: 'UTC',
    daily_budget: dailyBudget,
    attempts_today: attemptsToday,
    cumulative_budget: cumulativeBudget,
    remaining_headroom: remainingHeadroom,
    remaining_daily: remainingDaily,
    topic_headroom: topicHeadroom,
    max_calls_per_topic: maxCallsPerTopic,
    paced: remainingHeadroom === 0 && remainingDaily > 0,
    exhausted: remainingDaily === 0,
    next_release_at: remainingHeadroom === 0 && remainingDaily > 0 ? nextBudgetReleaseIso(now) : null
  };
}

async function providerQuotaStatus(env, now = new Date()) {
  if (!env.DB) return { exhausted: false, detected_at: null, retry_after: null, failure_reason: null };
  const row = await env.DB.prepare(`
    SELECT attempted_at, failure_reason FROM ai_attempts
    WHERE success=0
      AND (failure_reason LIKE 'inference-error:quota-or-capacity%' OR failure_reason LIKE 'fallback-inference-error:quota-or-capacity%')
      AND substr(attempted_at,1,10)=substr(datetime('now'),1,10)
    ORDER BY attempted_at DESC LIMIT 1
  `).first();
  return {
    exhausted: Boolean(row?.attempted_at),
    detected_at: row?.attempted_at || null,
    retry_after: row?.attempted_at ? nextUtcDayIso(now) : null,
    failure_reason: row?.failure_reason || null
  };
}

export async function aiAvailabilityStatus(env, now = new Date()) {
  const generatedAt = now.toISOString();
  if (!env.DB) {
    return {
      ok: false,
      generatedAt,
      available: false,
      effective_blocker: 'missing-db-binding',
      binding: Boolean(env.AI),
      provider_quota: { exhausted: false, detected_at: null, retry_after: null, failure_reason: null },
      pacing: { ok: false, error: 'missing DB binding' }
    };
  }

  const [pacing, providerQuota] = await Promise.all([
    aiBudgetStatus(env, now),
    providerQuotaStatus(env, now)
  ]);

  let effectiveBlocker = null;
  if (!env.AI) effectiveBlocker = 'missing-ai-binding';
  else if (providerQuota.exhausted) effectiveBlocker = 'provider-daily-quota-exhausted';
  else if (pacing.exhausted) effectiveBlocker = 'daily-ai-budget-exhausted';
  else if (pacing.paced || pacing.topic_headroom < 1) effectiveBlocker = 'daily-ai-budget-paced';

  return {
    ok: true,
    generatedAt,
    available: effectiveBlocker === null,
    effective_blocker: effectiveBlocker,
    binding: Boolean(env.AI),
    provider_quota: providerQuota,
    pacing
  };
}

async function fetchRealDashboardFallback(env, category, reason) {
  const fallbackUrl = String(env.PUBLIC_FALLBACK_DASHBOARD_URL || DEFAULT_REAL_DASHBOARD_FALLBACK).trim();
  const maxAgeMs = Math.max(1, Number(env.FALLBACK_MAX_AGE_HOURS || 4)) * 60 * 60 * 1000;
  if (!fallbackUrl) return null;

  try {
    const response = await fetch(fallbackUrl, {
      headers: { accept: 'application/json', 'user-agent': 'internet-trend-radar-worker-fallback/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data?.preview !== false || data?.ready !== true) throw new Error('fallback snapshot is not real-data ready');
    if (!Array.isArray(data?.topics) || data.topics.length < 1) throw new Error('fallback snapshot has no topics');
    if (!Array.isArray(data?.sources) || data.sources.length < 1) throw new Error('fallback snapshot has no sources');

    const generatedAt = Date.parse(data.generatedAt || '');
    if (!Number.isFinite(generatedAt)) throw new Error('fallback snapshot has invalid generatedAt');
    const age = Date.now() - generatedAt;
    if (age < -5 * 60 * 1000) throw new Error('fallback snapshot is materially in the future');
    if (age > maxAgeMs) throw new Error(`fallback snapshot is stale (${Math.round(age / 60000)}m)`);

    const topics = category && category !== '全部'
      ? data.topics.filter(topic => topic.category === category)
      : data.topics;

    return {
      ...data,
      ready: true,
      preview: false,
      topics,
      fallback: {
        active: true,
        kind: 'github-pages-real-snapshot',
        source: fallbackUrl,
        reason: String(reason || 'worker D1 unavailable'),
        fetchedAt: new Date().toISOString(),
        maxAgeHours: maxAgeMs / 3600000
      }
    };
  } catch (error) {
    console.warn('real dashboard fallback unavailable', error);
    return null;
  }
}

async function dashboard(env, url) {
  const category = url.searchParams.get('category') || '';
  if (!env.DB) {
    const fallback = await fetchRealDashboardFallback(env, category, 'missing DB binding');
    return fallback ? json(fallback) : json(notReady('missing DB binding and no fresh real fallback snapshot'), { status: 503 });
  }

  try {
    const where = category && category !== '全部' ? 'WHERE category=?' : '';
    const stmt = env.DB.prepare(`SELECT * FROM topics ${where} ORDER BY current_score DESC, breakout_score DESC LIMIT 80`);
    const { results: topics = [] } = category && category !== '全部' ? await stmt.bind(category).all() : await stmt.all();
    const { results: sources = [] } = await env.DB.prepare(`SELECT id,name,region,kind,last_success_at,last_error_at,last_error,last_item_count FROM sources ORDER BY region DESC,name`).all();

    if (!topics.length) {
      const fallback = await fetchRealDashboardFallback(env, category, 'D1 has no real topics');
      return fallback ? json(fallback) : json(notReady('no real topics available yet', { sources }), { status: 503 });
    }

    const { results: categories = [] } = await env.DB.prepare(`SELECT category,COUNT(*) count,ROUND(AVG(current_score),1) avg_score FROM topics GROUP BY category ORDER BY count DESC`).all();
    const { results: timeline = [] } = await env.DB.prepare(`SELECT substr(captured_at,1,13)||':00:00Z' t, ROUND(AVG(score),1) score, ROUND(AVG(breakout_score),1) breakout FROM topic_snapshots WHERE julianday(captured_at) >= julianday('now','-24 hours') GROUP BY t ORDER BY t`).all();
    return json({ generatedAt: new Date().toISOString(), ready:true, preview:false, topics: topics.map(publicTopic), sources, categories, timeline });
  } catch (error) {
    console.error('dashboard real-data query failed', error);
    const fallback = await fetchRealDashboardFallback(env, category, `D1 dashboard query failed: ${String(error?.message || error)}`);
    return fallback ? json(fallback) : json(notReady(String(error?.message || error)), { status: 503 });
  }
}

async function topicDetail(env, id) {
  if (id.startsWith('preview-')) {
    const topic = previewData('').topics.find(t=>t.id===id);
    return topic ? json({...topic,sources:[],snapshots:previewData('').timeline.map(x=>({captured_at:x.t,score:x.score,breakout_score:x.breakout}))}) : json({error:'not found'},{status:404});
  }
  const topic = await env.DB.prepare(`SELECT * FROM topics WHERE id=?`).bind(id).first();
  if (!topic) return json({ error: 'not found' }, { status: 404 });
  const { results: sources = [] } = await env.DB.prepare(`SELECT source_id,title,url,rank,captured_at FROM topic_sources WHERE topic_id=? ORDER BY captured_at DESC LIMIT 50`).bind(id).all();
  const { results: snapshots = [] } = await env.DB.prepare(`SELECT captured_at,score,breakout_score,source_count,mention_count FROM topic_snapshots WHERE topic_id=? ORDER BY captured_at ASC LIMIT 96`).bind(id).all();
  return json({ ...publicTopic(topic), sources, snapshots });
}

async function subscribe(env, request) {
  const body = await request.json();
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'invalid email' }, { status: 400 });
  if (!env.DB) return json({ok:true,preview:true});
  const categories = Array.isArray(body.categories) && body.categories.length ? body.categories.slice(0, 12) : ['综合'];
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO subscribers(email,categories_json,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET active=1,categories_json=excluded.categories_json,updated_at=excluded.updated_at`).bind(email, JSON.stringify(categories), now, now).run();
  return json({ ok: true });
}

async function externalIngest(env, request, sourceId) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) return json({ error: 'unauthorized' }, { status: 401 });
  const body = await request.json();
  const items = (body.items || []).map(x => ({ ...x, fingerprint: x.fingerprint || fingerprintTitle(x.title), category: x.category || categoryFor(sourceId, x.title) }));
  const count = await ingestExternal(env, sourceId, items);
  return json({ ok: true, count });
}

export async function routeApi(env, request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') return json({ ok: true, time: new Date().toISOString() });
  if (url.pathname === '/api/ai-budget' && request.method === 'GET') {
    try {
      return json(await aiBudgetStatus(env));
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error), generatedAt: new Date().toISOString() }, { status: 503 });
    }
  }
  if (url.pathname === '/api/ai-availability' && request.method === 'GET') {
    try {
      return json(await aiAvailabilityStatus(env));
    } catch (error) {
      return json({ ok: false, available: false, effective_blocker: 'availability-probe-failed', error: String(error?.message || error), generatedAt: new Date().toISOString() }, { status: 503 });
    }
  }
  if (url.pathname === '/api/dashboard' && request.method === 'GET') return dashboard(env, url);
  if (url.pathname.startsWith('/api/topic/') && request.method === 'GET') return topicDetail(env, decodeURIComponent(url.pathname.slice('/api/topic/'.length)));
  if (url.pathname === '/api/subscribe' && request.method === 'POST') return subscribe(env, request);
  if (url.pathname.startsWith('/api/ingest/') && request.method === 'POST') return externalIngest(env, request, decodeURIComponent(url.pathname.slice('/api/ingest/'.length)));
  if (url.pathname === '/api/admin/collect' && request.method === 'POST') {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    const openPreview = env.ALLOW_OPEN_COLLECT === '1';
    if (!openPreview && (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, { status: 401 });
    try {
      return json(await collectAll(env));
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, { status: 503 });
    }
  }
  return json({ error: 'not found' }, { status: 404 });
}