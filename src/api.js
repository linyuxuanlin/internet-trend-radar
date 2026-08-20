import { json, fingerprintTitle, safeJsonParse, categoryFor } from './utils.js';
import { collectAll, ingestExternal } from './collector.js';

async function dashboard(env, url) {
  const category = url.searchParams.get('category') || '';
  const where = category && category !== '全部' ? 'WHERE category=?' : '';
  const stmt = env.DB.prepare(`SELECT * FROM topics ${where} ORDER BY current_score DESC, breakout_score DESC LIMIT 80`);
  const { results: topics = [] } = category && category !== '全部' ? await stmt.bind(category).all() : await stmt.all();
  const { results: sources = [] } = await env.DB.prepare(`SELECT id,name,region,kind,last_success_at,last_error_at,last_error,last_item_count FROM sources ORDER BY region DESC,name`).all();
  const { results: categories = [] } = await env.DB.prepare(`SELECT category,COUNT(*) count,ROUND(AVG(current_score),1) avg_score FROM topics GROUP BY category ORDER BY count DESC`).all();
  const { results: timeline = [] } = await env.DB.prepare(`
    SELECT substr(captured_at,1,13)||':00:00Z' t, ROUND(AVG(score),1) score, ROUND(AVG(breakout_score),1) breakout
    FROM topic_snapshots WHERE julianday(captured_at) >= julianday('now','-24 hours') GROUP BY t ORDER BY t
  `).all();
  return json({ generatedAt: new Date().toISOString(), topics: topics.map(t => ({ ...t, opportunities: safeJsonParse(t.ai_opportunities_json, []) || [] })), sources, categories, timeline });
}

async function topicDetail(env, id) {
  const topic = await env.DB.prepare(`SELECT * FROM topics WHERE id=?`).bind(id).first();
  if (!topic) return json({ error: 'not found' }, { status: 404 });
  const { results: sources = [] } = await env.DB.prepare(`SELECT source_id,title,url,rank,captured_at FROM topic_sources WHERE topic_id=? ORDER BY captured_at DESC LIMIT 50`).bind(id).all();
  const { results: snapshots = [] } = await env.DB.prepare(`SELECT captured_at,score,breakout_score,source_count,mention_count FROM topic_snapshots WHERE topic_id=? ORDER BY captured_at ASC LIMIT 96`).bind(id).all();
  return json({ ...topic, opportunities: safeJsonParse(topic.ai_opportunities_json, []) || [], sources, snapshots });
}

async function subscribe(env, request) {
  const body = await request.json();
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'invalid email' }, { status: 400 });
  const categories = Array.isArray(body.categories) && body.categories.length ? body.categories.slice(0, 12) : ['综合'];
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO subscribers(email,categories_json,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET active=1,categories_json=excluded.categories_json,updated_at=excluded.updated_at`)
    .bind(email, JSON.stringify(categories), now, now).run();
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
  if (url.pathname === '/api/dashboard' && request.method === 'GET') return dashboard(env, url);
  if (url.pathname.startsWith('/api/topic/') && request.method === 'GET') return topicDetail(env, decodeURIComponent(url.pathname.slice('/api/topic/'.length)));
  if (url.pathname === '/api/subscribe' && request.method === 'POST') return subscribe(env, request);
  if (url.pathname.startsWith('/api/ingest/') && request.method === 'POST') return externalIngest(env, request, decodeURIComponent(url.pathname.slice('/api/ingest/'.length)));
  if (url.pathname === '/api/admin/collect' && request.method === 'POST') {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    const openPreview = env.ALLOW_OPEN_COLLECT === '1';
    if (!openPreview && (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, { status: 401 });
    return json(await collectAll(env));
  }
  return json({ error: 'not found' }, { status: 404 });
}
