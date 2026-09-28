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

function createStubEmitter() {
  const handlers = new Set();

  return {
    handlers,
    on(eventName, handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(payload) {
      for (const handler of handlers) {
        handler(payload);
      }
    },
  };
}

test('waitForEvent unsubscribes the registered listener when the event resolves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const emitter = createStubEmitter();
  const pending = waitForEvent(1000, 'timed out waiting', (resolve) => {
    return emitter.on('event', resolve);
  });

  assert.equal(emitter.handlers.size, 1);

  emitter.emit({ value: 42 });

  assert.deepEqual(await pending, { value: 42 });
  assert.equal(emitter.handlers.size, 0, 'the listener must be removed once the wait resolves');

  // The internal timeout must be cleared once the event arrives.
  t.mock.timers.tick(5000);
});

test('waitForEvent unsubscribes the registered listener when the wait times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const emitter = createStubEmitter();
  const pending = waitForEvent(100, 'timed out waiting for the event', (resolve) => {
    return emitter.on('event', resolve);
  });

  assert.equal(emitter.handlers.size, 1);

  const rejection = assert.rejects(pending, /timed out waiting for the event/);

  t.mock.timers.tick(100);
  await rejection;

  assert.equal(emitter.handlers.size, 0, 'the listener must be removed once the wait times out');

  // A late event must not reach the removed listener, so no stray resolution
  // or unhandled rejection can surface after the timeout.
  emitter.emit('late payload');
  await Promise.resolve();
  await Promise.resolve();
});

test('waitForEvent works when the register callback returns no cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = waitForEvent(1000, 'timed out waiting', (resolve) => {
    resolve('delivered');
  });

  assert.equal(await pending, 'delivered');

  t.mock.timers.tick(5000);
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
