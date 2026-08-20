import { collectDailyHot } from './sources/dailyhot.js';
import { collectHackerNews } from './sources/hackernews.js';
import { collectGitHub } from './sources/github.js';
import { rebuildTopics } from './scoring.js';
import { enrichTopTopics } from './ai.js';

async function markSource(env, id, ok, count = 0, error = '') {
  if (ok) {
    await env.DB.prepare(`UPDATE sources SET last_success_at=?,last_item_count=?,last_error=NULL WHERE id=?`)
      .bind(new Date().toISOString(), count, id).run();
  } else {
    await env.DB.prepare(`UPDATE sources SET last_error_at=?,last_error=? WHERE id=?`)
      .bind(new Date().toISOString(), String(error).slice(0,500), id).run();
  }
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function persist(env, items) {
  const statements = items.map(item => env.DB.prepare(`
    INSERT INTO raw_items(source_id,external_id,title,url,author,category,language,rank,heat,engagement,published_at,captured_at,fingerprint,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(item.sourceId,item.externalId,item.title,item.url || '',item.author || '',item.category || '综合',item.language || 'zh',item.rank || null,item.heat || 0,item.engagement || 0,item.publishedAt,item.capturedAt,item.fingerprint,JSON.stringify(item.raw || {})));
  for (const group of chunks(statements, 80)) await env.DB.batch(group);
}

function collectionFailure(summary) {
  const failed = summary.filter(x => !x.ok);
  const detail = failed.slice(0, 6).map(x => `${x.sourceId}: ${x.error || 'no items'}`).join('; ');
  return new Error(`collection produced no real items${detail ? ` (${detail})` : ''}`);
}

export async function collectAll(env) {
  if (!env.DB) throw new Error('missing DB binding');

  const sourceIds = String(env.COLLECTOR_SOURCES || 'weibo,zhihu,bilibili,baidu,douyin,toutiao,36kr,juejin,hupu,v2ex')
    .split(',').map(x => x.trim()).filter(Boolean);
  const summary = [];

  for (const sourceId of sourceIds) {
    try {
      const items = await collectDailyHot(env, sourceId);
      await persist(env, items);
      await markSource(env, sourceId, true, items.length);
      summary.push({ sourceId, ok: true, count: items.length });
    } catch (e) {
      await markSource(env, sourceId, false, 0, e?.message || e);
      summary.push({ sourceId, ok: false, error: String(e?.message || e) });
    }
  }

  for (const [id, fn] of [['hackernews', collectHackerNews], ['github', collectGitHub]]) {
    try {
      const items = await fn(env);
      await persist(env, items);
      await markSource(env, id, true, items.length);
      summary.push({ sourceId: id, ok: true, count: items.length });
    } catch (e) {
      await markSource(env, id, false, 0, e?.message || e);
      summary.push({ sourceId: id, ok: false, error: String(e?.message || e) });
    }
  }

  const realItemCount = summary.reduce((sum, x) => sum + (x.ok ? Number(x.count || 0) : 0), 0);
  if (realItemCount <= 0) throw collectionFailure(summary);

  const topics = await rebuildTopics(env.DB, 24);
  if (topics <= 0) {
    throw new Error(`collection stored ${realItemCount} real items but produced 0 topics`);
  }

  const ai = await enrichTopTopics(env);
  return {
    ok: true,
    realItemCount,
    healthySources: summary.filter(x => x.ok && Number(x.count || 0) > 0).length,
    failedSources: summary.filter(x => !x.ok).length,
    summary,
    topics,
    ai,
    at: new Date().toISOString()
  };
}

export async function ingestExternal(env, sourceId, items) {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  await env.DB.prepare(`INSERT OR IGNORE INTO sources(id,name,region,kind) VALUES(?,?,?,?)`)
    .bind(sourceId, sourceId, 'unknown', 'external-bridge').run();
  const normalized = items.slice(0, 200).map((x, i) => ({
    sourceId,
    externalId: String(x.externalId || x.id || x.url || `${i}:${x.title}`),
    title: String(x.title || '').trim(), url: x.url || '', author: x.author || '',
    category: x.category || '综合', language: x.language || 'zh', rank: Number(x.rank || i + 1),
    heat: Number(x.heat || 0), engagement: Number(x.engagement || 0), publishedAt: x.publishedAt || null,
    capturedAt: x.capturedAt || new Date().toISOString(), fingerprint: x.fingerprint,
    raw: x.raw || x
  })).filter(x => x.title && x.fingerprint);
  await persist(env, normalized);
  await markSource(env, sourceId, true, normalized.length);
  await rebuildTopics(env.DB, 24);
  return normalized.length;
}
