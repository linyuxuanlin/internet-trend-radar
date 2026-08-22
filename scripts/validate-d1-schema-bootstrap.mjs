import { ensureSchema } from '../src/schema.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const executed = [];
const db = {
  async exec(sql) {
    executed.push(sql);
    assert(!/PRAGMA\s+foreign_keys\s*=\s*(ON|1)/i.test(sql), 'schema bootstrap must not toggle D1 foreign_keys');
    return { count: 1, duration: 1 };
  }
};

const first = await ensureSchema({ DB: db });
const second = await ensureSchema({ DB: db });
assert(first.ok === true && second.ok === true, 'schema bootstrap must succeed');
assert(executed.length > 1, 'schema bootstrap must execute statements progressively');
for (const table of ['sources', 'raw_items', 'topics', 'topic_snapshots', 'topic_sources', 'subscribers', 'digests']) {
  assert(executed.some(sql => sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`)), `schema bootstrap must create ${table}`);
}
const cachedCount = executed.length;
await ensureSchema({ DB: db });
assert(executed.length === cachedCount, 'successful schema bootstrap must be cached per binding');

let attempts = 0;
const failingDb = {
  async exec(sql) {
    attempts++;
    if (sql.includes('CREATE TABLE IF NOT EXISTS topics')) throw new Error('simulated D1 DDL rejection');
    return { count: 1, duration: 1 };
  }
};
let failure = null;
try {
  await ensureSchema({ DB: failingDb });
} catch (error) {
  failure = error;
}
assert(failure, 'schema bootstrap must surface D1 DDL failures');
assert(String(failure.message).includes('CREATE TABLE IF NOT EXISTS topics'), 'failure must name the rejected statement');
const firstAttemptCount = attempts;
try { await ensureSchema({ DB: failingDb }); } catch {}
assert(attempts > firstAttemptCount, 'failed schema bootstrap must clear cache so a later request can retry');

console.log(`D1 progressive schema bootstrap validated across ${executed.length} statements with precise retryable failure diagnostics`);
