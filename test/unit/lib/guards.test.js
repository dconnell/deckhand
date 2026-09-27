import assert from 'node:assert/strict';
import test from 'node:test';

import { isPlainObject } from '../../../src/lib/guards.js';

test('isPlainObject accepts non-null, non-array objects', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ key: 'value' }), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject(new Date()), true);

  class Widget {}

  assert.equal(isPlainObject(new Widget()), true);
});

test('isPlainObject rejects null, primitives, arrays, and functions', () => {
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject(true), false);
  assert.equal(isPlainObject(0), false);
  assert.equal(isPlainObject('text'), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject([1, 2]), false);
  assert.equal(isPlainObject(() => {}), false);
});
