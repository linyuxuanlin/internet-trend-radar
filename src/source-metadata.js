// These definitions describe the upstream fields used by each adapter. They
// are documentation-as-data and are exposed by the diagnostics/dashboard API.
export const SOURCE_METRICS = {
  weibo: { heat: 'adapter item.hot <- data.realtime[].num', engagement: null, note: 'official hot-search count' },
  zhihu: { heat: 'adapter item.hot <- data[].detail_text (parsed)', engagement: null, note: 'official displayed heat text' },
  douyin: { heat: 'word_list[].hot_value|hot|score (official or fallback)', engagement: null, note: 'source-native hot-list value' },
  sspai: { heat: null, engagement: null, note: 'official RSS feed; publication feed does not expose a native heat or engagement counter' },
  bilibili: { heat: 'data.list[].stat.view', engagement: 'stat.like+reply+coin+favorite+share+danmaku', note: 'official video statistics' },
  v2ex: { heat: null, engagement: 'topics[].replies', note: 'official hot-topics API; replies are interaction count, not heat' },
  juejin: { heat: 'article_info.view_count', engagement: 'digg_count+comment_count+collect_count+share_count', note: 'official recommendation API' },
  '36kr': { heat: 'templateMaterial.statRead', engagement: 'statCollect+statComment+statPraise', note: 'official Gateway hot-rank API; RSS fallback may omit metrics' },
  baidu: { heat: 'fallback item.hotScore|item.hot_score|item.hot|item.hotValue|item.hot_value|item.hotness|item.heat (NULL when absent; score/view/index excluded)', heat_paths: ['item.hotScore', 'item.hot_score', 'item.hot', 'item.hotValue', 'item.hot_value', 'item.hotness', 'item.heat'], engagement: null, note: 'shared fallback contract; ranking/index/score/view fields are not promoted to heat' },
  toutiao: { heat: 'fallback item.HotValue|item.hot_value|item.hotValue|item.Heat|item.heat|item.hot|item.hotness (score/view excluded)', heat_paths: ['item.HotValue', 'item.hot_value', 'item.hotValue', 'item.Heat', 'item.heat', 'item.hot', 'item.hotness'], engagement: null, note: 'shared fallback contract; no engagement counter is inferred' },
  hupu: { heat: 'fallback item.heat|item.hot|item.hotValue|item.hot_value|item.hotness (score/view/rank excluded)', heat_paths: ['item.heat', 'item.hot', 'item.hotValue', 'item.hot_value', 'item.hotness'], engagement: null, note: 'shared fallback contract; rank and tag identifiers are not heat' },
  ithome: { heat: null, engagement: null, note: 'official RSS feed; publication feed does not expose a native heat or engagement counter' },
  solidot: { heat: null, engagement: null, note: 'official RSS feed; publication feed does not expose a native heat or engagement counter' },
  hackernews: { heat: 'item.score', engagement: 'item.descendants', note: 'official Firebase item API' },
  github: { heat: 'repository.stargazers_count', engagement: 'repository.forks_count', note: 'official GitHub Search API; repositories created since the UTC lookback date, sorted by stars; not GitHub Trending' },
  xiaohongshu: { heat: 'noteCard.interactInfo.likedCount', engagement: 'likedCount+collectedCount+commentCount', note: 'external xiaohongshu-mcp bridge' }
};

const STATIC_SOURCE_METRICS = {
  baidu: { heat: 'official page item.hotScore|item.hot_score (NULL when absent; item.index is rank, never heat)', heat_paths: ['item.hotScore', 'item.hot_score'], engagement: null, note: 'official Baidu hot-board page; ranking/index fields are not promoted to heat' },
  toutiao: { heat: 'official board item.HotValue|item.hot_value|item.hotValue|item.Heat|item.heat', heat_paths: ['item.HotValue', 'item.hot_value', 'item.hotValue', 'item.Heat', 'item.heat'], engagement: null, note: 'official Toutiao hot-board value; no engagement counter is inferred' },
  hupu: { heat: 'official page item.heat|item.hot|item.hotValue', heat_paths: ['item.heat', 'item.hot', 'item.hotValue'], engagement: null, note: 'official Hupu hot-page value; rank and tag identifiers are not heat' }
};

export function metricMetadata(sourceId, kind = null) {
  if (['official-page', 'official-api'].includes(kind) && STATIC_SOURCE_METRICS[sourceId]) return STATIC_SOURCE_METRICS[sourceId];
  return SOURCE_METRICS[sourceId] || {
    heat: 'adapter-defined source-native field',
    engagement: null,
    note: 'metric definition unavailable'
  };
}

// Exact adapter paths are enforceable only for the corresponding official
// endpoint. Mirrors can expose the same source with a different payload shape;
// their actual path remains required, but must not be labeled as official.
export function officialMetricUpstreamPredicate(sourceExpr = 's.id', upstreamExpr = "json_extract(r.raw_json,'$.trendRadarUpstream')") {
  return `(
    (${sourceExpr}='weibo' AND ${upstreamExpr} LIKE 'https://weibo.com/ajax/side/hotSearch%')
    OR (${sourceExpr}='zhihu' AND ${upstreamExpr} LIKE 'https://api.zhihu.com/topstory/hot-lists/total%')
    OR (${sourceExpr}='douyin' AND ${upstreamExpr} LIKE 'https://www.douyin.com/%')
    OR (${sourceExpr}='bilibili' AND ${upstreamExpr} LIKE 'https://api.bilibili.com/%')
    OR (${sourceExpr}='v2ex' AND ${upstreamExpr} LIKE 'https://www.v2ex.com/api/topics/hot.json%')
    OR (${sourceExpr}='juejin' AND ${upstreamExpr} LIKE 'https://api.juejin.cn/%')
    OR (${sourceExpr}='36kr' AND ${upstreamExpr} LIKE 'https://gateway.36kr.com/%')
    OR (${sourceExpr}='hackernews' AND ${upstreamExpr} LIKE 'https://hacker-news.firebaseio.com/%')
    OR (${sourceExpr}='github' AND ${upstreamExpr} LIKE 'https://api.github.com/%')
    OR (${sourceExpr}='xiaohongshu' AND ${upstreamExpr} LIKE 'xiaohongshu-mcp:%')
  )`;
}
