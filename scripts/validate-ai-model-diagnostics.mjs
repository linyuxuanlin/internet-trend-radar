import worker from '../src/index.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const now = '2026-08-22T10:00:00.000Z';
const requiredTables = ['sources', 'raw_items', 'topics', 'topic_snapshots', 'topic_sources'];

const db = {
  prepare(sql) {
    const statement = {
      bind() { return this; },
      async run() { return { success: true }; },
      async first() {
        if (sql === 'SELECT COUNT(*) as count FROM raw_items') return { count: 500 };
        if (sql === 'SELECT COUNT(*) as count FROM topics') return { count: 100 };
        if (sql === 'SELECT COUNT(*) as count FROM sources') return { count: 15 };
        if (sql.includes('FROM sources WHERE last_success_at IS NOT NULL')) return { count: 14 };
        if (sql.includes('FROM sources WHERE last_error_at IS NOT NULL')) return { count: 1 };
        if (sql.includes('SELECT MAX(last_success_at)')) return { value: now };
        if (sql.includes('current_score >= 45') && !sql.includes('ai_updated_at') && !sql.includes('length(trim')) return { count: 40 };
        if (sql.includes('current_score >= 45 AND ai_updated_at IS NOT NULL') && !sql.includes('length(trim') && !sql.includes('julianday(ai_updated_at)')) return { count: 30 };
        if (sql.includes('length(trim(COALESCE(ai_summary')) return { count: 12 };
        if (sql.includes("julianday(ai_updated_at) < julianday('now','-6 hours')")) return { count: 4 };
        if (sql.includes('SELECT MAX(ai_updated_at)')) return { value: now };
        throw new Error(`unexpected first query: ${sql}`);
      },
      async all() {
        if (sql.includes('sqlite_master')) return { results: requiredTables.map(name => ({ name })) };
        if (sql.includes('SELECT id,last_error,last_error_at FROM sources')) return { results: [] };
        const oneHour = sql.includes("julianday('now','-1 hours')");
        if (sql.includes('GROUP BY model, reason')) {
          if (oneHour) return { results: [
            { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', reason: 'success', count: 7, last_at: now },
            { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', reason: 'inference-error:invalid-request:AiError', count: 2, last_at: now }
          ] };
          return { results: [
            { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', reason: 'success', count: 18, last_at: now },
            { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', reason: 'inference-error:upstream', count: 12, last_at: now },
            { model: '@cf/meta/llama-3.1-8b-instruct-fast', reason: 'success', count: 20, last_at: now },
            { model: '@cf/meta/llama-3.1-8b-instruct-fast', reason: 'title-echo', count: 4, last_at: now },
            { model: '@cf/meta/llama-3.1-8b-instruct-fast', reason: 'empty-model-response', count: 1, last_at: now }
          ] };
        }
        if (sql.includes('GROUP BY reason')) {
          if (oneHour) return { results: [
            { reason: 'success', count: 7, last_at: now },
            { reason: 'inference-error:invalid-request:AiError', count: 2, last_at: now }
          ] };
          return { results: [
            { reason: 'success', count: 38, last_at: now },
            { reason: 'inference-error:upstream', count: 12, last_at: now },
            { reason: 'title-echo', count: 4, last_at: now },
            { reason: 'empty-model-response', count: 1, last_at: now }
          ] };
        }
        throw new Error(`unexpected all query: ${sql}`);
      }
    };
    return statement;
  }
};

const response = await worker.fetch(new Request('https://example.test/api/debug'), {
  DB: db,
  AI: { run() {} },
  AI_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
});
assert(response.status === 200, `debug status=${response.status}`);
const body = await response.json();

const recent = body.ai?.model_stats_1h;
assert(Array.isArray(recent) && recent.length === 1, `1h model stats length=${recent?.length}`);
assert(body.ai.recent_attempts_1h === 9, `1h attempts=${body.ai.recent_attempts_1h}`);
assert(body.ai.recent_successes_1h === 7, `1h successes=${body.ai.recent_successes_1h}`);
assert(body.ai.recent_failures_1h === 2, `1h failures=${body.ai.recent_failures_1h}`);
assert(body.ai.recent_failure_reasons_1h?.[0]?.reason === 'inference-error:invalid-request:AiError', '1h failure reason must be preserved');
assert(recent[0]?.attempts === 9 && recent[0]?.successes === 7 && recent[0]?.failures === 2, `1h primary stats=${JSON.stringify(recent[0])}`);
assert(recent[0]?.success_rate === 77.8, `1h primary success rate=${recent[0]?.success_rate}`);

const stats = body.ai?.model_stats_24h;
assert(Array.isArray(stats) && stats.length === 2, `24h model stats length=${stats?.length}`);
const primary = stats.find(x => x.model === '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
const fallback = stats.find(x => x.model === '@cf/meta/llama-3.1-8b-instruct-fast');
assert(primary?.attempts === 30 && primary?.successes === 18 && primary?.failures === 12, `primary stats=${JSON.stringify(primary)}`);
assert(primary?.success_rate === 60, `primary success rate=${primary?.success_rate}`);
assert(primary?.failure_reasons?.[0]?.reason === 'inference-error:upstream', 'primary failure reason must be preserved');
assert(fallback?.attempts === 25 && fallback?.successes === 20 && fallback?.failures === 5, `fallback stats=${JSON.stringify(fallback)}`);
assert(fallback?.success_rate === 80, `fallback success rate=${fallback?.success_rate}`);
assert(fallback?.failure_reasons?.[0]?.reason === 'title-echo', 'fallback failure reasons must be ranked by count');
assert(body.ai.recent_attempts_24h === 55, `aggregate attempts=${body.ai.recent_attempts_24h}`);
assert(body.ai.recent_successes_24h === 38, `aggregate successes=${body.ai.recent_successes_24h}`);

console.log('One-hour and 24-hour per-model Workers AI diagnostics validated');
