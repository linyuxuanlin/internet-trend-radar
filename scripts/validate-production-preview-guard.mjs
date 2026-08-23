import assert from 'node:assert/strict';
import worker, { isForbiddenPreviewPath, isPreviewPayload, rejectPreviewResponse } from '../src/worker.js';

assert.equal(isForbiddenPreviewPath('/api/topic/preview-ai-agents'), true);
assert.equal(isForbiddenPreviewPath('/api/topic/real-topic'), false);
assert.equal(isForbiddenPreviewPath('/api/dashboard'), false);

assert.equal(isPreviewPayload({ preview: true }), true);
assert.equal(isPreviewPayload({ preview: false }), false);
assert.equal(isPreviewPayload(null), false);

const previewResponse = await rejectPreviewResponse(Response.json({ ok: true, preview: true }, { status: 200 }));
assert.equal(previewResponse.status, 503);
const previewPayload = await previewResponse.json();
assert.equal(previewPayload.preview, false);
assert.equal(previewPayload.ready, false);
assert.equal(previewPayload.upstream_status, 200);
assert.match(previewPayload.error, /preview payloads are disabled/i);

const realResponse = Response.json({ ok: true, preview: false, topics: [{ id: 'real-topic' }] }, { status: 200 });
const guardedRealResponse = await rejectPreviewResponse(realResponse);
assert.equal(guardedRealResponse.status, 200);
assert.deepEqual(await guardedRealResponse.json(), { ok: true, preview: false, topics: [{ id: 'real-topic' }] });

const response = await worker.fetch(new Request('https://example.com/api/topic/preview-ai-agents'), {}, {});
assert.equal(response.status, 404);
const payload = await response.json();
assert.equal(payload.preview, false);
assert.equal(payload.ready, false);
assert.match(payload.error, /preview topics are disabled/i);

console.log('production preview guard validated');
