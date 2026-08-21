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

console.log('Worker diagnostics routing validated: health/debug survive missing binding and partial schema');
