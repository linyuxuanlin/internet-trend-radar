import { rebuildTopics } from '../src/scoring.js';
import { currentSourcePredicate, SOURCE_FRESHNESS_HOURS } from '../src/source-health.js';

if (SOURCE_FRESHNESS_HOURS !== 2) throw new Error('current source freshness contract must remain 2 hours');
const predicate = currentSourcePredicate('active_source');
for (const required of ['active_source.last_success_at IS NOT NULL', 'active_source.last_error_at IS NULL', 'active_source.enabled']) {
  if (!predicate.includes(required)) throw new Error(`freshness predicate missing ${required}`);
}

const queries = [];
const db = {
  prepare(sql) {
    queries.push(String(sql));
    return {
      bind() { return this; },
      async all() { return { results: [] }; },
      async run() { return { success: true }; }
    };
  }
};
await rebuildTopics(db, 24);
const scoringQueries = queries.filter(sql => sql.includes('FROM raw_items'));
if (scoringQueries.length < 1 || scoringQueries.some(sql => !sql.includes('last_success_at') || !sql.includes('last_error_at'))) {
  throw new Error('topic scoring must exclude stale or failed sources');
}
console.log('Source freshness scoring contract validated: stale and failed sources stay historical only');
