import { clamp, scoreFromNormalizedComponents, topicStatus } from './utils.js';
import { currentSourcePredicate } from './source-health.js';

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function rebuildTopics(db, windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const { results = [] } = await db.prepare(`
    WITH recent AS (
      SELECT raw_items.*,
             MAX(CASE WHEN rank > 0 THEN rank ELSE 0 END) OVER (PARTITION BY source_id) AS source_total
       FROM raw_items
       JOIN sources active_source ON active_source.id = raw_items.source_id
        AND ${currentSourcePredicate('active_source')}
       WHERE captured_at >= ?
    ), ranked AS (
      SELECT recent.*,
             CASE WHEN source_total > 1 AND rank > 0
                  THEN 100 - ((rank - 1.0) / (source_total - 1.0)) * 70
                  ELSE 30 END AS rank_score,
             heat_rank.heat_percentile,
             engagement_rank.engagement_percentile
        FROM recent
        LEFT JOIN (
          SELECT id,
                 percent_rank() OVER (PARTITION BY source_id ORDER BY heat) AS heat_percentile
            FROM recent
           WHERE heat IS NOT NULL
        ) heat_rank ON heat_rank.id = recent.id
        LEFT JOIN (
          SELECT id,
                 percent_rank() OVER (PARTITION BY source_id ORDER BY engagement) AS engagement_percentile
            FROM recent
           WHERE engagement IS NOT NULL
        ) engagement_rank ON engagement_rank.id = recent.id
    )
    SELECT r.fingerprint,
           MIN(title) AS canonical_title,
           MIN(category) AS category,
           MIN(language) AS language,
           MIN(captured_at) AS first_seen,
           MAX(captured_at) AS last_seen,
           COUNT(*) AS mentions,
           COUNT(DISTINCT r.source_id) AS source_count,
           AVG(COALESCE(s.weight, 1)) AS source_weight,
           MIN(COALESCE(r.rank, 100)) AS best_rank,
           AVG(r.rank_score) AS rank_score,
           AVG(r.heat_percentile) AS heat_percentile,
           AVG(r.engagement_percentile) AS engagement_percentile,
           MAX(r.heat) AS max_heat,
           MAX(r.engagement) AS max_engagement
    FROM ranked r
    LEFT JOIN sources s ON s.id = r.source_id
    GROUP BY fingerprint
    ORDER BY source_count DESC, mentions DESC, max_heat DESC, max_engagement DESC
    LIMIT 1000
  `).bind(since).all();

  const { results: previousRows = [] } = await db.prepare(`
    SELECT s.topic_id,s.score,s.source_count,s.mention_count
    FROM topic_snapshots s
    JOIN (
      SELECT topic_id,MAX(id) max_id FROM topic_snapshots GROUP BY topic_id
    ) latest ON latest.max_id=s.id
  `).all();
  const previousByTopic = new Map(previousRows.map(x => [x.topic_id, x]));
  const now = new Date().toISOString();
  const statements = [];

  for (const row of results) {
    const base = scoreFromNormalizedComponents(row.rank_score, row.heat_percentile, row.engagement_percentile);
    const crossPlatform = clamp(Math.log2(Math.max(1, row.source_count)) * 10, 0, 25);
    const persistence = clamp(Math.log2(Math.max(1, row.mentions)) * 3, 0, 12);
    const sourceWeight = clamp(Number(row.source_weight || 1), 0.25, 1.25);
    const score = clamp(base * 0.82 * sourceWeight + crossPlatform + persistence);
    const previous = previousByTopic.get(row.fingerprint);
    const scoreDelta = previous ? score - Number(previous.score || 0) : 0;
    const sourceDelta = previous ? Number(row.source_count) - Number(previous.source_count || 0) : 0;
    const mentionDelta = previous ? Number(row.mentions) - Number(previous.mention_count || 0) : 0;
    const freshnessHours = Math.max(0, (Date.now() - new Date(row.first_seen).getTime()) / 3600000);
    const novelty = clamp(30 - freshnessHours * 1.5, 0, 30);
    const breakout = clamp(42 + scoreDelta * 2.4 + sourceDelta * 13 + Math.log2(Math.max(1, mentionDelta + 1)) * 7 + novelty * 0.65);
    const status = topicStatus(score, breakout);

    statements.push(db.prepare(`
      INSERT INTO topics(id,fingerprint,canonical_title,category,language,first_seen_at,last_seen_at,current_score,breakout_score,source_count,mention_count,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET canonical_title=excluded.canonical_title,category=excluded.category,last_seen_at=excluded.last_seen_at,
        current_score=excluded.current_score,breakout_score=excluded.breakout_score,source_count=excluded.source_count,mention_count=excluded.mention_count,status=excluded.status
    `).bind(row.fingerprint,row.fingerprint,row.canonical_title,row.category || '综合',row.language || 'zh',row.first_seen,row.last_seen,score,breakout,row.source_count,row.mentions,status));
    statements.push(db.prepare(`INSERT INTO topic_snapshots(topic_id,captured_at,score,breakout_score,source_count,mention_count) VALUES(?,?,?,?,?,?)`)
      .bind(row.fingerprint, now, score, breakout, row.source_count, row.mentions));
  }

  for (const group of chunks(statements, 80)) await db.batch(group);
  if (results.length) {
    await db.prepare(`
      INSERT OR IGNORE INTO topic_sources(topic_id,source_id,external_id,url,title,rank,captured_at)
      SELECT r.fingerprint,r.source_id,r.external_id,r.url,r.title,r.rank,r.captured_at
        FROM raw_items r
        JOIN sources active_source ON active_source.id = r.source_id
         AND ${currentSourcePredicate('active_source')}
        JOIN topics t ON t.id = r.fingerprint
       WHERE r.captured_at>=?
    `).bind(since).run();
  }
  return results.length;
}
