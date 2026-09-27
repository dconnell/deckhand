import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForEvent } from '../../../src/lifecycle/waitFor.js';

test('waitForEvent resolves with the payload when register fires in time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = waitForEvent(1000, 'timed out waiting', (resolve) => {
    resolve({ value: 42 });
  });

  assert.deepEqual(await pending, { value: 42 });

  // The internal timeout must be cleared once the event arrives.
  t.mock.timers.tick(5000);
});

test('waitForEvent rejects with the timeout message when no event arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = waitForEvent(250, 'timed out waiting for the event', () => {});

  const rejection = assert.rejects(pending, /timed out waiting for the event/);

  t.mock.timers.tick(250);
  await rejection;
});

test('waitForEvent ignores late events after the timeout has fired', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let deliver;
  const pending = waitForEvent(100, 'timed out waiting for the event', (resolve) => {
    deliver = resolve;
  });

  const rejection = assert.rejects(pending, /timed out waiting for the event/);

  t.mock.timers.tick(100);
  await rejection;

  // A late payload must not raise an unhandled rejection now that the race
  // has already settled.
  deliver('late payload');
  await Promise.resolve();
  await Promise.resolve();
});
