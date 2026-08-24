-- Legacy rows predate trendRadarMetrics. Restore only documented adapter paths;
-- never infer or recompute a source-native counter.
UPDATE raw_items
   SET heat = NULL,
       engagement = NULL
 WHERE source_id = '36kr'
   AND json_extract(raw_json, '$.trendRadarUpstream') LIKE 'https://www.36kr.com/feed%';

UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'adapter item.hot <- data.realtime[].num')
 WHERE source_id = 'weibo' AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'adapter item.hot <- data[].detail_text (parsed)')
 WHERE source_id = 'zhihu' AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'word_list[].hot_value|hot|score (official or fallback)')
 WHERE source_id = 'douyin' AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'data.list[].stat.view')
 WHERE source_id = 'bilibili' AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'stat.like+reply+coin+favorite+share+danmaku')
 WHERE source_id = 'bilibili' AND engagement IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.engagement_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'topics[].replies')
 WHERE source_id = 'v2ex' AND engagement IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.engagement_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'article_info.view_count')
 WHERE source_id = 'juejin' AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'digg_count+comment_count+collect_count+share_count')
 WHERE source_id = 'juejin' AND engagement IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.engagement_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'templateMaterial.statRead')
 WHERE source_id = '36kr' AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'statCollect+statComment+statPraise')
 WHERE source_id = '36kr' AND engagement IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.engagement_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'upstream item.hot|hotValue|hot_value|hotness|heat|score|view|views|data.view')
 WHERE source_id IN ('baidu', 'toutiao', 'hupu') AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'upstream item.comments|comment|reply|data.reply|data.favorite|data.share|data.like')
 WHERE source_id IN ('baidu', 'toutiao', 'hupu') AND engagement IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.engagement_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'item.score')
 WHERE source_id = 'hackernews' AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'item.descendants')
 WHERE source_id = 'hackernews' AND engagement IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.engagement_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'repository.stargazers_count')
 WHERE source_id = 'github' AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'repository.forks_count')
 WHERE source_id = 'github' AND engagement IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.engagement_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.heat_path', 'noteCard.interactInfo.likedCount')
 WHERE source_id = 'xiaohongshu' AND heat IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.heat_path'))) = 0);
UPDATE raw_items SET raw_json = json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'likedCount+collectedCount+commentCount')
 WHERE source_id = 'xiaohongshu' AND engagement IS NOT NULL AND json_valid(raw_json) = 1
   AND (json_extract(raw_json, '$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(raw_json, '$.trendRadarMetrics.engagement_path'))) = 0);
