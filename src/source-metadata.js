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
  baidu: { heat: 'upstream item.hot|hotValue|hot_value|hotness|heat|score|view|views|data.view', engagement: 'upstream item.comments|comment|reply|data.reply|data.favorite|data.share|data.like', note: 'generic adapter mapping; disabled when upstream is unavailable' },
  toutiao: { heat: 'upstream item.hot|hotValue|hot_value|hotness|heat|score|view|views|data.view', engagement: 'upstream item.comments|comment|reply|data.reply|data.favorite|data.share|data.like', note: 'generic adapter mapping' },
  hupu: { heat: 'upstream item.hot|hotValue|hot_value|hotness|heat|score|view|views|data.view', engagement: 'upstream item.comments|comment|reply|data.reply|data.favorite|data.share|data.like', note: 'generic adapter mapping' },
  ithome: { heat: null, engagement: null, note: 'official RSS feed; publication feed does not expose a native heat or engagement counter' },
  solidot: { heat: null, engagement: null, note: 'official RSS feed; publication feed does not expose a native heat or engagement counter' },
  hackernews: { heat: 'item.score', engagement: 'item.descendants', note: 'official Firebase item API' },
  github: { heat: 'repository.stargazers_count', engagement: 'repository.forks_count', note: 'official GitHub Search API; repositories created since the UTC lookback date, sorted by stars; not GitHub Trending' },
  xiaohongshu: { heat: 'noteCard.interactInfo.likedCount', engagement: 'likedCount+collectedCount+commentCount', note: 'external xiaohongshu-mcp bridge' }
};

export function metricMetadata(sourceId) {
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
