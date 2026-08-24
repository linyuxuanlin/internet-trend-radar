import { normalizePublishedAt } from '../src/sources/dailyhot.js';

const cases = [
  ['seconds', 1710000000, '2024-03-09T16:00:00.000Z'],
  ['milliseconds', 1710000000000, '2024-03-09T16:00:00.000Z'],
  ['ISO', '2024-03-09T16:00:00.000Z', '2024-03-09T16:00:00.000Z'],
  ['invalid', 'not-a-date', null]
];
for (const [label, input, expected] of cases) {
  const actual = normalizePublishedAt(input);
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
console.log('Published-time normalization validated: seconds, milliseconds, ISO, and invalid values are handled explicitly');
