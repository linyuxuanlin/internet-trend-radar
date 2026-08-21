import worker from '../src/index.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function parse(response) {
  const body = await response.json();
  return { status: response.status, body };
}

const missingBinding = await parse(await worker.fetch(new Request('https://example.test/api/debug'), {}));
assert(missingBinding.status === 200, `missing DB debug status=${missingBinding.status}`);
assert(missingBinding.body.db === false, 'missing DB binding must be reported');
assert(missingBinding.body.schema?.error === 'missing DB binding', 'missing DB schema error must be explicit');

const missingTablesDB = {
  prepare(sql) {
    if (!sql.includes('sqlite_master')) throw new Error(`unexpected query before schema readiness: ${sql}`);
    return {
      bind() { return this; },
      async all() { return { results: [{ name: 'sources' }, { name: 'topics' }] }; }
    };
  }
};
const missingTables = await parse(await worker.fetch(new Request('https://example.test/api/debug'), { DB: missingTablesDB }));
assert(missingTables.status === 200, `missing tables debug status=${missingTables.status}`);
assert(missingTables.body.db === true, 'DB binding should be visible');
assert(missingTables.body.schema?.ok === false, 'partial schema must not report healthy');
assert(String(missingTables.body.schema?.error || '').includes('missing tables:'), 'missing tables must be named');
assert(missingTables.body.schema.tables.sources === true, 'present table should be reported true');
assert(missingTables.body.schema.tables.raw_items === false, 'missing table should be reported false');

const health = await parse(await worker.fetch(new Request('https://example.test/api/health'), {}));
assert(health.status === 200 && health.body.ok === true, 'health must remain reachable without D1');

// A freshly provisioned D1 must be schema-bootstrapped before the dashboard performs
// its first topics readiness query. This regression test proves the bootstrap order and
// verifies that a healthy D1 result wins without requiring any synthetic fallback.
let schemaReady = false;
let schemaExecCount = 0;
const freshD1 = {
  async exec(sql) {
    assert(sql.includes('CREATE TABLE IF NOT EXISTS topics'), 'schema bootstrap must create topics');
    schemaReady = true;
    schemaExecCount++;
    return { count: 1 };
  },
  prepare(sql) {
    if (sql.includes('SELECT COUNT(*) as count FROM topics')) {
      assert(schemaReady, 'topics readiness query ran before schema bootstrap');
      return { async first() { return { count: 1 }; } };
    }
    if (sql.includes('SELECT * FROM topics')) {
      assert(schemaReady, 'dashboard topics query ran before schema bootstrap');
      return {
        bind() { return this; },
        async all() {
          return { results: [{ id: 'd1-real-1', canonical_title: 'D1 真实趋势', category: '科技', current_score: 81, breakout_score: 70, source_count: 2, ai_opportunities_json: '[]' }] };
        }
      };
    }
    if (sql.includes('FROM sources ORDER BY')) {
      return { async all() { return { results: [{ id: 'v2ex', name: 'V2EX', region: 'cn', kind: 'direct', last_success_at: new Date().toISOString(), last_error: null, last_item_count: 20 }] }; } };
    }
    if (sql.includes('GROUP BY category')) {
      return { async all() { return { results: [{ category: '科技', count: 1, avg_score: 81 }] }; } };
    }
    if (sql.includes('FROM topic_snapshots')) {
      return { async all() { return { results: [] }; } };
    }
    throw new Error(`unexpected fresh D1 query: ${sql}`);
  }
};
const freshD1Dashboard = await parse(await worker.fetch(new Request('https://example.test/api/dashboard'), { DB: freshD1 }));
assert(schemaExecCount === 1, `fresh D1 schema bootstrap count=${schemaExecCount}`);
assert(freshD1Dashboard.status === 200, `fresh D1 dashboard status=${freshD1Dashboard.status}`);
assert(freshD1Dashboard.body.preview === false && freshD1Dashboard.body.ready === true, 'fresh D1 dashboard must be real-data ready');
assert(freshD1Dashboard.body.fallback == null, 'healthy D1 dashboard must not use fallback');
assert(freshD1Dashboard.body.topics?.[0]?.id === 'd1-real-1', 'healthy D1 topic must be returned');

const originalFetch = globalThis.fetch;
try {
  const realSnapshot = {
    generatedAt: new Date().toISOString(),
    ready: true,
    preview: false,
    topics: [
      { id: 'real-1', canonical_title: '真实趋势 A', category: '科技', current_score: 80, breakout_score: 72, source_count: 3 },
      { id: 'real-2', canonical_title: '真实趋势 B', category: '消费', current_score: 70, breakout_score: 64, source_count: 2 }
    ],
    categories: [{ category: '科技', count: 1, avg_score: 80 }, { category: '消费', count: 1, avg_score: 70 }],
    timeline: [],
    sources: [{ id: 'real-source', name: 'Real source', region: 'CN', kind: 'direct', last_success_at: new Date().toISOString(), last_error: null, last_item_count: 20 }]
  };
  globalThis.fetch = async request => {
    const url = typeof request === 'string' ? request : request.url;
    assert(url === 'https://fallback.test/data/dashboard.json', `unexpected fallback URL: ${url}`);
    return new Response(JSON.stringify(realSnapshot), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const fallback = await parse(await worker.fetch(new Request('https://example.test/api/dashboard?category=科技'), {
    PUBLIC_FALLBACK_DASHBOARD_URL: 'https://fallback.test/data/dashboard.json'
  }));
  assert(fallback.status === 200, `real fallback dashboard status=${fallback.status}`);
  assert(fallback.body.preview === false && fallback.body.ready === true, 'fallback must remain real-data ready');
  assert(fallback.body.fallback?.active === true, 'fallback provenance must be explicit');
  assert(fallback.body.fallback?.kind === 'github-pages-real-snapshot', 'fallback kind must be explicit');
  assert(fallback.body.topics.length === 1 && fallback.body.topics[0].category === '科技', 'category filtering must survive fallback');

  const staleSnapshot = { ...realSnapshot, generatedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString() };
  globalThis.fetch = async () => new Response(JSON.stringify(staleSnapshot), { status: 200, headers: { 'content-type': 'application/json' } });
  const stale = await parse(await worker.fetch(new Request('https://example.test/api/dashboard'), {
    PUBLIC_FALLBACK_DASHBOARD_URL: 'https://fallback.test/data/dashboard.json',
    FALLBACK_MAX_AGE_HOURS: '4'
  }));
  assert(stale.status === 503, `stale fallback must fail closed, status=${stale.status}`);
  assert(stale.body.preview === false && stale.body.ready === false, 'stale fallback must not become preview data');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Worker D1 bootstrap, diagnostics, and truthful real-dashboard fallback validated');
