import { ensureSchema } from '../src/schema.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let execCount = 0;
const db = {
  async exec(sql) {
    execCount++;
    assert(!/PRAGMA\s+foreign_keys\s*=\s*(ON|1)/i.test(sql), 'schema bootstrap must not toggle D1 foreign_keys');
    assert(sql.includes('CREATE TABLE IF NOT EXISTS sources'), 'schema bootstrap must create sources');
    assert(sql.includes('CREATE TABLE IF NOT EXISTS raw_items'), 'schema bootstrap must create raw_items');
    assert(sql.includes('CREATE TABLE IF NOT EXISTS topics'), 'schema bootstrap must create topics');
    assert(sql.includes('CREATE TABLE IF NOT EXISTS topic_snapshots'), 'schema bootstrap must create topic_snapshots');
    assert(sql.includes('CREATE TABLE IF NOT EXISTS topic_sources'), 'schema bootstrap must create topic_sources');
    return { count: 1, duration: 1 };
  }
};

const first = await ensureSchema({ DB: db });
const second = await ensureSchema({ DB: db });
assert(first.ok === true && second.ok === true, 'schema bootstrap must succeed');
assert(execCount === 1, `schema bootstrap should be cached per binding, execCount=${execCount}`);

console.log('D1-compatible schema bootstrap validated: no foreign_keys pragma and required tables are created');
