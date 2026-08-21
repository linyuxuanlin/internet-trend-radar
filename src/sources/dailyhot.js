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

function upstreamBases(env) {
  const configured = String(env.DAILYHOT_BASES || env.DAILYHOT_BASE || '').split(',').map(x => x.trim()).filter(Boolean);
  const defaults = ['https://api-hot.imsyy.top', 'https://api.guole.fun'];
  return [...new Set([...configured, ...defaults].map(x => x.replace(/\/$/, '')))];
}

async function fetchFromUpstream(base, sourceId) {
  const res = await fetch(`${base}/${encodeURIComponent(sourceId)}`, {
    headers: { 'user-agent': 'TrendRadarMVP/0.1 (+Cloudflare Workers)', accept: 'application/json' },
    cf: { cacheTtl: 60, cacheEverything: false },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  if (!list.length) throw new Error('empty real-data response');
  return { body, list };
}

export async function collectDailyHot(env, sourceId) {
  const errors = [];
  let body = null;
  let list = null;
  let upstream = null;

  for (const base of upstreamBases(env)) {
    try {
      ({ body, list } = await fetchFromUpstream(base, sourceId));
      upstream = base;
      break;
    } catch (err) {
      errors.push(`${base}: ${String(err?.message || err)}`);
    }
  }

  if (!list) throw new Error(`${sourceId}: all DailyHot upstreams failed (${errors.join('; ')})`);

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
      raw: { ...item, trendRadarUpstream: upstream }
    };
  }).filter(Boolean);
}
