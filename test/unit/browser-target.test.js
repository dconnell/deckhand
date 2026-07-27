import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STORAGE_KEY,
  buildTargetRegistrationMessage,
  parseIdentityParams,
  readStoredIdentity,
  resolveTargetIdentity,
  shouldNavigate,
  validateTargetIdentity,
  writeStoredIdentity,
} from '../../src/targets/browser.js';

function createStorage() {
  const values = new Map();

  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test('parseIdentityParams extracts controllerId and tabId from the query string', () => {
  assert.deepEqual(parseIdentityParams('?controllerId=demo1&tabId=tabA'), {
    controllerId: 'demo1',
    tabId: 'tabA',
  });
});

test('resolveTargetIdentity gives URL params precedence over stored values field by field', () => {
  assert.deepEqual(
    resolveTargetIdentity({
      searchParams: parseIdentityParams('?controllerId=demo2'),
      storedIdentity: { controllerId: 'demo1', tabId: 'tabA' },
    }),
    {
      controllerId: 'demo2',
      tabId: 'tabA',
      shouldPersist: true,
    },
  );
});

test('validateTargetIdentity rejects colons in identifiers', () => {
  assert.throws(() => validateTargetIdentity({ controllerId: 'demo:1', tabId: null }), /not allowed/i);
  assert.throws(() => validateTargetIdentity({ controllerId: 'demo1', tabId: 'tab:A' }), /not allowed/i);
});

test('writeStoredIdentity and readStoredIdentity round-trip the persisted identity', () => {
  const storage = createStorage();
  const identity = { controllerId: 'demo1', tabId: 'tabA' };

  writeStoredIdentity(storage, identity);

  assert.deepEqual(readStoredIdentity(storage), identity);
  assert.ok(storage.getItem(STORAGE_KEY));
});

test('buildTargetRegistrationMessage includes target capabilities', () => {
  assert.deepEqual(buildTargetRegistrationMessage({ controllerId: 'demo1', tabId: 'tabA' }), {
    type: 'register',
    role: 'target',
    controllerId: 'demo1',
    tabId: 'tabA',
    capabilities: ['navigate'],
  });
});

test('shouldNavigate skips exact same-url navigations', () => {
  assert.equal(shouldNavigate('https://example.com/demo', 'https://example.com/demo'), false);
  assert.equal(shouldNavigate('https://example.com/demo', 'https://example.com/other'), true);
});
