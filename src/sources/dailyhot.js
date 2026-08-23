import { categoryFor, fingerprintTitle, numberFromUnknown } from '../utils.js';

const SOURCE_NAMES = {
  weibo: '微博', zhihu: '知乎', bilibili: '哔哩哔哩', baidu: '百度', douyin: '抖音',
  toutiao: '今日头条', '36kr': '36氪', juejin: '稀土掘金', hupu: '虎扑', v2ex: 'V2EX'
};

function pickHeat(item) {
  const candidates = [item.hot, item.hotValue, item.hot_value, item.hotness, item.heat, item.score, item.view, item.views, item.data?.view, item.data?.like];
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

async function fetchResponse(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      accept: 'application/json,text/plain,*/*',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function fetchJson(url, options = {}) {
  const res = await fetchResponse(url, options);
  return { res, body: await res.json() };
}

function parseFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('JSON object missing');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('JSON object incomplete');
}

async function fetchLooseJson(url, options = {}) {
  const res = await fetchResponse(url, options);
  const text = await res.text();
  try {
    return { res, body: JSON.parse(text) };
  } catch {
    return { res, body: parseFirstJsonObject(text) };
  }
}

async function fetchFromUpstream(base, sourceId) {
  const { body } = await fetchJson(`${base}/${encodeURIComponent(sourceId)}`, {
    cf: { cacheTtl: 60, cacheEverything: false }
  });
  const list = Array.isArray(body?.data) ? body.data : [];
  if (!list.length) throw new Error('empty real-data response');
  return { body, list, upstream: base };
}

function mapDouyinRows(body, upstream) {
  const rows = Array.isArray(body?.data?.word_list)
    ? body.data.word_list
    : Array.isArray(body?.word_list)
      ? body.word_list
      : [];
  if (!rows.length) throw new Error('Douyin response empty');
  return {
    body: { title: '抖音' },
    upstream,
    list: rows.map((v, i) => ({
      id: v.sentence_id || v.word_id || `douyin-${i}`,
      title: v.word || v.sentence || v.title,
      hot: v.hot_value || v.hot || v.score,
      timestamp: v.event_time || v.timestamp,
      url: v.sentence_id ? `https://www.douyin.com/hot/${v.sentence_id}` : `https://www.douyin.com/search/${encodeURIComponent(v.word || v.sentence || v.title || '')}`
    }))
  };
}

function mapDouyinHotListRows(body, upstream) {
  const rows = Array.isArray(body?.data?.list) ? body.data.list : [];
  if (!rows.length) throw new Error('Douyin hot-list response empty');
  return {
    body: { title: '抖音' },
    upstream,
    list: rows.map((v, i) => ({
      id: v.id || v.sentence_id || v.url || `douyin-hot-list-${i}`,
      title: v.title || v.word || v.sentence,
      hot: v.hotness || v.hot_value || v.hot || v.score,
      timestamp: v.timestamp || v.event_time,
      url: v.url || (v.sentence_id ? `https://www.douyin.com/hot/${v.sentence_id}` : `https://www.douyin.com/search/${encodeURIComponent(v.title || v.word || v.sentence || '')}`)
    }))
  };
}

async function fetchDouyinDirect() {
  const errors = [];
  try {
    const cookieRes = await fetch('https://www.douyin.com/passport/general/login_guiding_strategy/?aid=6383', {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36' },
      signal: AbortSignal.timeout(12000)
    });
    if (!cookieRes.ok) throw new Error(`cookie HTTP ${cookieRes.status}`);
    const setCookie = cookieRes.headers.get('set-cookie') || '';
    const token = /passport_csrf_token=([^;]+)/.exec(setCookie)?.[1];
    if (!token) throw new Error('csrf cookie missing');
    const upstream = 'https://www.douyin.com/aweme/v1/web/hot/search/list/';
    const { body } = await fetchJson(`${upstream}?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1&source=6&main_billboard_count=50`, {
      headers: { cookie: `passport_csrf_token=${token}`, referer: 'https://www.douyin.com/' }
    });
    return mapDouyinRows(body, upstream);
  } catch (err) {
    errors.push(`official: ${String(err?.message || err)}`);
  }

  // AA1 mirrors the public Douyin hot-search payload and requires no API key.
  // It currently appends non-JSON bytes after a valid JSON object, so parse only
  // the first complete JSON object while preserving the real upstream payload.
  try {
    const upstream = 'https://v.api.aa1.cn/api/douyin-hot/index.php?aa1=hot';
    const { body } = await fetchLooseJson(upstream, { cf: { cacheTtl: 60, cacheEverything: false } });
    return mapDouyinRows(body, upstream);
  } catch (err) {
    errors.push(`aa1: ${String(err?.message || err)}`);
  }

  // Keep an independent no-key provider after AA1 so one mirror outage does not
  // silently drop Douyin from the real-data dashboard. This endpoint exposes
  // rank/title/hotness plus canonical douyin.com hot URLs.
  try {
    const upstream = 'https://api.luochen.sbs/API/hot_list.php?platform=douyin';
    const { body } = await fetchJson(upstream, { cf: { cacheTtl: 60, cacheEverything: false } });
    return mapDouyinHotListRows(body, upstream);
  } catch (err) {
    errors.push(`luochen: ${String(err?.message || err)}`);
  }

  throw new Error(errors.join('; '));
}

async function fetchDirect(sourceId) {
  if (sourceId === 'weibo') {
    const { body } = await fetchJson('https://weibo.com/ajax/side/hotSearch', {
      headers: { referer: 'https://weibo.com/' }
    });
    const rows = Array.isArray(body?.data?.realtime) ? body.data.realtime : [];
    if (!rows.length) throw new Error('Weibo direct response empty');
    return {
      body: { title: '微博' },
      upstream: 'https://weibo.com/ajax/side/hotSearch',
      list: rows.map((v, i) => ({
        id: v.mid || v.word_scheme || `weibo-${i}`,
        title: v.word || v.word_scheme,
        hot: v.num,
        timestamp: v.onboard_time,
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(v.word || v.word_scheme || '')}`
      }))
    };
  }

  if (sourceId === 'zhihu') {
    const { body } = await fetchJson('https://api.zhihu.com/topstory/hot-lists/total?limit=50');
    const rows = Array.isArray(body?.data) ? body.data : [];
    if (!rows.length) throw new Error('Zhihu direct response empty');
    return {
      body: { title: '知乎' },
      upstream: 'https://api.zhihu.com/topstory/hot-lists/total',
      list: rows.map((v, i) => {
        const target = v.target || {};
        const questionId = String(target.url || '').split('/').pop();
        return {
          id: target.id || `zhihu-${i}`,
          title: target.title,
          desc: target.excerpt,
          timestamp: target.created,
          hot: numberFromUnknown(String(v.detail_text || '').split(' ')[0]) * 10000,
          url: questionId ? `https://www.zhihu.com/question/${questionId}` : 'https://www.zhihu.com/hot'
        };
      })
    };
  }

  if (sourceId === 'douyin') return fetchDouyinDirect();

  throw new Error('no direct fallback');
}

export async function collectDailyHot(env, sourceId) {
  const errors = [];
  let body = null;
  let list = null;
  let upstream = null;

  for (const base of upstreamBases(env)) {
    try {
      ({ body, list, upstream } = await fetchFromUpstream(base, sourceId));
      break;
    } catch (err) {
      errors.push(`${base}: ${String(err?.message || err)}`);
    }
  }

  if (!list && ['weibo', 'zhihu', 'douyin'].includes(sourceId)) {
    try {
      ({ body, list, upstream } = await fetchDirect(sourceId));
    } catch (err) {
      errors.push(`direct: ${String(err?.message || err)}`);
    }
  }

  if (!list) throw new Error(`${sourceId}: all real upstreams failed (${errors.join('; ')})`);

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