import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForCondition, waitForMessages } from '../helpers/waitFor.js';

test('waitForCondition resolves immediately when the check already holds', async () => {
  let calls = 0;

  await waitForCondition(() => {
    calls += 1;
    return true;
  }, { intervalMs: 1 });

  assert.equal(calls, 1);
});

test('waitForCondition polls until the check holds', async () => {
  let calls = 0;

  await waitForCondition(() => (calls += 1) >= 3, { intervalMs: 1 });

  assert.equal(calls, 3);
});

test('waitForCondition rejects with the description once the timeout elapses', async () => {
  await assert.rejects(
    waitForCondition(() => false, { timeoutMs: 20, intervalMs: 1, description: 'an impossible condition' }),
    /Timed out after 20ms waiting for an impossible condition/,
  );
});

test('waitForMessages accepts an options object with a short timeout', async () => {
  const messages = [];

  await assert.rejects(
    waitForMessages(messages, (items) => items.length >= 1, 'a message', { timeoutMs: 20 }),
    /Timed out after 20ms waiting for a message; received: \[\]/,
  );
});

test('waitForMessages resolves once the array satisfies the predicate', async () => {
  const messages = [];
  const done = waitForMessages(messages, (items) => items.some((item) => item.type === 'ready'), 'the ready message', { timeoutMs: 1000 });

  messages.push({ type: 'other' });
  await new Promise((resolve) => setImmediate(resolve));
  messages.push({ type: 'ready' });

  await done;
});
