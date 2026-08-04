import assert from 'node:assert/strict';
import test from 'node:test';

import { closeMacWindow, diffNewWindows, findPidByOwnerName } from '../../src/macWindows.js';

test('diffNewWindows returns windows present in after but absent from before', () => {
  const before = [
    { windowId: 1, title: 'Existing' },
    { windowId: 2, title: 'Launch Terminal' },
  ];
  const after = [
    { windowId: 1, title: 'Existing' },
    { windowId: 2, title: 'Launch Terminal' },
    { windowId: 3, title: 'New Window' },
  ];

  assert.deepEqual(diffNewWindows(before, after), [{ windowId: 3, title: 'New Window' }]);
});

test('diffNewWindows returns empty when no new windows appeared', () => {
  const before = [{ windowId: 1, title: 'Existing' }];
  const after = [{ windowId: 1, title: 'Existing' }];

  assert.deepEqual(diffNewWindows(before, after), []);
});

test('diffNewWindows returns every newly-appeared window when several appear at once', () => {
  const before = [{ windowId: 1, title: 'A' }];
  const after = [
    { windowId: 1, title: 'A' },
    { windowId: 2, title: 'B' },
    { windowId: 3, title: 'C' },
  ];

  assert.deepEqual(diffNewWindows(before, after), [
    { windowId: 2, title: 'B' },
    { windowId: 3, title: 'C' },
  ]);
});

test('diffNewWindows treats a disappeared-and-recreated window as new', () => {
  const before = [{ windowId: 10, title: 'Old' }];
  const after = [{ windowId: 99, title: 'Recreated' }];

  assert.deepEqual(diffNewWindows(before, after), [{ windowId: 99, title: 'Recreated' }]);
});

test('diffNewWindows rejects transient splash windows by empty title when rejectEmptyTitle is set', () => {
  const before = [{ windowId: 1, title: 'Existing' }];
  const after = [
    { windowId: 1, title: 'Existing' },
    { windowId: 2, title: '' },
    { windowId: 3, title: 'Real Window' },
  ];

  assert.deepEqual(
    diffNewWindows(before, after, { rejectEmptyTitle: true }),
    [{ windowId: 3, title: 'Real Window' }],
  );
});

test('diffNewWindows keeps empty-title windows by default so identity is never lost', () => {
  const before = [];
  const after = [{ windowId: 5, title: '' }];

  assert.deepEqual(diffNewWindows(before, after), [{ windowId: 5, title: '' }]);
});

test('diffNewWindows confirms against a titleIncludes signal, returning only matching new windows', () => {
  const before = [{ windowId: 1, title: 'Existing' }];
  const after = [
    { windowId: 1, title: 'Existing' },
    { windowId: 2, title: 'Splash' },
    { windowId: 3, title: 'demo — Visual Studio Code' },
  ];

  assert.deepEqual(
    diffNewWindows(before, after, { titleIncludes: 'Visual Studio Code' }),
    [{ windowId: 3, title: 'demo — Visual Studio Code' }],
  );
});

test('diffNewWindows returns empty when only splash windows have appeared so far', () => {
  const before = [{ windowId: 1, title: 'Existing' }];
  const after = [
    { windowId: 1, title: 'Existing' },
    { windowId: 2, title: '' },
  ];

  assert.deepEqual(diffNewWindows(before, after, { rejectEmptyTitle: true }), []);
});

test('diffNewWindows combines rejectEmptyTitle and titleIncludes confirmation', () => {
  const before = [];
  const after = [
    { windowId: 1, title: '' },
    { windowId: 2, title: 'Unrelated' },
    { windowId: 3, title: 'index.js - demo - Visual Studio Code' },
  ];

  assert.deepEqual(
    diffNewWindows(before, after, {
      rejectEmptyTitle: true,
      titleIncludes: 'Visual Studio Code',
    }),
    [{ windowId: 3, title: 'index.js - demo - Visual Studio Code' }],
  );
});

test('closeMacWindow is a no-op off darwin', () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

  try {
    assert.doesNotThrow(() => closeMacWindow(42, 99));
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
});

test('closeMacWindow ignores non-numeric arguments', () => {
  assert.doesNotThrow(() => closeMacWindow('abc', 99));
  assert.doesNotThrow(() => closeMacWindow(42, 'xyz'));
  assert.doesNotThrow(() => closeMacWindow(undefined, 99));
});

test('findPidByOwnerName returns null when no windows match the owner name', () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

  try {
    assert.equal(findPidByOwnerName('NonexistentApp'), null);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
});
