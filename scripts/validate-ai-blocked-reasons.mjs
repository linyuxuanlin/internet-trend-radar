import worker from '../src/index.js';
import { aiAvailabilityStatus } from '../src/api.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function debug(env) {
  const response = await worker.fetch(new Request('https://example.test/api/debug'), env);
  assert(response.status === 200, `debug status=${response.status}`);
  return response.json();
}

function readyDB({ eligible = 4, attempted = 0, verified = 0, stale = 0, quota = false, attemptsToday = 0 } = {}) {
  return {
    prepare(sql) {
      if (sql.includes('sqlite_master')) return {
        bind() { return this; },
        async all() { return { results: ['sources', 'raw_items', 'topics', 'topic_snapshots', 'topic_sources'].map(name => ({ name })) }; }
      };
      if (sql === 'SELECT COUNT(*) as count FROM raw_items') return { async first() { return { count: 200 }; } };
      if (sql === 'SELECT COUNT(*) as count FROM topics') return { async first() { return { count: 40 }; } };
      if (sql === 'SELECT COUNT(*) as count FROM sources') return { async first() { return { count: 12 }; } };
      if (sql.includes('FROM sources WHERE last_success_at IS NOT NULL')) return { async first() { return { count: 10 }; } };
      if (sql.includes('FROM sources WHERE last_error_at IS NOT NULL')) return { async first() { return { count: 2 }; } };
      if (sql.includes('SELECT MAX(last_success_at)')) return { async first() { return { value: '2026-08-21T19:00:00.000Z' }; } };
      if (sql.includes('SELECT id,last_error,last_error_at FROM sources')) return { async all() { return { results: [] }; } };
      if (sql === 'SELECT COUNT(*) as count FROM topics WHERE current_score >= 45') return { async first() { return { count: eligible }; } };
      if (sql === 'SELECT COUNT(*) as count FROM topics WHERE current_score >= 45 AND ai_updated_at IS NOT NULL') return { async first() { return { count: attempted }; } };
      if (sql.includes('COALESCE(ai_summary')) return { async first() { return { count: verified }; } };
      if (sql.includes("julianday(ai_updated_at) < julianday('now','-6 hours')")) return { async first() { return { count: stale }; } };
      if (sql.includes('SELECT MAX(ai_updated_at)')) return { async first() { return { value: attempted ? '2026-08-21T18:30:00.000Z' : null }; } };
      if (sql.includes('SELECT count(*) AS attempts FROM ai_attempts')) return { async first() { return { attempts: attemptsToday }; } };
      if (sql.includes("failure_reason LIKE 'inference-error:quota-or-capacity%'")) return {
        async first() {
          return quota ? {
            attempted_at: new Date().toISOString(),
            failure_reason: 'inference-error:quota-or-capacity:AiError'
          } : null;
        }
      };
      throw new Error(`unexpected query: ${sql}`);
    }
  };
}

const missingEverything = await debug({});
assert(missingEverything.ai.blocked_reason === 'missing-ai-and-db-binding', `missing everything reason=${missingEverything.ai.blocked_reason}`);

const missingAI = await debug({ DB: readyDB() });
assert(missingAI.ai.blocked_reason === 'missing-ai-binding', `missing AI reason=${missingAI.ai.blocked_reason}`);
assert(missingAI.ai.ready_for_inference === false, 'missing AI binding cannot be inference-ready');

const notRun = await debug({ DB: readyDB({ eligible: 6, attempted: 0, verified: 0 }), AI: { run() {} } });
assert(notRun.ai.blocked_reason === 'inference-not-run', `not-run reason=${notRun.ai.blocked_reason}`);
assert(notRun.ai.ready_for_inference === true, 'eligible topics with AI binding must be inference-ready');
assert(notRun.ai.attempted_topics === 0, `attempted=${notRun.ai.attempted_topics}`);

const badOutput = await debug({ DB: readyDB({ eligible: 6, attempted: 4, verified: 0 }), AI: { run() {} } });
assert(badOutput.ai.blocked_reason === 'outputs-failed-quality-gate', `bad-output reason=${badOutput.ai.blocked_reason}`);

const partial = await debug({ DB: readyDB({ eligible: 6, attempted: 5, verified: 3, stale: 1 }), AI: { run() {} } });
assert(partial.ai.blocked_reason === 'partial-ai-coverage', `partial reason=${partial.ai.blocked_reason}`);
assert(partial.ai.pending_topics === 3, `partial pending=${partial.ai.pending_topics}`);

const quotaBlocked = await debug({ DB: readyDB({ eligible: 6, attempted: 5, verified: 3, quota: true }), AI: { run() {} } });
assert(quotaBlocked.ai.blocked_reason === 'daily-ai-quota-exhausted', `quota reason=${quotaBlocked.ai.blocked_reason}`);
assert(quotaBlocked.ai.quota_exhausted === true, 'quota exhaustion must be explicit');
assert(Boolean(quotaBlocked.ai.quota_detected_at), 'quota detection timestamp missing');
assert(Boolean(quotaBlocked.ai.quota_retry_after), 'quota retry timestamp missing');
assert(Date.parse(quotaBlocked.ai.quota_retry_after) > Date.now(), `quota retry must be in future: ${quotaBlocked.ai.quota_retry_after}`);
assert(quotaBlocked.ai.quota_failure_reason.startsWith('inference-error:quota-or-capacity'), `quota failure reason=${quotaBlocked.ai.quota_failure_reason}`);
assert(quotaBlocked.ai.ready_for_inference === false, 'quota-exhausted AI must not advertise inference readiness');

const healthy = await debug({ DB: readyDB({ eligible: 6, attempted: 6, verified: 6 }), AI: { run() {} } });
assert(healthy.ai.blocked_reason === null, `healthy reason=${healthy.ai.blocked_reason}`);
assert(healthy.ai.pending_topics === 0, `healthy pending=${healthy.ai.pending_topics}`);

const fixedNow = new Date('2026-08-23T08:30:00.000Z');
const providerBlocked = await aiAvailabilityStatus({
  DB: readyDB({ quota: true, attemptsToday: 10 }),
  AI: { run() {} },
  AI_DAILY_MODEL_CALL_BUDGET: '96',
  AI_DISABLE_FALLBACK: '1'
}, fixedNow);
assert(providerBlocked.available === false, 'provider quota must override pacing headroom');
assert(providerBlocked.effective_blocker === 'provider-daily-quota-exhausted', `provider blocker=${providerBlocked.effective_blocker}`);
assert(providerBlocked.pacing.remaining_headroom === 26, `provider pacing headroom=${providerBlocked.pacing.remaining_headroom}`);
assert(providerBlocked.provider_quota.exhausted === true, 'provider quota exhaustion must be explicit');
assert(providerBlocked.provider_quota.retry_after === '2026-08-24T00:00:00.000Z', `provider retry=${providerBlocked.provider_quota.retry_after}`);

const paced = await aiAvailabilityStatus({
  DB: readyDB({ attemptsToday: 36 }),
  AI: { run() {} },
  AI_DAILY_MODEL_CALL_BUDGET: '96',
  AI_DISABLE_FALLBACK: '1'
}, fixedNow);
assert(paced.available === false, 'pacing cap must block inference until next release');
assert(paced.effective_blocker === 'daily-ai-budget-paced', `paced blocker=${paced.effective_blocker}`);
assert(paced.pacing.paced === true, 'pacing status must be explicit');
assert(paced.pacing.next_release_at === '2026-08-23T09:00:00.000Z', `next release=${paced.pacing.next_release_at}`);

const available = await aiAvailabilityStatus({
  DB: readyDB({ attemptsToday: 10 }),
  AI: { run() {} },
  AI_DAILY_MODEL_CALL_BUDGET: '96',
  AI_DISABLE_FALLBACK: '1'
}, fixedNow);
assert(available.available === true, `availability blocker=${available.effective_blocker}`);
assert(available.effective_blocker === null, `availability blocker=${available.effective_blocker}`);
assert(available.pacing.topic_headroom === 26, `topic headroom=${available.pacing.topic_headroom}`);

console.log('AI blocked-reason and effective-availability diagnostics validated');