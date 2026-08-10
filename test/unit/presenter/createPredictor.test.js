import assert from 'node:assert/strict';
import test from 'node:test';

import { createPredictor } from '../../../src/presenter/createPredictor.js';

test('createPredictor returns 0 before any anchor exists', () => {
  const predictor = createPredictor({ alpha: 0.5, maxRate: 4, minRate: 0.25 });

  assert.equal(predictor.predict(10_000, 20), 0);
});

test('createPredictor interpolates between matched anchors', () => {
  const predictor = createPredictor({ alpha: 1, maxRate: 4, minRate: 0.25 });

  predictor.onMatch(2, 1_000);
  predictor.onMatch(6, 3_000);

  assert.equal(predictor.predict(4_000, 20), 8);
});

test('createPredictor clamps to the current anchor and total line count', () => {
  const predictor = createPredictor({ alpha: 1, maxRate: 100, minRate: 0.25 });

  predictor.onMatch(3, 1_000);
  predictor.onMatch(9, 2_000);

  assert.equal(predictor.predict(10_000, 10), 9);
});

test('createPredictor reset clears anchor state', () => {
  const predictor = createPredictor({ alpha: 1, maxRate: 4, minRate: 0.25 });

  predictor.onMatch(2, 1_000);
  predictor.reset();

  assert.equal(predictor.predict(2_000, 20), 0);
});
