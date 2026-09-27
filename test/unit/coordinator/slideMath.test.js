import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSlideDirection, extractSlideIndex } from '../../../src/coordinator.js';

test('extractSlideIndex returns a comparable h/v index, or null when absent', () => {
  assert.deepEqual(extractSlideIndex({ index: { h: 2, v: 1 } }), { h: 2, v: 1 });
  assert.deepEqual(extractSlideIndex({ index: { h: 0 } }), { h: 0, v: 0 });
  assert.equal(extractSlideIndex({ index: { v: 1 } }), null);
  assert.equal(extractSlideIndex({}), null);
  assert.equal(extractSlideIndex(null), null);
});

test('computeSlideDirection classifies forward, backward, and neutral jumps', () => {
  assert.equal(computeSlideDirection({ h: 0, v: 0 }, { h: 1, v: 0 }), 'forward');
  assert.equal(computeSlideDirection({ h: 1, v: 0 }, { h: 0, v: 0 }), 'backward');
  assert.equal(computeSlideDirection({ h: 1, v: 0 }, { h: 1, v: 2 }), 'forward');
  assert.equal(computeSlideDirection({ h: 1, v: 2 }, { h: 1, v: 0 }), 'backward');
  assert.equal(computeSlideDirection({ h: 2, v: 0 }, { h: 2, v: 0 }), 'none');
  assert.equal(computeSlideDirection(null, { h: 0, v: 0 }), 'none');
});
