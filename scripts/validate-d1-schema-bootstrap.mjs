import { ensureSchema } from '../src/schema.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const prepared = [];
const db = {
  prepare(sql) {
    prepared.push(sql);
    assert(!/PRAGMA\s+foreign_keys\s*=\s*(ON|1)/i.test(sql), 'schema bootstrap must not toggle D1 foreign_keys');
    return {
      async run() {
        return { success: true, meta: { changes: 0 } };
      }
    };
  },
  async exec() {
    throw new Error('real D1-compatible bootstrap must prefer prepare().run() over exec()');
  }
};

const first = await ensureSchema({ DB: db });
const second = await ensureSchema({ DB: db });
assert(first.ok === true && second.ok === true, 'schema bootstrap must succeed');
assert(prepared.length > 1, 'schema bootstrap must execute statements progressively');
for (const table of ['sources', 'raw_items', 'topics', 'topic_snapshots', 'topic_sources', 'subscribers', 'digests']) {
  assert(prepared.some(sql => sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`)), `schema bootstrap must create ${table}`);
}
const cachedCount = prepared.length;
await ensureSchema({ DB: db });
assert(prepared.length === cachedCount, 'successful schema bootstrap must be cached per binding');

let attempts = 0;
const failingDb = {
  prepare(sql) {
    return {
      async run() {
        attempts++;
        if (sql.includes('CREATE TABLE IF NOT EXISTS topics')) throw new Error('simulated D1 prepared DDL rejection');
        return { success: true };
      }
    };
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

let execFallbackCount = 0;
const legacyMockDb = {
  async exec(sql) {
    execFallbackCount++;
    return { sql };
  }
};
const legacy = await ensureSchema({ DB: legacyMockDb });
assert(legacy.ok === true && execFallbackCount > 1, 'exec-only deterministic mocks must retain compatibility');

console.log(`D1 prepared progressive bootstrap validated across ${prepared.length} statements with precise retryable failure diagnostics`);
