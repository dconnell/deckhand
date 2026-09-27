import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePort } from '../../../src/net/ports.js';

test('normalizePort accepts valid port values', () => {
  assert.equal(normalizePort(3000), 3000);
  assert.equal(normalizePort('8080'), 8080);
  assert.equal(normalizePort(' 3000 '), 3000);
  assert.equal(normalizePort(0), 0, 'port 0 asks the OS for a free port');
  assert.equal(normalizePort(65535), 65535);
});

test('normalizePort falls back when the value is not provided', () => {
  assert.equal(normalizePort(undefined, { fallback: 3000 }), 3000);
  assert.equal(normalizePort('', { fallback: 3000 }), 3000);
  assert.equal(normalizePort('   ', { fallback: 3000 }), 3000);
});

test('normalizePort rejects invalid values with a clear message', () => {
  assert.throws(
    () => normalizePort('not-a-port', { label: 'PORT environment variable' }),
    /PORT environment variable must be an integer between 0 and 65535, received "not-a-port"/,
  );
  assert.throws(() => normalizePort('3000.5', { label: 'PORT' }), /PORT must be an integer/);
  assert.throws(() => normalizePort('-1', { label: 'PORT' }), /PORT must be an integer/);
  assert.throws(() => normalizePort('65536', { label: 'PORT' }), /PORT must be an integer/);
  assert.throws(() => normalizePort(3.5, { label: 'PORT' }), /PORT must be an integer/);
  assert.throws(() => normalizePort(true, { label: 'PORT' }), /PORT must be an integer/);
  assert.throws(() => normalizePort(null, { label: 'PORT' }), /PORT must be an integer/);
});

test('normalizePort throws when the value is absent and no fallback is given', () => {
  assert.throws(() => normalizePort(undefined, { label: 'PORT' }), /PORT is required/);
});

test('normalizePort supports a custom lower bound for pinned ports', () => {
  assert.equal(normalizePort(1, { min: 1 }), 1);
  assert.throws(() => normalizePort(0, { min: 1 }), /must be an integer between 1 and 65535/);
});
