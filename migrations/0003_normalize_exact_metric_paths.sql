-- Some legacy rows had a generic wrapper path (item.hot/item.engagement)
-- even though the adapter had already computed a documented native metric.
-- Normalize only sources whose adapter path is exact and stable.
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.heat_path', 'adapter item.hot <- data.realtime[].num')
 WHERE source_id='weibo' AND heat IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.heat_path', 'adapter item.hot <- data[].detail_text (parsed)')
 WHERE source_id='zhihu' AND heat IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.heat_path', 'word_list[].hot_value|hot|score (official or fallback)')
 WHERE source_id='douyin' AND heat IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.heat_path', 'data.list[].stat.view')
 WHERE source_id='bilibili' AND heat IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'stat.like+reply+coin+favorite+share+danmaku')
 WHERE source_id='bilibili' AND engagement IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'topics[].replies')
 WHERE source_id='v2ex' AND engagement IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.heat_path', 'article_info.view_count')
 WHERE source_id='juejin' AND heat IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'digg_count+comment_count+collect_count+share_count')
 WHERE source_id='juejin' AND engagement IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.heat_path', 'templateMaterial.statRead')
 WHERE source_id='36kr' AND heat IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'statCollect+statComment+statPraise')
 WHERE source_id='36kr' AND engagement IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.heat_path', 'item.score')
 WHERE source_id='hackernews' AND heat IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'item.descendants')
 WHERE source_id='hackernews' AND engagement IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.heat_path', 'repository.stargazers_count')
 WHERE source_id='github' AND heat IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'repository.forks_count')
 WHERE source_id='github' AND engagement IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.heat_path', 'noteCard.interactInfo.likedCount')
 WHERE source_id='xiaohongshu' AND heat IS NOT NULL AND json_valid(raw_json)=1;
UPDATE raw_items SET raw_json=json_set(raw_json, '$.trendRadarMetrics.engagement_path', 'likedCount+collectedCount+commentCount')
 WHERE source_id='xiaohongshu' AND engagement IS NOT NULL AND json_valid(raw_json)=1;
