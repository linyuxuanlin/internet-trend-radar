import { categoryFor, fingerprintTitle } from '../utils.js';

export async function collectHackerNews() {
  const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
  if (!idsRes.ok) throw new Error(`hackernews: HTTP ${idsRes.status}`);
  // Keep the scheduled collection below Workers' per-invocation subrequest
  // limit while leaving headroom for DailyHot fallbacks and GitHub Search.
  const ids = (await idsRes.json()).slice(0, 15);
  const rows = await Promise.all(ids.map(async (id, i) => {
    try {
      const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (!r.ok) return null;
      const item = await r.json();
      const title = String(item?.title || '').trim();
      if (!title) return null;
      return {
        sourceId: 'hackernews', sourceName: 'Hacker News', externalId: String(id), title,
        url: item.url || `https://news.ycombinator.com/item?id=${id}`,
        author: item.by || '', category: categoryFor('hackernews', title), language: 'en', rank: i + 1,
        heat: item.score === null || item.score === undefined ? null : Number(item.score),
        engagement: item.descendants === null || item.descendants === undefined ? null : Number(item.descendants),
        publishedAt: item.time ? new Date(item.time * 1000).toISOString() : null,
        capturedAt: new Date().toISOString(), fingerprint: fingerprintTitle(title),
        raw: {
          trendRadarUpstream: 'https://hacker-news.firebaseio.com/v0/item/' + id + '.json',
          trendRadarMetrics: { heat_path: 'item.score', engagement_path: 'item.descendants', selection: 'official item fields' },
          item
        }
      };
    } catch { return null; }
  }));
  return rows.filter(Boolean);
}
