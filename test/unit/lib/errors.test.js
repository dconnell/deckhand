import assert from 'node:assert/strict';
import test from 'node:test';

import { errorMessage } from '../../../src/lib/errors.js';

test('errorMessage returns the message of Error instances', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
});

test('errorMessage returns the message of Error subclasses', () => {
  assert.equal(errorMessage(new TypeError('wrong type')), 'wrong type');
});

test('errorMessage stringifies non-Error throw values', () => {
  assert.equal(errorMessage('plain failure'), 'plain failure');
  assert.equal(errorMessage(42), '42');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage(undefined), 'undefined');
  assert.equal(errorMessage({ code: 'ENOENT' }), '[object Object]');
});
