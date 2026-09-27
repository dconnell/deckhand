import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOwnedWindowBindings } from '../../src/ownedWindows.js';

function createNoopLogger() {
  return { info() {}, warn() {}, error() {} };
}

test('resolveOwnedWindowBindings binds the macWindowId of a newly-launched window', async () => {
  let launched = false;
  const entry = {
    sourceId: 'Terminal',
    snapshot() {
      return launched ? [{ windowId: 42, title: 'demo — fish' }] : [{ windowId: 7, title: 'launch terminal' }];
    },
    async launch() {
      launched = true;
      return { pid: 4321 };
    },
  };

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => {},
    logger: createNoopLogger(),
  });

  assert.deepEqual(result, { Terminal: { macWindowId: 42, pid: 4321 } });
});

test('resolveOwnedWindowBindings merges adapter session and terminal window ids into the binding', async () => {
  let launched = false;
  const itermEntry = {
    sourceId: 'ItermSource',
    snapshot() {
      return launched ? [{ windowId: 42, title: 'demo — fish' }] : [{ windowId: 7, title: 'iterm' }];
    },
    async launch() {
      launched = true;
      return { sessionId: 'session-uuid-new' };
    },
  };

  let terminalLaunched = false;
  const appleTerminalEntry = {
    sourceId: 'AppleTerminalSource',
    snapshot() {
      return terminalLaunched ? [{ windowId: 84, title: 'demo — zsh' }] : [{ windowId: 8, title: 'terminal' }];
    },
    async launch() {
      terminalLaunched = true;
      return { terminalWindowId: '1234' };
    },
  };

  const result = await resolveOwnedWindowBindings({
    entries: [itermEntry, appleTerminalEntry],
    delay: async () => {},
    logger: createNoopLogger(),
  });

  assert.equal(result.ItermSource.sessionId, 'session-uuid-new');
  assert.equal(result.AppleTerminalSource.terminalWindowId, '1234');
});

test('resolveOwnedWindowBindings polls until the new window appears', async () => {
  let launches = 0;
  let frames = [
    [{ windowId: 1, title: 'existing' }],
    [{ windowId: 1, title: 'existing' }],
    [{ windowId: 1, title: 'existing' }, { windowId: 99, title: 'real' }],
  ];
  const entry = {
    sourceId: 'Editor',
    snapshot() {
      return frames[0];
    },
    async launch() {
      launches += 1;
      return { pid: 5555 };
    },
  };

  const polls = [];
  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async (ms) => { polls.push(ms); frames.shift(); },
    retryDelayMs: 50,
    maxAttempts: 5,
    logger: createNoopLogger(),
  });

  assert.equal(launches, 1);
  assert.deepEqual(result, { Editor: { macWindowId: 99, pid: 5555 } });
  assert.ok(polls.length >= 1);
});

test('resolveOwnedWindowBindings rejects splash windows via confirm signal and keeps polling', async () => {
  let frames = [
    [{ windowId: 1, title: 'existing' }],
    [{ windowId: 1, title: 'existing' }, { windowId: 2, title: '' }],
    [{ windowId: 1, title: 'existing' }, { windowId: 3, title: 'demo — Visual Studio Code' }],
  ];
  const entry = {
    sourceId: 'Editor',
    snapshot() {
      return frames[0];
    },
    async launch() {
      return { pid: 5555 };
    },
    confirm: { rejectEmptyTitle: true },
  };

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => { frames.shift(); },
    retryDelayMs: 10,
    maxAttempts: 5,
    logger: createNoopLogger(),
  });

  assert.deepEqual(result, { Editor: { macWindowId: 3, pid: 5555 } });
});

test('resolveOwnedWindowBindings resolves multiple owned sources independently', async () => {
  const state = { termLaunched: false, appLaunched: false };
  const entries = [
    {
      sourceId: 'Terminal',
      snapshot() {
        return state.termLaunched
          ? [{ windowId: 10, title: 't1' }, { windowId: 11, title: 'new term' }]
          : [{ windowId: 10, title: 't1' }];
      },
      async launch() {
        state.termLaunched = true;
        return { pid: 100 };
      },
    },
    {
      sourceId: 'Editor',
      snapshot() {
        return state.appLaunched
          ? [{ windowId: 20, title: 'editor' }]
          : [];
      },
      async launch() {
        state.appLaunched = true;
        return {};
      },
    },
  ];

  const result = await resolveOwnedWindowBindings({
    entries,
    delay: async () => {},
    logger: createNoopLogger(),
  });

  assert.deepEqual(result, {
    Terminal: { macWindowId: 11, pid: 100 },
    Editor: { macWindowId: 20 },
  });
});

test('resolveOwnedWindowBindings omits a source when no new window appears in time', async () => {
  const entry = {
    sourceId: 'Ghost',
    snapshot() {
      return [{ windowId: 1, title: 'never changes' }];
    },
    async launch() {
      return { pid: 9 };
    },
  };
  const warnings = [];

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => {},
    maxAttempts: 2,
    retryDelayMs: 1,
    logger: { ...createNoopLogger(), warn: (m, c) => warnings.push({ m, c }) },
  });

  assert.deepEqual(result, {});
  assert.equal(warnings.length, 1);
  assert.ok(/Ghost/.test(JSON.stringify(warnings[0])));
});

test('resolveOwnedWindowBindings launch errors are logged and the source is skipped', async () => {
  const entry = {
    sourceId: 'Boom',
    snapshot() {
      return [];
    },
    async launch() {
      throw new Error('osascript failed');
    },
  };
  const errors = [];

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => {},
    logger: { ...createNoopLogger(), error: (m, c) => errors.push({ m, c }) },
  });

  assert.deepEqual(result, {});
  assert.equal(errors.length, 1);
  assert.ok(/Boom/.test(JSON.stringify(errors[0])));
});

test('resolveOwnedWindowBindings skips binding when the before-snapshot fails', async () => {
  const launchCalls = [];
  const warnings = [];
  const errors = [];
  const entry = {
    sourceId: 'Editor',
    snapshot() {
      // `null` = the snapshot itself failed (macWindows enumeration error),
      // which must never be read as "no windows existed before launch".
      return null;
    },
    launch() {
      launchCalls.push('Editor');
      return Promise.resolve({ pid: 4321 });
    },
  };

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => {},
    logger: {
      ...createNoopLogger(),
      warn: (m, c) => warnings.push({ m, c }),
      error: (m, c) => errors.push({ m, c }),
    },
  });

  assert.deepEqual(result, {});
  assert.deepEqual(launchCalls, [], 'must not launch a window it cannot bind');
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(/Editor/.test(JSON.stringify(warnings[0])));
});

test('resolveOwnedWindowBindings skips binding when the post-launch snapshot fails', async () => {
  let launched = false;
  const warnings = [];
  const errors = [];
  const entry = {
    sourceId: 'Editor',
    snapshot() {
      if (!launched) {
        return [{ windowId: 1, title: 'existing' }];
      }

      return null;
    },
    async launch() {
      launched = true;
      return { pid: 4321 };
    },
  };

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => {},
    maxAttempts: 3,
    retryDelayMs: 1,
    logger: {
      ...createNoopLogger(),
      warn: (m, c) => warnings.push({ m, c }),
      error: (m, c) => errors.push({ m, c }),
    },
  });

  assert.deepEqual(result, {});
  assert.equal(errors.length, 0);
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.some((w) => /Editor/.test(JSON.stringify(w))));
  assert.ok(
    warnings.some((w) => /snapshot failed after launch/.test(JSON.stringify(w))),
    `expected the dedicated snapshot-failed-after-launch warning, got: ${JSON.stringify(warnings)}`,
  );
});

test('resolveOwnedWindowBindings extracts pid from diff-result windows', async () => {
  let launched = false;
  const entry = {
    sourceId: 'Terminal',
    snapshot() {
      return launched
        ? [{ windowId: 7, title: 'launch terminal', pid: 4321 }, { windowId: 42, title: 'demo', pid: 4321 }]
        : [{ windowId: 7, title: 'launch terminal', pid: 4321 }];
    },
    async launch() {
      launched = true;
      return {};
    },
  };

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => {},
    logger: createNoopLogger(),
  });

  assert.deepEqual(result, { Terminal: { macWindowId: 42, pid: 4321 } });
});

test('resolveOwnedWindowBindings falls back to launchResult pid when diff windows lack one', async () => {
  let launched = false;
  const entry = {
    sourceId: 'Editor',
    snapshot() {
      return launched
        ? [{ windowId: 1, title: 'old' }, { windowId: 2, title: 'new' }]
        : [{ windowId: 1, title: 'old' }];
    },
    async launch() {
      launched = true;
      return { pid: 9999 };
    },
  };

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => {},
    logger: createNoopLogger(),
  });

  assert.deepEqual(result, { Editor: { macWindowId: 2, pid: 9999 } });
});

test('resolveOwnedWindowBindings carries sessionId from launchResult for iTerm2 closing', async () => {
  let launched = false;
  const entry = {
    sourceId: 'Terminal',
    snapshot() {
      return launched
        ? [{ windowId: 10, title: 'launch' }, { windowId: 42, title: 'new' }]
        : [{ windowId: 10, title: 'launch' }];
    },
    async launch() {
      launched = true;
      return { sessionId: 'ABCD-1234-EF56' };
    },
  };

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => {},
    logger: createNoopLogger(),
  });

  assert.equal(result.Terminal.macWindowId, 42);
  assert.equal(result.Terminal.sessionId, 'ABCD-1234-EF56');
});

test('resolveOwnedWindowBindings can require stable repeated sightings before binding', async () => {
  let launches = 0;
  let frameIndex = 0;
  const frames = [
    [{ windowId: 1, title: 'existing' }],
    [{ windowId: 1, title: 'existing' }, { windowId: 20, title: 'transient helper', width: 100, height: 100, pid: 9000 }],
    [{ windowId: 1, title: 'existing' }, { windowId: 21, title: 'editor main', width: 1200, height: 800, pid: 9000 }],
    [{ windowId: 1, title: 'existing' }, { windowId: 21, title: 'editor main', width: 1200, height: 800, pid: 9000 }],
  ];

  const entry = {
    sourceId: 'Editor',
    snapshot() {
      return frames[Math.min(frameIndex, frames.length - 1)];
    },
    async launch() {
      launches += 1;
      return {};
    },
    confirm: { stableSamples: 2 },
  };

  const delays = [];
  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async (ms) => {
      delays.push(ms);
      frameIndex += 1;
    },
    maxAttempts: 8,
    retryDelayMs: 10,
    logger: createNoopLogger(),
  });

  assert.equal(launches, 1);
  assert.ok(delays.length >= 2);
  assert.deepEqual(result, {
    Editor: { macWindowId: 21, pid: 9000 },
  });
});

test('resolveOwnedWindowBindings prefers the newest window when competing windows have equal area', async () => {
  let launched = false;
  const entry = {
    sourceId: 'Editor',
    snapshot() {
      return launched
        ? [
            { windowId: 10, title: 'existing', width: 1200, height: 800 },
            { windowId: 11, title: 'new-a', width: 1200, height: 800, pid: 7777 },
            { windowId: 12, title: 'new-b', width: 1200, height: 800, pid: 7777 },
          ]
        : [{ windowId: 10, title: 'existing', width: 1200, height: 800 }];
    },
    async launch() {
      launched = true;
      return {};
    },
  };

  const result = await resolveOwnedWindowBindings({
    entries: [entry],
    delay: async () => {},
    logger: createNoopLogger(),
  });

  assert.deepEqual(result, {
    Editor: { macWindowId: 12, pid: 7777 },
  });
});
