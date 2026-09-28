import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOUNDS_FALLBACK_TOLERANCE,
  buildCloseWindowByBoundsSwiftScript,
  buildCloseWindowSwiftScript,
  closeMacWindow,
  diffNewWindows,
  enumerateWindowsByOwnerName,
  enumerateWindowsByPid,
  findPidByOwnerName,
  findUniqueBoundsFallbackCandidate,
  getWindowIdsViaCGList,
} from '../../src/macWindows.js';

function withPlatform(platform, run) {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  return Promise.resolve().then(run).finally(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
}

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

test('buildCloseWindowSwiftScript emits the plain close flow by default', () => {
  const script = buildCloseWindowSwiftScript();

  assert.match(script, /"AXClose" as CFString/);
  assert.match(script, /kAXCloseButtonAttribute/);
  assert.doesNotMatch(script, /kAXSheetsAttribute/);
  assert.doesNotMatch(script, /don't save/i);
});

test('buildCloseWindowSwiftScript adds discard-without-saving handling when requested', () => {
  const script = buildCloseWindowSwiftScript({ discardUnsavedChanges: true });

  assert.match(script, /"AXSheets" as CFString/);
  assert.match(script, /don't save/i);
  assert.match(script, /discard/i);
});

test('buildCloseWindowSwiftScript discard helpers recurse through collectChildElements', () => {
  const script = buildCloseWindowSwiftScript({ discardUnsavedChanges: true });

  assert.match(script, /collectChildElements\(/);
});

test('buildCloseWindowByBoundsSwiftScript closes with literal AX action names for SDK compatibility', () => {
  const script = buildCloseWindowByBoundsSwiftScript();

  assert.match(script, /"AXClose" as CFString/);
  assert.doesNotMatch(script, /kAXCloseAction/);
});

test('buildCloseWindowByBoundsSwiftScript traverses AX descendants to resolve real AXWindow elements', () => {
  const script = buildCloseWindowByBoundsSwiftScript();

  assert.match(script, /func collectWindows\(/);
  assert.match(script, /kAXWindowRole/);
});

test('buildCloseWindowByBoundsSwiftScript keeps a strict score threshold to avoid closing the wrong window', () => {
  const script = buildCloseWindowByBoundsSwiftScript();

  // Interpolated from the JS constant so the Swift literal and JS tolerance stay in sync.
  assert.match(script, new RegExp(`bestScore <= ${BOUNDS_FALLBACK_TOLERANCE}\\b`));
});

test('buildCloseWindowByBoundsSwiftScript uses literal AX sheet attribute in discard mode', () => {
  const script = buildCloseWindowByBoundsSwiftScript({ discardUnsavedChanges: true });

  assert.match(script, /"AXSheets" as CFString/);
  assert.doesNotMatch(script, /kAXSheetsAttribute/);
});

test('buildCloseWindowSwiftScript includes close-button action in discard mode', () => {
  const script = buildCloseWindowSwiftScript({ discardUnsavedChanges: true });

  assert.match(script, /kAXPressAction/);
  assert.match(script, /AXUIElementPerformAction/);
});

test('closeMacWindow is a no-op off darwin', async () => {
  await withPlatform('linux', async () => {
    assert.equal(await closeMacWindow(42, 99), false);
  });
});

test('closeMacWindow ignores non-numeric arguments', async () => {
  assert.equal(await closeMacWindow('abc', 99), false);
  assert.equal(await closeMacWindow(42, 'xyz'), false);
  assert.equal(await closeMacWindow(undefined, 99), false);
});

test('buildCloseWindowSwiftScript targets windows by exact CGWindowID', () => {
  const script = buildCloseWindowSwiftScript();

  assert.match(script, /targetWindowId = UInt32\(CommandLine\.arguments\[1\]\)!/);
  assert.match(script, /_AXUIElementGetWindow/);
  assert.match(script, /if windowId != targetWindowId/);
});

test('enumerateWindowsByOwnerName returns [] off darwin — a platform guard, not a snapshot failure', async () => {
  await withPlatform('linux', async () => {
    assert.deepEqual(await enumerateWindowsByOwnerName('Visual Studio Code'), []);
  });
});

test('getWindowIdsViaCGList returns [] off darwin', async () => {
  await withPlatform('linux', async () => {
    assert.deepEqual(await getWindowIdsViaCGList(47213), []);
  });
});

test('enumerateWindowsByPid returns [] off darwin', async () => {
  await withPlatform('linux', async () => {
    assert.deepEqual(await enumerateWindowsByPid(47213), []);
  });
});

test('findPidByOwnerName resolves to null off darwin', async () => {
  await withPlatform('linux', async () => {
    assert.equal(await findPidByOwnerName('Visual Studio Code'), null);
  });
});

test('findUniqueBoundsFallbackCandidate returns the single same-pid window within the bounds tolerance', () => {
  const target = { windowId: 7, x: 100, y: 200, width: 1200, height: 800 };
  const windows = [
    { windowId: 99, x: 103, y: 204, width: 1202, height: 799 },
    { windowId: 50, x: 900, y: 900, width: 500, height: 400 },
  ];

  assert.deepEqual(
    findUniqueBoundsFallbackCandidate(windows, target),
    { windowId: 99, x: 103, y: 204, width: 1202, height: 799 },
  );
});

test('findUniqueBoundsFallbackCandidate keeps the Swift script boundary: total deviation of exactly 12 matches', () => {
  const target = { windowId: 7, x: 100, y: 200, width: 1200, height: 800 };
  const boundary = { windowId: 99, x: 104, y: 204, width: 1202, height: 802 };

  assert.deepEqual(findUniqueBoundsFallbackCandidate([boundary], target), boundary);
});

test('findUniqueBoundsFallbackCandidate refuses to pick when multiple same-pid windows match the tolerance', () => {
  // The VS Code incident shape: every window of the app shares one pid, so a
  // same-pid close must never guess between stacked/adjacent windows.
  const target = { windowId: 7, x: 100, y: 200, width: 1200, height: 800 };
  const windows = [
    { windowId: 21, x: 100, y: 200, width: 1200, height: 800 },
    { windowId: 22, x: 102, y: 202, width: 1200, height: 800 },
  ];

  assert.equal(findUniqueBoundsFallbackCandidate(windows, target), null);
});

test('findUniqueBoundsFallbackCandidate returns null when no same-pid window is within the tolerance', () => {
  const target = { windowId: 7, x: 100, y: 200, width: 1200, height: 800 };
  const windows = [
    { windowId: 99, x: 113, y: 200, width: 1200, height: 800 },
    { windowId: 50, x: 900, y: 900, width: 500, height: 400 },
  ];

  assert.equal(findUniqueBoundsFallbackCandidate(windows, target), null);
});

test('findUniqueBoundsFallbackCandidate returns null without a target descriptor', () => {
  assert.equal(findUniqueBoundsFallbackCandidate([{ windowId: 9, x: 0, y: 0, width: 10, height: 10 }], null), null);
});
