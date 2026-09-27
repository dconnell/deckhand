import assert from 'node:assert/strict';
import test from 'node:test';

import { delay, withTimeout } from '../../../src/lifecycle/time.js';

test('delay resolves only after the requested delay elapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let settled = false;
  const pending = delay(50).then(() => {
    settled = true;
  });

  t.mock.timers.tick(49);
  assert.equal(settled, false);

  t.mock.timers.tick(1);
  await pending;
  assert.equal(settled, true);
});

test('withTimeout resolves with the wrapped promise value when it settles first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const result = await withTimeout(Promise.resolve('value'), 1000, 'timed out');

  assert.equal(result, 'value');

  // If the timeout had leaked, this tick would raise an unhandled rejection.
  t.mock.timers.tick(2000);
});

test('withTimeout rejects with the timeout message when the timer fires first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { promise, resolve } = Promise.withResolvers();
  const pending = withTimeout(promise, 250, 'operation timed out');

  const rejection = assert.rejects(pending, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'operation timed out');
    return true;
  });

  t.mock.timers.tick(250);
  await rejection;

  // A late resolution after the timeout must not surface anywhere.
  resolve('late');
  await Promise.resolve();
  await Promise.resolve();
});

test('withTimeout clears the pending timer when the wrapped promise rejects first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = withTimeout(Promise.reject(new Error('inner failure')), 1000, 'timed out');

  await assert.rejects(pending, /inner failure/);

  // If the timeout had leaked, this tick would raise an unhandled rejection.
  t.mock.timers.tick(2000);
});
