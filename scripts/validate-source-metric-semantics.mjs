import { collectDailyHot } from '../src/sources/dailyhot.js';
import { metricMetadata } from '../src/source-metadata.js';

const originalFetch = globalThis.fetch;
try {
  let forceV2exFallback = false;
  globalThis.fetch = async url => {
    const href = String(url);
    if (href === 'https://www.v2ex.com/api/topics/hot.json') {
      if (forceV2exFallback) throw new Error('direct V2EX fixture unavailable');
      return new Response(JSON.stringify([
        { id: 1, title: 'V2EX semantic fixture', replies: 12, url: 'https://www.v2ex.com/t/1' }
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://api-hot.imsyy.top/v2ex') {
      return new Response(JSON.stringify({ data: [{ id: 11, title: 'V2EX fallback semantic fixture', score: 999, replies: 8, url: 'https://www.v2ex.com/t/11' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://generic.example/generic') {
      return new Response(JSON.stringify({ data: [{ id: 2, title: 'generic like fixture', data: { like: 99 } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://api.zhihu.com/topstory/hot-lists/total?limit=50') {
      return new Response(JSON.stringify({ data: [
        { target: { id: 4, title: 'Zhihu valid metric', url: 'https://www.zhihu.com/question/4' }, detail_text: '12 万热度' },
        { target: { id: 5, title: 'Zhihu missing metric', url: 'https://www.zhihu.com/question/5' }, detail_text: '暂无数据' }
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://alias.example/alias') {
      return new Response(JSON.stringify({ data: [{ id: 3, title: 'alias fixture', hot: 10, view: 100, engagement: 55, comments: 3, comment: 7 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://generic.example/baidu') {
      return new Response(JSON.stringify({ data: [{ id: 6, title: 'Baidu field contract', index: 1, score: 999, view: 888, hot_score: 123 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://generic.example/toutiao') {
      return new Response(JSON.stringify({ data: [{ id: 7, title: 'Toutiao field contract', rank: 1, score: 999, view: 888, HotValue: 456 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://generic.example/hupu') {
      return new Response(JSON.stringify({ data: [{ id: 8, title: 'Hupu field contract', rank: 1, score: 999, view: 888, hotValue: 321 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href.startsWith('https://api.bilibili.com/x/web-interface/ranking/region')) {
      return new Response(JSON.stringify({ code: 0, data: { list: [{ bvid: 'BVmetric', title: 'Bilibili metric fixture', stat: { view: 1000, like: 10, reply: 20, coin: 30, favorite: 40, share: 50, danmaku: 60 } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed') {
      return new Response(JSON.stringify({ data: [{ item_info: { article_info: { article_id: 'jmetric', title: 'Juejin metric fixture', view_count: 200, digg_count: 1, comment_count: 2, collect_count: 3, share_count: 4 } } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const [item] = await collectDailyHot({}, 'v2ex');
  if (!item || item.heat !== null) throw new Error(`V2EX heat must be null, got ${item?.heat}`);
  if (item.engagement !== 12) throw new Error(`V2EX engagement must equal replies, got ${item?.engagement}`);
  if (item.raw?.trendRadarUpstream !== 'https://www.v2ex.com/api/topics/hot.json') throw new Error('V2EX upstream missing');
  if (item.raw?.trendRadarMetrics?.heat_path !== null || item.raw?.trendRadarMetrics?.engagement_path !== 'topics[].replies') throw new Error('V2EX metric field provenance missing');
  forceV2exFallback = true;
  const [fallbackV2ex] = await collectDailyHot({}, 'v2ex');
  if (fallbackV2ex.heat !== null || fallbackV2ex.engagement !== 8 || fallbackV2ex.raw?.trendRadarMetrics?.heat_path !== null || fallbackV2ex.raw?.trendRadarMetrics?.engagement_path !== 'item.replies') {
    throw new Error(`V2EX generic fallback must keep heat NULL and use replies as engagement, got ${JSON.stringify(fallbackV2ex)}`);
  }
  forceV2exFallback = false;
  const [generic] = await collectDailyHot({ DAILYHOT_BASE: 'https://generic.example' }, 'generic');
  if (!generic || generic.heat !== null || generic.engagement !== 99) throw new Error(`generic like must be engagement only, got heat=${generic?.heat} engagement=${generic?.engagement}`);
  if (generic.raw?.trendRadarMetrics?.engagement_path !== 'item.data.like') throw new Error('generic engagement field provenance missing');
  const [alias] = await collectDailyHot({ DAILYHOT_BASE: 'https://alias.example' }, 'alias');
  if (!alias || alias.heat !== 10 || alias.engagement !== 55) throw new Error(`adapter engagement must take precedence, got heat=${alias?.heat} engagement=${alias?.engagement}`);
  if (alias.raw?.trendRadarMetrics?.heat_path !== 'item.hot' || alias.raw?.trendRadarMetrics?.engagement_path !== 'item.engagement') throw new Error('adapter metric selection provenance missing');
  const [baidu] = await collectDailyHot({ DAILYHOT_BASE: 'https://generic.example' }, 'baidu');
  if (baidu.heat !== 123 || baidu.raw?.trendRadarMetrics?.heat_path !== 'item.hot_score') throw new Error(`Baidu must use explicit hot_score and not rank/score/view, got ${JSON.stringify(baidu)}`);
  const [toutiao] = await collectDailyHot({ DAILYHOT_BASE: 'https://generic.example' }, 'toutiao');
  if (toutiao.heat !== 456 || toutiao.raw?.trendRadarMetrics?.heat_path !== 'item.HotValue') throw new Error(`Toutiao must use HotValue and not score/view, got ${JSON.stringify(toutiao)}`);
  const [hupu] = await collectDailyHot({ DAILYHOT_BASE: 'https://generic.example' }, 'hupu');
  if (hupu.heat !== 321 || hupu.raw?.trendRadarMetrics?.heat_path !== 'item.hotValue') throw new Error(`Hupu must use hotValue and not score/view, got ${JSON.stringify(hupu)}`);
  const zhihu = await collectDailyHot({}, 'zhihu');
  if (zhihu[0]?.heat !== 120000 || zhihu[1]?.heat !== null) throw new Error(`Zhihu missing displayed heat must stay null, got ${zhihu.map(item => item.heat).join(',')}`);
  const [bilibili] = await collectDailyHot({}, 'bilibili');
  if (bilibili.raw?.trendRadarMetrics?.heat_path !== 'data.list[].stat.view' || bilibili.raw?.trendRadarMetrics?.engagement_path !== 'stat.like+reply+coin+favorite+share+danmaku') throw new Error('Bilibili adapter metric provenance missing');
  const [juejin] = await collectDailyHot({}, 'juejin');
  if (juejin.raw?.trendRadarMetrics?.heat_path !== 'article_info.view_count' || juejin.raw?.trendRadarMetrics?.engagement_path !== 'digg_count+comment_count+collect_count+share_count') throw new Error('Juejin adapter metric provenance missing');
  for (const source of ['sspai', 'ithome', 'solidot']) {
    const definition = metricMetadata(source);
    if (definition.heat !== null || definition.engagement !== null) {
      throw new Error(`${source} RSS metrics must remain null`);
    }
  }
  for (const source of ['baidu', 'toutiao', 'hupu']) {
    const fallback = metricMetadata(source);
    const official = metricMetadata(source, source === 'toutiao' ? 'official-api' : 'official-page');
    const fallbackFields = fallback.heat.split('(')[0];
    if (/(^|[| ])(?:score|view|rank|index)(?:[| ]|$)/.test(fallbackFields)) {
      throw new Error(`${source} fallback metadata must exclude rank/score/view/index fields`);
    }
    if (!official.heat.includes('official') || official.heat === fallback.heat) {
      throw new Error(`${source} official-page metadata must be distinct from fallback metadata`);
    }
  }
  const douyin = metricMetadata('douyin');
  if (!Array.isArray(douyin.heat_paths) || !douyin.heat_paths.includes('word_list[].hot_value') || !douyin.heat_paths.includes('data[].hot')) {
    throw new Error('Douyin metric metadata must enumerate exact adapter heat paths');
  }
  for (const source of ['weibo', 'zhihu', 'bilibili', 'v2ex', 'juejin', '36kr', 'hackernews', 'github', 'xiaohongshu']) {
    const definition = metricMetadata(source);
    for (const metric of ['heat', 'engagement']) {
      if (definition[metric] !== null && (!Array.isArray(definition[`${metric}_paths`]) || !definition[`${metric}_paths`].length)) {
        throw new Error(`${source} ${metric} definition must expose an executable path allowlist`);
      }
    }
  }
  console.log('Source metric semantics validated: V2EX replies and generic likes are engagement only');
} finally {
  globalThis.fetch = originalFetch;
}
