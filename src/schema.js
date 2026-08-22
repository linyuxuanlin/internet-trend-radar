const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'global',
  kind TEXT NOT NULL DEFAULT 'api',
  enabled INTEGER NOT NULL DEFAULT 1,
  weight REAL NOT NULL DEFAULT 1,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  last_item_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS raw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  author TEXT,
  category TEXT,
  language TEXT NOT NULL DEFAULT 'zh',
  rank INTEGER,
  heat REAL,
  engagement REAL,
  published_at TEXT,
  captured_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(source_id) REFERENCES sources(id)
);
CREATE INDEX IF NOT EXISTS idx_raw_items_captured ON raw_items(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_items_fingerprint ON raw_items(fingerprint, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_items_source ON raw_items(source_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  canonical_title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '综合',
  language TEXT NOT NULL DEFAULT 'zh',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  current_score REAL NOT NULL DEFAULT 0,
  breakout_score REAL NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 1,
  mention_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'new',
  ai_summary TEXT,
  ai_why_now TEXT,
  ai_opportunities_json TEXT,
  ai_risks TEXT,
  ai_updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_topics_score ON topics(current_score DESC);
CREATE INDEX IF NOT EXISTS idx_topics_breakout ON topics(breakout_score DESC);

CREATE TABLE IF NOT EXISTS topic_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  score REAL NOT NULL,
  breakout_score REAL NOT NULL,
  source_count INTEGER NOT NULL,
  mention_count INTEGER NOT NULL,
  FOREIGN KEY(topic_id) REFERENCES topics(id)
);
CREATE INDEX IF NOT EXISTS idx_topic_snapshots_topic_time ON topic_snapshots(topic_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS topic_sources (
  topic_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL,
  rank INTEGER,
  captured_at TEXT NOT NULL,
  PRIMARY KEY(topic_id, source_id, external_id, captured_at),
  FOREIGN KEY(topic_id) REFERENCES topics(id),
  FOREIGN KEY(source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  categories_json TEXT NOT NULL DEFAULT '["综合"]',
  min_score REAL NOT NULL DEFAULT 55,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_date TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sources(id,name,region,kind) VALUES
('weibo','微博','cn','aggregator'),
('zhihu','知乎','cn','aggregator'),
('bilibili','哔哩哔哩','cn','aggregator'),
('baidu','百度','cn','aggregator'),
('douyin','抖音','cn','aggregator'),
('toutiao','今日头条','cn','aggregator'),
('36kr','36氪','cn','aggregator'),
('juejin','稀土掘金','cn','aggregator'),
('hupu','虎扑','cn','aggregator'),
('v2ex','V2EX','cn','aggregator'),
('hackernews','Hacker News','global','official-api'),
('github','GitHub','global','official-api'),
('xiaohongshu','小红书','cn','external-bridge');
`;

const SCHEMA_STATEMENTS = SCHEMA_SQL
  .split(';')
  .map(statement => statement.trim())
  .filter(Boolean);

const schemaPromises = new WeakMap();

async function executeSchemaStatement(db, statement) {
  // Prefer D1's prepared-statement API for single static schema statements. This keeps
  // bootstrap on the same Worker Binding path used by normal queries.
  if (typeof db.prepare === 'function') {
    let prepared;
    try {
      prepared = db.prepare(statement);
    } catch (prepareError) {
      // Some deterministic test doubles intentionally only understand runtime SELECTs.
      // Real D1 supports static prepared statements, so only fall back when prepare itself
      // is unavailable for the statement. If run() fails, preserve that real D1 failure.
      if (typeof db.exec === 'function') return db.exec(`${statement};`);
      throw prepareError;
    }
    if (!prepared || typeof prepared.run !== 'function') {
      if (typeof db.exec === 'function') return db.exec(`${statement};`);
      throw new Error('D1 prepare() did not return a runnable statement');
    }
    return prepared.run();
  }

  if (typeof db.exec === 'function') return db.exec(`${statement};`);
  throw new Error('D1 binding exposes neither prepare().run() nor exec()');
}

async function bootstrapSchema(db) {
  const results = [];
  for (let index = 0; index < SCHEMA_STATEMENTS.length; index++) {
    const statement = SCHEMA_STATEMENTS[index];
    try {
      results.push(await executeSchemaStatement(db, statement));
    } catch (error) {
      const preview = statement.replace(/\s+/g, ' ').slice(0, 120);
      const message = String(error?.message || error);
      throw new Error(`D1 schema bootstrap failed at statement ${index + 1}/${SCHEMA_STATEMENTS.length} (${preview}): ${message}`, { cause: error });
    }
  }
  return { statementCount: SCHEMA_STATEMENTS.length, results };
}

export async function ensureSchema(env) {
  if (!env.DB) return { ok: false, reason: 'missing-db' };
  const db = env.DB;
  let promise = schemaPromises.get(db);
  if (!promise) {
    promise = bootstrapSchema(db)
      .then(result => ({ ok: true, result }))
      .catch(error => {
        schemaPromises.delete(db);
        throw error;
      });
    schemaPromises.set(db, promise);
  }
  return promise;
}
