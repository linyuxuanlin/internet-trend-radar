import { clamp, scoreItem, topicStatus } from './utils.js';

export async function rebuildTopics(db, windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const { results = [] } = await db.prepare(`
    SELECT fingerprint,
           MIN(title) AS canonical_title,
           MIN(category) AS category,
           MIN(language) AS language,
           MIN(captured_at) AS first_seen,
           MAX(captured_at) AS last_seen,
           COUNT(*) AS mentions,
           COUNT(DISTINCT source_id) AS source_count,
           MIN(COALESCE(rank, 100)) AS best_rank,
           MAX(COALESCE(heat, 0)) AS max_heat,
           MAX(COALESCE(engagement, 0)) AS max_engagement
    FROM raw_items
    WHERE captured_at >= ?
    GROUP BY fingerprint
    ORDER BY source_count DESC, mentions DESC
    LIMIT 500
  `).bind(since).all();

  let updated = 0;
  for (const row of results) {
    const base = scoreItem(row.best_rank, 50, row.max_heat, row.max_engagement);
    const crossPlatform = clamp(Math.log2(Math.max(1, row.source_count)) * 10, 0, 25);
    const persistence = clamp(Math.log2(Math.max(1, row.mentions)) * 3, 0, 12);
    const score = clamp(base * 0.82 + crossPlatform + persistence);

    const previous = await db.prepare(`
      SELECT score, source_count, mention_count FROM topic_snapshots
      WHERE topic_id = ? ORDER BY captured_at DESC LIMIT 1
    `).bind(row.fingerprint).first();

    const scoreDelta = previous ? score - Number(previous.score || 0) : 0;
    const sourceDelta = previous ? Number(row.source_count) - Number(previous.source_count || 0) : 0;
    const mentionDelta = previous ? Number(row.mentions) - Number(previous.mention_count || 0) : 0;
    const freshnessHours = Math.max(0, (Date.now() - new Date(row.first_seen).getTime()) / 3600000);
    const novelty = clamp(30 - freshnessHours * 1.5, 0, 30);
    const breakout = clamp(42 + scoreDelta * 2.4 + sourceDelta * 13 + Math.log2(Math.max(1, mentionDelta + 1)) * 7 + novelty * 0.65);
    const status = topicStatus(score, breakout);

    await db.prepare(`
      INSERT INTO topics(id,fingerprint,canonical_title,category,language,first_seen_at,last_seen_at,current_score,breakout_score,source_count,mention_count,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        canonical_title=excluded.canonical_title,
        category=excluded.category,
        last_seen_at=excluded.last_seen_at,
        current_score=excluded.current_score,
        breakout_score=excluded.breakout_score,
        source_count=excluded.source_count,
        mention_count=excluded.mention_count,
        status=excluded.status
    `).bind(row.fingerprint,row.fingerprint,row.canonical_title,row.category || '综合',row.language || 'zh',row.first_seen,row.last_seen,score,breakout,row.source_count,row.mentions,status).run();

    await db.prepare(`INSERT INTO topic_snapshots(topic_id,captured_at,score,breakout_score,source_count,mention_count) VALUES(?,?,?,?,?,?)`)
      .bind(row.fingerprint, new Date().toISOString(), score, breakout, row.source_count, row.mentions).run();

    await db.prepare(`
      INSERT OR IGNORE INTO topic_sources(topic_id,source_id,external_id,url,title,rank,captured_at)
      SELECT ?, source_id, external_id, url, title, rank, captured_at
      FROM raw_items
      WHERE fingerprint=? AND captured_at>=?
    `).bind(row.fingerprint,row.fingerprint,since).run();
    updated++;
  }
  return updated;
}
