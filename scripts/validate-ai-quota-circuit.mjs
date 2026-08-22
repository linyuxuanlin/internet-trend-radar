import { analyzeTopicDetailed, enrichTopTopics } from '../src/ai.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const quotaError = Object.assign(new Error('AiError'), {
  name: 'AiError',
  cause: { message: '4006 You have used up your daily free allocation of 10,000 neurons. Please retry after the daily allocation resets.' }
});

let inferenceCalls = 0;
const classification = await analyzeTopicDetailed({
  AI: {
    async run() {
      inferenceCalls++;
      throw quotaError;
    }
  },
  AI_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
}, {
  canonical_title: '测试热点标题',
  category: '科技',
  current_score: 80,
  breakout_score: 90,
  source_count: 2
}, [{ source_id: 'v2ex', rank: 1, title: '测试证据' }]);

assert(inferenceCalls === 1, `daily quota exhaustion must not invoke fallback; calls=${inferenceCalls}`);
assert(/^inference-error:quota-or-capacity(?::|$)/.test(classification.failureReason || ''), `quota classification=${classification.failureReason}`);

let candidateQueries = 0;
let circuitInferenceCalls = 0;
const quotaAttemptAt = new Date().toISOString();
const env = {
  AI: {
    async run() {
      circuitInferenceCalls++;
      throw new Error('quota circuit should prevent inference');
    }
  },
  DB: {
    prepare(sql) {
      if (sql.includes('FROM ai_attempts') && sql.includes('quota-or-capacity')) {
        return {
          async first() {
            return {
              attempted_at: quotaAttemptAt,
              failure_reason: 'inference-error:quota-or-capacity:AiError'
            };
          }
        };
      }
      candidateQueries++;
      throw new Error(`quota circuit should short-circuit before candidate query: ${sql}`);
    }
  }
};

const result = await enrichTopTopics(env, { backfillOnly: true, topN: 10 });
assert(result.skipped === true, `quota circuit skipped=${result.skipped}`);
assert(result.skipReason === 'daily-ai-quota-exhausted', `skipReason=${result.skipReason}`);
assert(result.selected === 0 && result.updated === 0 && result.failed === 0, `quota circuit result=${JSON.stringify(result)}`);
assert(result.quotaDetectedAt === quotaAttemptAt, `quotaDetectedAt=${result.quotaDetectedAt}`);
assert(typeof result.retryAfter === 'string' && Date.parse(result.retryAfter) > Date.now(), `retryAfter=${result.retryAfter}`);
assert(candidateQueries === 0, `candidateQueries=${candidateQueries}`);
assert(circuitInferenceCalls === 0, `circuitInferenceCalls=${circuitInferenceCalls}`);

const candidateSqls = [];
const priorityEnv = {
  DB: {
    prepare(sql) {
      if (sql.includes('FROM ai_attempts') && sql.includes('quota-or-capacity')) {
        return { async first() { return null; } };
      }
      if (sql.includes('SELECT * FROM topics')) {
        candidateSqls.push(sql);
        return {
          bind() {
            return { async all() { return { results: [] }; } };
          }
        };
      }
      if (sql.includes('DELETE FROM ai_attempts')) return { async run() {} };
      throw new Error(`unexpected priority fixture SQL: ${sql}`);
    }
  }
};

await enrichTopTopics(priorityEnv, { backfillOnly: true, topN: 10 });
await enrichTopTopics(priorityEnv, { backfillOnly: false, topN: 10 });
assert(candidateSqls.length === 2, `candidate SQL count=${candidateSqls.length}`);
for (const sql of candidateSqls) {
  assert(sql.includes("julianday(last_seen_at) >= julianday('now','-6 hours')"), 'freshest 6h topics must receive first quota priority');
  assert(sql.includes("julianday(last_seen_at) >= julianday('now','-24 hours')"), 'recent 24h topics must outrank historical backlog');
  assert(sql.includes('breakout_score DESC, current_score DESC, source_count DESC, last_seen_at DESC'), 'priority tie-breakers must favor breakout, score, source breadth, then recency');
}

console.log('Workers AI daily quota circuit and freshness-first quota-aware candidate priority validated');
