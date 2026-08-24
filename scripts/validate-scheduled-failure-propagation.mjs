import fs from 'node:fs/promises';
import { propagateScheduledFailure } from '../src/worker.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sentinel = new Error('scheduled sentinel failure');
let rethrown = null;
const originalError = console.error;
console.error = () => {};
try {
  propagateScheduledFailure(sentinel);
} catch (error) {
  rethrown = error;
} finally {
  console.error = originalError;
}
assert(rethrown === sentinel, 'scheduled failure handler must rethrow the original error');

const workerSource = await fs.readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
assert(workerSource.includes('ctx.waitUntil(run.catch(propagateScheduledFailure))'), 'scheduled handler must pass the propagating promise to waitUntil');
assert(!/\.catch\(\s*err\s*=>\s*console\.error\(['"]scheduled job failed/.test(workerSource), 'scheduled handler must not swallow failures with log-only catch');

console.log('Scheduled failure propagation contract validated');
