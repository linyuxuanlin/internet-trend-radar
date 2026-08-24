import assert from 'node:assert/strict';
import { serveFreshStaticAsset } from '../src/worker.js';

const now = new Date().toISOString();
const request = new Request('https://example.test/data/dashboard.json');
const env = payload => ({ ASSETS: { async fetch() { return Response.json(payload); } } });

const fresh = await serveFreshStaticAsset(request, env({ generatedAt: now, ready: true, preview: false }));
assert.equal(fresh.status, 200);
assert.equal((await fresh.json()).ready, true);

const stale = await serveFreshStaticAsset(request, env({ generatedAt: new Date(Date.now() - 4 * 3600000).toISOString(), ready: true, preview: false }));
assert.equal(stale.status, 503);
assert.equal((await stale.json()).ready, false);

const invalid = await serveFreshStaticAsset(request, { ASSETS: { async fetch() { return new Response('not-json', { status: 200 }); } } });
assert.equal(invalid.status, 503);

const missing = await serveFreshStaticAsset(request, { ASSETS: { async fetch() { return new Response('missing', { status: 404 }); } } });
assert.equal(missing.status, 503);

console.log('Static asset freshness validated: stale direct snapshots fail closed');
