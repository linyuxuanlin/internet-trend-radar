import worker from '../src/index.js';
import { opportunitiesSnapshot } from '../src/api.js';

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
assert(missingBinding.body.ai?.binding === false, 'missing AI binding must be reported');

const missingTablesDB = {
  async exec() { throw new Error('mock schema bootstrap failure'); },
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
assert(missingTables.body.schema?.bootstrap_attempted === true, 'debug must attempt idempotent schema bootstrap');
assert(missingTables.body.schema?.bootstrap_ok === false, 'failed schema bootstrap must be reported without taking debug down');
assert(String(missingTables.body.schema?.bootstrap_error || '').includes('mock schema bootstrap failure'), 'bootstrap error must retain the real failure');
assert(missingTables.body.schema?.ok === false, 'partial schema must not report healthy');
assert(String(missingTables.body.schema?.error || '').includes('missing tables:'), 'missing tables must be named');
assert(String(missingTables.body.schema?.error || '').includes('bootstrap failed:'), 'schema error must include bootstrap failure context');
assert(missingTables.body.schema.tables.sources === true, 'present table should be reported true');
assert(missingTables.body.schema.tables.raw_items === false, 'missing table should be reported false');

const health = await parse(await worker.fetch(new Request('https://example.test/api/health'), {}));
assert(health.status === 200 && health.body.ok === true, 'health must remain reachable without D1');

const opportunitiesWithoutD1 = await parse(await opportunitiesSnapshot(
  { BUILD_SHA: 'a'.repeat(40) },
  new Request('https://example.test/data/opportunities.json')
));
assert(opportunitiesWithoutD1.status === 503, 'opportunities without D1 must remain degraded');
assert(opportunitiesWithoutD1.body.buildSha === 'a'.repeat(40), 'opportunities must preserve explicit deployment build SHA without static assets');

const originalDefaultFallbackFetch = globalThis.fetch;
let defaultFallbackUrl = null;
globalThis.fetch = async request => {
  defaultFallbackUrl = typeof request === 'string' ? request : request.url;
  return new Response(JSON.stringify({ ready: false, preview: false, topics: [], sources: [] }), { status: 503 });
};
const fallbackWithoutD1 = await parse(await worker.fetch(new Request('https://example.test/api/dashboard'), {}));
globalThis.fetch = originalDefaultFallbackFetch;
assert(fallbackWithoutD1.status === 503, 'dashboard without D1 must fail closed when no fallback is available');
assert(defaultFallbackUrl === 'https://linyuxuanlin.github.io/internet-trend-radar/data/dashboard.json', `default dashboard fallback URL drifted: ${defaultFallbackUrl}`);

const aiDebugDB = {
  async exec() { return { count: 1 }; },
  prepare(sql) {
    if (sql.includes('sqlite_master')) {
      return {
        bind() { return this; },
        async all() { return { results: ['sources', 'raw_items', 'topics', 'topic_snapshots', 'topic_sources'].map(name => ({ name })) }; }
      };
    }
    if (sql === 'SELECT COUNT(*) as count FROM raw_items') return { async first() { return { count: 240 }; } };
    if (sql === 'SELECT COUNT(*) as count FROM topics') return { async first() { return { count: 42 }; } };
    if (sql === 'SELECT COUNT(*) as count FROM sources') return { async first() { return { count: 12 }; } };
    if (sql.includes('FROM sources WHERE') && sql.includes('last_success_at IS NOT NULL') && sql.includes("julianday(last_success_at) >=")) return { async first() { return { count: 10 }; } };
    if (sql.includes('FROM sources WHERE') && sql.includes('last_success_at IS NOT NULL') && sql.includes("julianday(last_success_at) <")) return { async first() { return { count: 2 }; } };
    if (sql.includes('FROM sources WHERE') && sql.includes('last_error_at IS NOT NULL')) return { async first() { return { count: 2 }; } };
    if (sql.includes('SELECT MAX(CASE WHEN enabled=1 THEN last_success_at END)')) return { async first() { return { value: '2026-08-21T19:00:00.000Z' }; } };
    if (sql.includes('SELECT id,last_error,last_error_at FROM sources')) return { async all() { return { results: [] }; } };
    if (sql.includes('FROM sources s') && sql.includes('contract_heat_violations')) return { async all() { return { results: [] }; } };
    if (sql.includes("json_extract(raw_json,'$.trendRadarUpstream')")) return { async first() { return { missing_upstream: 0, missing_heat: 0, missing_engagement: 0 }; } };
    if (sql.includes('current_score >= 45') && !sql.includes('ai_updated_at') && !sql.includes('length(trim')) return { async first() { return { count: 8 }; } };
    if (sql.includes('COALESCE(ai_summary')) return { async first() { return { count: 3 }; } };
    if (sql.includes("julianday(ai_updated_at) < julianday('now','-6 hours')")) return { async first() { return { count: 2 }; } };
    if (sql.includes('SELECT MAX(ai_updated_at)')) return { async first() { return { value: '2026-08-21T18:30:00.000Z' }; } };
    throw new Error(`unexpected AI debug query: ${sql}`);
  }
};
const aiDebug = await parse(await worker.fetch(new Request('https://example.test/api/debug'), {
  DB: aiDebugDB,
  AI: { run() {} },
  AI_MODEL: '@cf/test/model'
}));
assert(aiDebug.status === 200, `AI debug status=${aiDebug.status}`);
assert(aiDebug.body.schema?.bootstrap_ok === true, 'healthy debug schema bootstrap must succeed');
assert(aiDebug.body.ready === true, 'AI debug fixture must remain real-data ready');
assert(aiDebug.body.ai?.binding === true, 'AI binding presence must be reported');
assert(aiDebug.body.ai?.model === '@cf/test/model', 'configured AI model must be reported');
assert(aiDebug.body.ai?.eligible_topics === 8, `eligible AI topics=${aiDebug.body.ai?.eligible_topics}`);
assert(aiDebug.body.ai?.verified_topics === 3, `verified AI topics=${aiDebug.body.ai?.verified_topics}`);
assert(aiDebug.body.ai?.pending_topics === 5, `pending AI topics=${aiDebug.body.ai?.pending_topics}`);
assert(aiDebug.body.ai?.stale_topics === 2, `stale AI topics=${aiDebug.body.ai?.stale_topics}`);
assert(aiDebug.body.ai?.last_updated_at === '2026-08-21T18:30:00.000Z', 'last AI update timestamp must be reported');
assert(aiDebug.body.data_quality?.ok === true, 'clean debug fixture must report data_quality.ok=true');
assert(aiDebug.body.data_quality?.raw_items_invalid_upstream === 0, 'clean debug fixture must report no invalid upstream URLs');
assert(aiDebug.body.data_quality?.metric_path_violations?.heat === 0, 'clean debug fixture must report no heat path violations');
assert(aiDebug.body.data_quality?.contract_violations?.engagement === 0, 'clean debug fixture must report no engagement contract violations');

// A freshly provisioned D1 must be schema-bootstrapped before the dashboard performs
// its first topics readiness query. This regression test proves the bootstrap order and
// verifies that a healthy D1 result wins without requiring any synthetic fallback.
let schemaReady = false;
let schemaExecCount = 0;
const freshD1 = {
  async exec(sql) {
    schemaExecCount++;
    if (sql.includes('CREATE TABLE IF NOT EXISTS topics')) schemaReady = true;
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
          return { results: [{ id: 'd1-real-1', canonical_title: 'D1 真实趋势', category: '科技', current_score: 81, breakout_score: 70, source_count: 1, ai_opportunities_json: '[]' }] };
        }
      };
    }
    if (sql.includes('data_quality_contract_probe')) {
      return { async first() {
        return {
          missing_upstream: 0,
          invalid_upstream: 0,
          heat_path_violations: 0,
          engagement_path_violations: 0,
          contract_heat_violations: 0,
          contract_engagement_violations: 0
        };
      } };
    }
    if (sql.includes('FROM sources s')) {
      return { async all() { return { results: [{ id: 'v2ex', name: 'V2EX', region: 'cn', kind: 'direct', last_success_at: new Date().toISOString(), last_error: null, last_item_count: 20 }] }; } };
    }
    if (sql.includes('raw_heat_max')) {
      return {
        bind() { return this; },
        async all() { return { results: [{
          topic_id: 'd1-real-1', source_id: 'v2ex', source_name: 'V2EX', source_kind: 'official-api', source_weight: 1,
          metadata_json: JSON.stringify({ heat: null, engagement: 'topics[].replies' }), raw_heat_max: null, raw_engagement_max: 4,
          raw_heat_latest: null, raw_engagement_latest: 4, best_rank: 1, observations: 1,
          observed_upstreams: JSON.stringify(['https://example.test/source']), latest_captured_at: new Date().toISOString(),
          upstream: 'https://example.test/source', engagement_metric_path: 'topics[].replies', heat_metric_path: null
        }] }; }
      };
    }
    if (sql.includes('data_quality_contract_probe')) {
      return { async first() { return { missing_upstream: 0, invalid_upstream: 0, heat_path_violations: 0, engagement_path_violations: 0, contract_heat_violations: 0, contract_engagement_violations: 0, definition_heat_path_violations: 0, definition_engagement_path_violations: 0 }; } };
    }
    if (sql.includes('GROUP BY category')) {
      return { async all() { return { results: [{ category: '科技', count: 1, avg_score: 81 }] }; } };
    }
    if (sql.includes('FROM topic_snapshots')) {
      return { bind() { return this; }, async all() { return { results: [] }; } };
    }
    throw new Error(`unexpected fresh D1 query: ${sql}`);
  }
};
const freshD1Dashboard = await parse(await worker.fetch(new Request('https://example.test/api/dashboard'), { DB: freshD1 }));
assert(schemaExecCount > 1, `fresh D1 progressive schema bootstrap count=${schemaExecCount}`);
assert(schemaReady, 'fresh D1 progressive bootstrap must create topics before readiness query');
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
      {
        id: 'real-1', canonical_title: '真实趋势 A', category: '科技', current_score: 80, breakout_score: 72, source_count: 1,
        sources: [{ source_id: 'real-source', title: '真实趋势 A', rank: 1, captured_at: new Date().toISOString() }],
        raw_signals: [{ source_id: 'real-source', source_kind: 'official-api', raw_heat_max: 10, raw_engagement_max: null, raw_heat_latest: 10, raw_engagement_latest: null, latest_captured_at: new Date().toISOString(), upstream: 'https://example.test/source', observed_upstreams: ['https://example.test/source'], metric_paths: { heat: 'item.score', engagement: null }, peak_evidence: { heat: { captured_at: new Date().toISOString(), upstream: 'https://example.test/source' }, engagement: null } }]
      },
      {
        id: 'real-2', canonical_title: '真实趋势 B', category: '消费', current_score: 70, breakout_score: 64, source_count: 1,
        sources: [{ source_id: 'real-source', title: '真实趋势 B', rank: 2, captured_at: new Date().toISOString() }],
        raw_signals: [{ source_id: 'real-source', source_kind: 'official-api', raw_heat_max: null, raw_engagement_max: null, raw_heat_latest: null, raw_engagement_latest: null, latest_captured_at: new Date().toISOString(), upstream: 'https://example.test/source', observed_upstreams: ['https://example.test/source'], metric_paths: { heat: null, engagement: null }, peak_evidence: { heat: null, engagement: null } }]
      }
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

  const invalidMetricSnapshot = structuredClone(realSnapshot);
  invalidMetricSnapshot.topics[0].raw_signals[0].metric_definition = { heat: null, engagement: null };
  globalThis.fetch = async () => new Response(JSON.stringify(invalidMetricSnapshot), { status: 200, headers: { 'content-type': 'application/json' } });
  const invalidMetric = await parse(await worker.fetch(new Request('https://example.test/api/dashboard'), {
    PUBLIC_FALLBACK_DASHBOARD_URL: 'https://fallback.test/data/dashboard.json'
  }));
  assert(invalidMetric.status === 503, `invalid fallback metric contract must fail closed, status=${invalidMetric.status}`);

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

console.log('Worker D1 bootstrap, debug self-healing, AI readiness diagnostics, and truthful real-dashboard fallback validated');
