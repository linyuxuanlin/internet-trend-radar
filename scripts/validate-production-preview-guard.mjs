import assert from 'node:assert/strict';
import worker, { isForbiddenPreviewPath } from '../src/worker.js';

assert.equal(isForbiddenPreviewPath('/api/topic/preview-ai-agents'), true);
assert.equal(isForbiddenPreviewPath('/api/topic/real-topic'), false);
assert.equal(isForbiddenPreviewPath('/api/dashboard'), false);

const response = await worker.fetch(new Request('https://example.com/api/topic/preview-ai-agents'), {}, {});
assert.equal(response.status, 404);
const payload = await response.json();
assert.equal(payload.preview, false);
assert.equal(payload.ready, false);
assert.match(payload.error, /preview topics are disabled/i);

console.log('production preview guard validated');
