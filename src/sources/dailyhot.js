import { categoryFor, fingerprintTitle, numberFromUnknown } from '../utils.js';

const SOURCE_NAMES = {
  weibo: '微博', zhihu: '知乎', bilibili: '哔哩哔哩', baidu: '百度', douyin: '抖音',
  toutiao: '今日头条', '36kr': '36氪', juejin: '稀土掘金', hupu: '虎扑', v2ex: 'V2EX'
};

function pickHeat(item) {
  const candidates = [item.hot, item.hotValue, item.heat, item.score, item.view, item.views, item.data?.view, item.data?.like];
  return Math.max(0, ...candidates.map(numberFromUnknown));
}

function pickEngagement(item) {
  const values = [item.comments, item.comment, item.reply, item.data?.reply, item.data?.favorite, item.data?.share, item.data?.like]
    .map(numberFromUnknown).filter(Boolean);
  return values.reduce((a, b) => a + b, 0);
}

export async function collectDailyHot(env, sourceId) {
  const base = (env.DAILYHOT_BASE || 'https://api-hot.imsyy.top').replace(/\/$/, '');
  const res = await fetch(`${base}/${encodeURIComponent(sourceId)}`, {
    headers: { 'user-agent': 'TrendRadarMVP/0.1 (+Cloudflare Workers)' },
    cf: { cacheTtl: 60, cacheEverything: false }
  });
  if (!res.ok) throw new Error(`${sourceId}: HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  const capturedAt = new Date().toISOString();
  return list.slice(0, 50).map((item, i) => {
    const title = String(item.title || item.name || item.word || item.desc || '').trim();
    if (!title) return null;
    const url = item.url || item.mobileUrl || item.link || '';
    return {
      sourceId,
      sourceName: SOURCE_NAMES[sourceId] || body.title || sourceId,
      externalId: String(item.id || item.url || item.mobileUrl || `${i + 1}:${title}`),
      title,
      url,
      author: item.author?.name || item.owner?.name || item.author || '',
      category: categoryFor(sourceId, title),
      language: 'zh',
      rank: i + 1,
      heat: pickHeat(item),
      engagement: pickEngagement(item),
      publishedAt: item.timestamp ? new Date(Number(item.timestamp) * (Number(item.timestamp) < 1e12 ? 1000 : 1)).toISOString() : null,
      capturedAt,
      fingerprint: fingerprintTitle(title),
      raw: item
    };
  }).filter(Boolean);
}
