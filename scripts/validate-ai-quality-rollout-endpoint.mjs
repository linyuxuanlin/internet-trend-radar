#!/usr/bin/env node

import { aiQualityRolloutStats } from '../src/worker.js';

const EXPECTED_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const EXPECTED_SINCE = '2026-08-24T03:33:53.000Z';

const calls = [];
const env = {
  AI_MODEL: EXPECTED_MODEL,
  AI_QUALITY_ROLLOUT_AT: EXPECTED_SINCE,
  DB: {
    prepare(sql) {
      if (!sql.includes('FROM ai_attempts') || !sql.includes('attempted_at >= ?') || !sql.includes('model = ?')) {
        throw new Error('rollout query lost its exact time/model boundary');
      }
      return {
        bind(since, model) {
          calls.push({ since, model });
          return {
            async all() {
              return {
                results: [
                  { reason: 'success', count: 7, last_at: '2026-08-24T07:10:00.000Z' },
                  { reason: 'invalid-json', count: 2, last_at: '2026-08-24T07:08:00.000Z' },
                  { reason: 'title-echo', count: 1, last_at: '2026-08-24T07:06:00.000Z' }
                ]
              };
            }
          };
        }
      };
    }
  }
};

const stats = await aiQualityRolloutStats(env);
if (!stats.ok || stats.preview !== false) throw new Error('rollout stats must be real-data diagnostics');
if (stats.since !== EXPECTED_SINCE || stats.model !== EXPECTED_MODEL) throw new Error('rollout boundary/model mismatch');
if (stats.attempts !== 10 || stats.successes !== 7 || stats.failures !== 3 || stats.success_rate !== 70) {
  throw new Error(`unexpected rollout arithmetic: ${JSON.stringify(stats)}`);
}
if (stats.failure_reasons.length !== 2 || stats.failure_reasons[0].reason !== 'invalid-json') {
  throw new Error('failure reasons were not preserved');
}
if (calls.length !== 1 || calls[0].since !== EXPECTED_SINCE || calls[0].model !== EXPECTED_MODEL) {
  throw new Error('D1 query was not bound to rollout timestamp and expected model');
}

const missingDb = await aiQualityRolloutStats({ AI_MODEL: EXPECTED_MODEL });
if (missingDb.ok !== false || missingDb.error !== 'missing-db-binding' || missingDb.preview !== false) {
  throw new Error('missing DB must fail closed without preview data');
}

console.log('Exact AI rollout stats self-test passed');
