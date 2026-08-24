import { categoryFor, fingerprintTitle, numberFromUnknown } from '../utils.js';
import { SOURCE_METRICS } from '../source-metadata.js';

const SOURCE_NAMES = {
  weibo: '微博', zhihu: '知乎', bilibili: '哔哩哔哩', baidu: '百度', douyin: '抖音',
  toutiao: '今日头条', '36kr': '36氪', juejin: '稀土掘金', hupu: '虎扑', v2ex: 'V2EX'
};

function metricOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !/-?\d/.test(value)) return null;
  const number = typeof value === 'number' ? value : numberFromUnknown(String(value));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function metricValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !/-?\d/.test(value)) return null;
  const number = typeof value === 'number' ? value : numberFromUnknown(String(value));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parsedMetricText(value) {
  const text = String(value ?? '').trim();
  if (!/-?\d/.test(text)) return null;
  return metricOrNull(numberFromUnknown(text));
}

function firstMetric(item, candidates) {
  for (const [path, value] of candidates) {
    const number = metricValue(value);
    if (number !== null) return { value: number, path };
  }
  return { value: null, path: null };
}

function firstMappedMetric(object, candidates) {
  for (const [key, path] of candidates) {
    const number = metricValue(object?.[key]);
    if (number !== null) return { value: number, path };
  }
  return { value: null, path: null };
}

// The shared DailyHot endpoint is an untrusted fallback.  Keep its field
// allowlist source-specific so a generic `score`, `view`, or ranking field is
// not silently promoted to heat for a source whose adapter did not document it.
const SOURCE_HEAT_PATHS = {
  baidu: new Set(['item.hotScore', 'item.hot_score', 'item.hot', 'item.hotValue', 'item.hot_value', 'item.hotness', 'item.heat']),
  toutiao: new Set(['item.HotValue', 'item.hot_value', 'item.hotValue', 'item.Heat', 'item.heat', 'item.hot', 'item.hotness']),
  hupu: new Set(['item.heat', 'item.hot', 'item.hotValue', 'item.hot_value', 'item.hotness'])
};

function pickMetrics(item, sourceId = '') {
  // Likes are engagement, not a heat/rank metric. The generic upstream does
  // not document whether similarly named fields are aliases or independent
  // counters, so choose one documented field by precedence instead of taking
  // a maximum or summing potentially duplicated values.
  const declared = item?._trendRadarMetricPaths || {};
  const heatCandidates = [
    ['item.HotValue', item.HotValue],
    ['item.hot', item.hot],
    ['item.hotValue', item.hotValue],
    ['item.hotScore', item.hotScore],
    ['item.hot_score', item.hot_score],
    ['item.hot_value', item.hot_value],
    ['item.hotness', item.hotness],
    ['item.Heat', item.Heat],
    ['item.heat', item.heat],
    ['item.score', item.score],
    ['item.view', item.view],
    ['item.views', item.views],
    ['item.data.view', item.data?.view]
  ];
  const engagementCandidates = [
    ['item.engagement', item.engagement],
    ['item.replies', item.replies],
    ['item.comments', item.comments],
    ['item.comment', item.comment],
    ['item.reply', item.reply],
    ['item.data.reply', item.data?.reply],
    ['item.data.favorite', item.data?.favorite],
    ['item.data.share', item.data?.share],
    ['item.data.like', item.data?.like]
  ];
  const definition = SOURCE_METRICS[sourceId] || {};
  const sourceHeatPaths = SOURCE_HEAT_PATHS[sourceId];
  const allowedHeatCandidates = definition.heat === null
    ? []
    : sourceHeatPaths ? heatCandidates.filter(([path]) => sourceHeatPaths.has(path)) : heatCandidates;
  const allowedEngagementCandidates = definition.engagement === null ? [] : engagementCandidates;
  if (declared.heat && definition.heat !== null && (!sourceHeatPaths || sourceHeatPaths.has(declared.heat))) {
    allowedHeatCandidates.unshift([declared.heat, item.hot]);
  }
  if (declared.engagement && definition.engagement !== null) allowedEngagementCandidates.unshift([declared.engagement, item.engagement]);
  const heat = firstMetric(item, allowedHeatCandidates);
  const engagement = firstMetric(item, allowedEngagementCandidates);
  return { heat, engagement };
}

function sumPresentMetrics(object, keys) {
  const values = keys
    .map(key => object?.[key])
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value >= 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function normalizePublishedAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const numeric = Number(text);
  const timestamp = Number.isFinite(numeric)
    ? numeric * (numeric < 1e12 ? 1000 : 1)
    : Date.parse(text);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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
  const upstream = `${base}/${encodeURIComponent(sourceId)}`;
  const { body } = await fetchJson(upstream, {
    cf: { cacheTtl: 60, cacheEverything: false }
  });
  const list = Array.isArray(body?.data) ? body.data : [];
  if (!list.length) throw new Error('empty real-data response');
  return { body, list, upstream };
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
    list: rows.map((v, i) => {
      const heat = firstMappedMetric(v, [['hot_value', 'word_list[].hot_value'], ['hot', 'word_list[].hot'], ['score', 'word_list[].score']]);
      return {
        id: v.sentence_id || v.word_id || `douyin-${i}`,
        title: v.word || v.sentence || v.title,
        hot: heat.value,
        timestamp: v.event_time || v.timestamp,
        url: v.sentence_id ? `https://www.douyin.com/hot/${v.sentence_id}` : `https://www.douyin.com/search/${encodeURIComponent(v.word || v.sentence || v.title || '')}`,
        _trendRadarMetricPaths: { heat: heat.path }
      };
    })
  };
}

function mapDouyinHotListRows(body, upstream) {
  const rows = Array.isArray(body?.data?.list) ? body.data.list : [];
  if (!rows.length) throw new Error('Douyin hot-list response empty');
  return {
    body: { title: '抖音' },
    upstream,
    list: rows.map((v, i) => {
      const heat = firstMappedMetric(v, [['hotness', 'data.list[].hotness'], ['hot_value', 'data.list[].hot_value'], ['hot', 'data.list[].hot'], ['score', 'data.list[].score']]);
      return {
        id: v.id || v.sentence_id || v.url || `douyin-hot-list-${i}`,
        title: v.title || v.word || v.sentence,
        hot: heat.value,
        timestamp: v.timestamp || v.event_time,
        url: v.url || (v.sentence_id ? `https://www.douyin.com/hot/${v.sentence_id}` : `https://www.douyin.com/search/${encodeURIComponent(v.title || v.word || v.sentence || '')}`),
        _trendRadarMetricPaths: { heat: heat.path }
      };
    })
  };
}

function mapDouyinFlatRows(body, upstream) {
  const rows = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.data?.list)
      ? body.data.list
      : Array.isArray(body?.list)
        ? body.list
        : [];
  if (!rows.length) throw new Error('Douyin flat-list response empty');
  return {
    body: { title: '抖音' },
    upstream,
    list: rows.map((v, i) => {
      const title = v.title || v.word || v.sentence || v.name || '';
      const heat = firstMappedMetric(v, [['hot', 'data[].hot'], ['hotness', 'data[].hotness'], ['hot_value', 'data[].hot_value'], ['score', 'data[].score']]);
      return {
        id: v.id || v.sentence_id || v.url || v.mobileUrl || v.mobilUrl || `douyin-flat-${i}`,
        title,
        hot: heat.value,
        timestamp: v.timestamp || v.event_time,
        url: v.url || v.mobileUrl || v.mobilUrl || `https://www.douyin.com/search/${encodeURIComponent(title)}`,
        _trendRadarMetricPaths: { heat: heat.path }
      };
    }).filter(v => String(v.title || '').trim())
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

  // Fanyia is an independent public hot-list API whose documented response is a
  // flat data array with title/hot/url. Keep it last so it only carries traffic
  // when the official path and both existing mirrors are unavailable.
  try {
    const upstream = 'https://api.fanyia.cn/api/douyin/dyhot';
    const { body } = await fetchJson(upstream, { cf: { cacheTtl: 60, cacheEverything: false } });
    return mapDouyinFlatRows(body, upstream);
  } catch (err) {
    errors.push(`fanyia: ${String(err?.message || err)}`);
  }

  throw new Error(errors.join('; '));
}

async function fetchDirect(sourceId) {
  if (sourceId === 'v2ex') {
    const upstream = 'https://www.v2ex.com/api/topics/hot.json';
    const { body } = await fetchJson(upstream);
    if (!Array.isArray(body) || !body.length) throw new Error('V2EX direct response empty');
    return {
      body: { title: 'V2EX' },
      upstream,
      list: body.map(item => ({
        id: item?.id,
        title: item?.title,
        url: item?.url || (item?.id ? `https://www.v2ex.com/t/${item.id}` : ''),
        // V2EX exposes reply count here, not an independent heat score.
        hot: null,
        engagement: item?.replies,
        _trendRadarMetricPaths: { heat: null, engagement: 'topics[].replies' },
        author: item?.member?.username
      }))
    };
  }

  if (sourceId === 'bilibili') {
    const endpoints = [
      'https://api.bilibili.com/x/web-interface/ranking/region?rid=1&day=3&original=0',
      'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
      'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1'
    ];
    let body;
    let upstream;
    let lastError;
    for (const endpoint of endpoints) {
      try {
        const result = await fetchJson(endpoint, { headers: { 'user-agent': 'qwq', referer: 'https://www.bilibili.com/' } });
        const rows = Array.isArray(result.body?.data?.list) ? result.body.data.list : result.body?.data;
        if (Number(result.body?.code) === 0 && Array.isArray(rows) && rows.length) {
          body = result.body;
          upstream = endpoint;
          body.data = { list: rows };
          break;
        }
        lastError = new Error(`code ${result.body?.code ?? 'unknown'}`);
      } catch (error) {
        lastError = error;
      }
    }
    if (!body) {
      throw new Error(`Bilibili direct response empty: ${String(lastError?.message || lastError || 'unknown error')}`);
    }
    return {
      body: { title: '哔哩哔哩' },
      upstream,
      list: body.data.list.map(item => ({
        id: item?.bvid,
        title: item?.title,
        url: item?.bvid ? `https://www.bilibili.com/video/${item.bvid}` : item?.short_link_v2,
        hot: item?.stat?.view,
        engagement: sumPresentMetrics(item?.stat, ['like', 'reply', 'coin', 'favorite', 'share', 'danmaku']),
        author: item?.owner?.name,
        _trendRadarMetricPaths: { heat: 'data.list[].stat.view', engagement: 'stat.like+reply+coin+favorite+share+danmaku' }
      }))
    };
  }

  if (sourceId === 'juejin') {
    const upstream = 'https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed';
    const { body } = await fetchJson(upstream, {
      method: 'POST',
      headers: {
        origin: 'https://juejin.cn',
        referer: 'https://juejin.cn/',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ id_type: 2, client_type: 2608, sort_type: 200, cursor: '0', limit: 20 })
    });
    const rows = Array.isArray(body?.data) ? body.data : [];
    const list = rows.map(row => {
      const item = row?.item_info || row?.item || row || {};
      const article = item?.article_info || row?.article_info || {};
      return {
        id: article?.article_id || item?.article_id || row?.article_id,
        title: article?.title || item?.title || row?.title,
        url: article?.article_id || item?.article_id || row?.article_id
          ? `https://juejin.cn/post/${article?.article_id || item?.article_id || row?.article_id}` : '',
        hot: article?.view_count ?? item?.view_count,
        engagement: sumPresentMetrics(
          Object.fromEntries(['digg_count', 'comment_count', 'collect_count', 'share_count']
            .map(key => [key, article?.[key] ?? item?.[key]])),
          ['digg_count', 'comment_count', 'collect_count', 'share_count']
        ),
        author: item?.author_user_info?.user_name || row?.author_user_info?.user_name,
        _trendRadarMetricPaths: { heat: 'article_info.view_count', engagement: 'digg_count+comment_count+collect_count+share_count' }
      };
    }).filter(row => row.id && row.title);
    if (!list.length) throw new Error(`Juejin direct response empty (err_no ${body?.err_no ?? 'unknown'})`);
    return { body: { title: '稀土掘金' }, upstream, list };
  }

  if (sourceId === '36kr') {
    const gateway = 'https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot';
    try {
      const { body } = await fetchJson(gateway, {
        method: 'POST',
        headers: { 'content-type': 'application/json', referer: 'https://www.36kr.com/' },
        body: JSON.stringify({ partner_id: 'web', param: { siteId: 1, platformId: 2 } })
      });
      const list = (Array.isArray(body?.data?.hotRankList) ? body.data.hotRankList : []).map(row => {
        const material = row?.templateMaterial || row || {};
        return {
          id: row?.itemId || material?.itemId,
          title: material?.widgetTitle || row?.title,
          url: row?.itemId ? `https://36kr.com/p/${row.itemId}` : '',
          hot: metricOrNull(material?.statRead),
          engagement: sumPresentMetrics(material, ['statCollect', 'statComment', 'statPraise']),
          author: material?.authorName,
          _trendRadarMetricPaths: { heat: 'templateMaterial.statRead', engagement: 'statCollect+statComment+statPraise' }
        };
      }).filter(row => row.id && row.title);
      if (list.length) return { body: { title: '36氪' }, upstream: gateway, list };
    } catch {}

    const endpoints = [
      'https://www.36kr.com/feed',
      'https://www.36kr.com/feed-article',
      'https://www.36kr.com/feed-newsflash',
      'https://www.36kr.com/feed-moment'
    ];
    const errors = [];
    for (const upstream of endpoints) {
      try {
        const res = await fetchResponse(upstream, {
          headers: {
            accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            referer: 'https://www.36kr.com/rss-center',
            'accept-encoding': 'identity'
          }
        });
        const xml = await res.text();
        const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
        const list = blocks.map((block, index) => {
          const value = tag => {
            const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
            return String(match?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').trim();
          };
          return { id: `${index}:${value('title')}`, title: value('title'), url: value('link'), desc: value('description') };
        }).filter(row => row.title);
        if (list.length) return { body: { title: '36氪' }, upstream, list };
        errors.push(`${upstream}: empty RSS`);
      } catch (error) {
        errors.push(`${upstream}: ${String(error?.message || error)}`);
      }
    }
    throw new Error(errors.join('; '));
  }

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
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(v.word || v.word_scheme || '')}`,
        _trendRadarMetricPaths: { heat: 'adapter item.hot <- data.realtime[].num' }
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
          hot: parsedMetricText(v.detail_text),
          url: questionId ? `https://www.zhihu.com/question/${questionId}` : 'https://www.zhihu.com/hot',
          _trendRadarMetricPaths: { heat: 'adapter item.hot <- data[].detail_text (parsed)' }
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
  const directCapable = ['weibo', 'zhihu', 'douyin', 'v2ex', 'bilibili', 'juejin', '36kr'].includes(sourceId);

  if (directCapable) {
    try {
      ({ body, list, upstream } = await fetchDirect(sourceId));
    } catch (err) {
      errors.push(`direct: ${String(err?.message || err)}`);
    }
  }

  for (const base of list ? [] : upstreamBases(env)) {
    try {
      ({ body, list, upstream } = await fetchFromUpstream(base, sourceId));
      break;
    } catch (err) {
      errors.push(`${base}: ${String(err?.message || err)}`);
    }
  }

  if (!list && directCapable) {
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
    const metrics = pickMetrics(item, sourceId);
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
      heat: metrics.heat.value,
      engagement: metrics.engagement.value,
      publishedAt: normalizePublishedAt(item.timestamp),
      capturedAt,
      fingerprint: fingerprintTitle(title),
    raw: {
        ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== '_trendRadarMetricPaths')),
        trendRadarUpstream: upstream,
        trendRadarMetrics: {
          heat_path: metrics.heat.path,
          engagement_path: metrics.engagement.path,
          selection: 'first documented candidate; aliases are not combined'
        }
      }
    };
  }).filter(Boolean);
}
