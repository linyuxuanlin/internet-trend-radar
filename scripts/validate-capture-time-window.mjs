import { validateCapturedAt } from '../src/collector.js';

const now = Date.parse('2026-08-25T00:00:00.000Z');
const item = capturedAt => ({ capturedAt });
validateCapturedAt([item('2026-08-24T23:59:00.000Z')], 'fixture', now);
for (const [label, capturedAt] of [
  ['invalid', 'not-a-date'],
  ['future', '2026-08-25T00:06:00.000Z'],
  ['old', '2026-08-23T23:59:00.000Z']
]) {
  let rejected = false;
  try { validateCapturedAt([item(capturedAt)], 'fixture', now); } catch { rejected = true; }
  if (!rejected) throw new Error(`${label} capturedAt was accepted`);
}
console.log('Capture-time window validated: only valid, current collection timestamps may enter the trend store');
