import { scoreFromNormalizedComponents, scoreItem, scoreItemNormalized } from '../src/utils.js';

const cases = [
  ['rank dominates within one source', scoreItem(1, 50, 100000, 0) > scoreItem(50, 50, 100000, 0)],
  ['raw heat is a diminishing signal', scoreItem(1, 50, 100000000, 0) - scoreItem(1, 50, 100, 0) < 24],
  ['missing heat is not silently replaced by a positive value', scoreItem(1, 50, 0, 0) < scoreItem(1, 50, 100000, 0)],
  ['engagement is also diminishing', scoreItem(1, 50, 0, 100000000) - scoreItem(1, 50, 0, 100) < 18],
  ['score stays bounded', [scoreItem(1, 50, 0, 0), scoreItem(50, 50, 100000000, 100000000)].every(x => x >= 0 && x <= 100)]
];

const productionCases = [
  ['production rank dominates within one source', scoreItemNormalized(1, 50, 0, 0) > scoreItemNormalized(50, 50, 1, 1)],
  ['production missing percentiles do not become positive', scoreItemNormalized(1, 50, 0, 0) < scoreItemNormalized(1, 50, 1, 1)],
  ['production normalized score stays bounded', [
    scoreItemNormalized(1, 50, 0, 0),
    scoreItemNormalized(50, 50, 1, 1),
    scoreItemNormalized(1, 50, 2, -1)
  ].every(x => x >= 0 && x <= 100)],
  ['observed rank span keeps source list lengths comparable', scoreFromNormalizedComponents(30, 0, 0) < scoreFromNormalizedComponents(100, 0, 0)]
];

for (const [name, ok] of [...cases, ...productionCases]) {
  if (!ok) throw new Error(`score integrity failed: ${name}`);
}

console.log(`Score integrity validated: ${cases.length + productionCases.length} invariants`);
