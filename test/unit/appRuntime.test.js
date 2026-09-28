import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBootstrapBinding,
  buildObsWindowBindings,
  closeOwnedAppWindows,
  createOwnedWindowResolutionEntries,
  seedBrowserMacWindowBindings,
  terminateProcessGroup,
} from '../../src/appRuntime.js';
import { createCaptureLogger as createLogger } from '../helpers/logger.js';

/**
 * Install a stub for `process.kill` that records every call. The ESRCH error
 * thrown for missing process groups must mirror the real error shape so
 * `isMissingProcessError` recognizes it.
 *
 * @param {(pid: number, signal: number | string) => void} impl Stub body.
 * @returns {{ calls: Array<{ pid: number, signal: number | string }>, restore: () => void }} Recorded calls and the restore fn.
 */
function stubProcessKill(impl) {
  const original = process.kill;
  const calls = [];

  process.kill = (pid, signal) => {
    calls.push({ pid, signal });
    impl(pid, signal);
  };

  return {
    calls,
    restore() {
      process.kill = original;
    },
  };
}

/**
 * Build an ESRCH-shaped error, as Node raises for missing processes.
 * @returns {Error}
 */
function createMissingProcessError() {
  const error = new Error('no such process');
  error.code = 'ESRCH';
  return error;
}

test('terminateProcessGroup exits early when the process group is already gone', async () => {
  const logger = createLogger();
  const { calls: killCalls, restore } = stubProcessKill((pid, signal) => {
    if (signal === 0) {
      throw createMissingProcessError();
    }
  });

  try {
    const startedAt = Date.now();
    await terminateProcessGroup(47213, logger, 'Terminal', 1000);
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 500, `early exit must not wait the full grace period (took ${elapsedMs}ms)`);
    assert.equal(logger.warns.length, 0, 'a clean early exit must not warn');
    assert.deepEqual(killCalls[0], { pid: -47213, signal: 'SIGTERM' });
    assert.deepEqual(
      killCalls.filter((call) => call.signal === 'SIGKILL'),
      [],
      'an already-exited group must not be escalated to SIGKILL',
    );
    assert.ok(killCalls.some((call) => call.signal === 0), 'probes the group before concluding it is gone');
  } finally {
    restore();
  }
});

test('terminateProcessGroup escalates to SIGKILL only after the group survives the full grace period', async () => {
  const logger = createLogger();
  const { calls: killCalls, restore } = stubProcessKill(() => {
    // SIGTERM and every probe succeed — the group refuses to die.
  });

  try {
    await terminateProcessGroup(47213, logger, 'Terminal', 80);
  } finally {
    restore();
  }

  assert.equal(killCalls[0]?.signal, 'SIGTERM');
  assert.ok(
    killCalls.some((call) => call.signal === 0),
    'polls the process group instead of sleeping the whole grace in one block',
  );
  assert.ok(
    killCalls.some((call) => call.signal === 'SIGKILL'),
    'a group that survives the grace period is escalated to SIGKILL',
  );
  assert.ok(logger.warns.some((entry) => /SIGKILL/.test(entry.message)), 'escalation is logged as a warning');
});

test('terminateProcessGroup skips the wait entirely when the group vanished before SIGTERM', async () => {
  const logger = createLogger();
  const { calls: killCalls, restore } = stubProcessKill(() => {
    throw createMissingProcessError();
  });

  try {
    await terminateProcessGroup(47213, logger, 'Terminal', 1000);
  } finally {
    restore();
  }

  assert.deepEqual(killCalls, [{ pid: -47213, signal: 'SIGTERM' }]);
  assert.equal(logger.warns.length, 0, 'a vanished group is not an error');
});

test('terminateProcessGroup warns and does not escalate when the process group cannot be probed', async () => {
  const logger = createLogger();
  const { calls: killCalls, restore } = stubProcessKill((pid, signal) => {
    if (signal === 0) {
      throw new Error('operation not permitted');
    }
  });

  try {
    await terminateProcessGroup(47213, logger, 'Terminal', 100);
  } finally {
    restore();
  }

  assert.equal(logger.errors.length, 0);
  assert.ok(
    logger.warns.some((entry) => /Failed to probe owned app process group/.test(entry.message)),
    'an opaque probe failure must be logged as a warning',
  );
  assert.deepEqual(
    killCalls.filter((call) => call.signal === 'SIGKILL'),
    [],
    'an unreadable process group must never be escalated to SIGKILL',
  );
});

/**
 * Assert that `actual` carries at least the properties in `expectedSubset`,
 * without pinning extra keys the launch options may legitimately omit.
 */
function assertContainsProps(actual, expectedSubset) {
  for (const [key, value] of Object.entries(expectedSubset)) {
    assert.deepEqual(actual[key], value, `property "${key}" should match`);
  }
}

test('createOwnedWindowResolutionEntries uses adapter CGWindow owner names and custom launch hooks', async () => {
  const logger = createLogger();
  const launches = [];
  const entries = createOwnedWindowResolutionEntries({
    config: {
      sources: {
        Terminal: { id: 'Terminal', kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
        Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code', args: ['/repos/demo'] },
      },
    },
    logger,
    enumerateWindowsByOwnerNameFn(ownerName) {
      launches.push({ type: 'snapshot', ownerName });
      return [];
    },
    launchAppWindowFn(options) {
      launches.push({ type: 'open', options });
      return Promise.resolve({ ownerName: options.app });
    },
    launchIterm2WindowFn(options) {
      launches.push({ type: 'iterm2', options });
      return Promise.resolve({ sessionId: 'session-1', pid: 4321 });
    },
  });

  assert.equal(entries.length, 2);
  entries[0].snapshot();
  entries[1].snapshot();
  await entries[0].launch();
  await entries[1].launch();

  assert.deepEqual(launches.slice(0, 3), [
    { type: 'snapshot', ownerName: 'iTerm' },
    { type: 'snapshot', ownerName: 'Code' },
    { type: 'iterm2', options: { command: 'npm run dev', cwd: '/repos/demo' } },
  ]);
  assert.equal(launches.length, 4);
  assert.equal(launches[3].type, 'open');
  assertContainsProps(launches[3].options, {
    app: 'Visual Studio Code',
    args: ['--new-window', '/repos/demo'],
  });
  const terminalEntry = entries.find((entry) => entry.sourceId === 'Terminal');
  const editorEntry = entries.find((entry) => entry.sourceId === 'Editor');

  assert.deepEqual(terminalEntry?.confirm, undefined);
  assert.deepEqual(editorEntry?.confirm, { stableSamples: 2 });
});

test('createOwnedWindowResolutionEntries routes Apple Terminal, Ghostty, kitty, and Alacritty through their dedicated launchers', async () => {
  const logger = createLogger();
  const launches = [];
  const entries = createOwnedWindowResolutionEntries({
    config: {
      sources: {
        AppleTerminal: { id: 'AppleTerminal', kind: 'app', app: 'Terminal', command: 'npm run dev', cwd: '/repos/demo' },
        Ghostty: { id: 'Ghostty', kind: 'app', app: 'Ghostty', command: 'npm run dev', cwd: '/repos/demo' },
        Kitty: { id: 'Kitty', kind: 'app', app: 'kitty', command: 'npm run dev', cwd: '/repos/demo' },
        Alacritty: { id: 'Alacritty', kind: 'app', app: 'Alacritty', command: 'npm run dev', cwd: '/repos/demo' },
      },
    },
    logger,
    enumerateWindowsByOwnerNameFn(ownerName) {
      launches.push({ type: 'snapshot', ownerName });
      return [];
    },
    launchAppWindowFn(options) {
      launches.push({ type: 'open', options });
      return Promise.resolve({ ownerName: options.app });
    },
    launchIterm2WindowFn() { launches.push({ type: 'iterm2' }); return Promise.resolve({}); },
    launchTerminalWindowFn(options) {
      launches.push({ type: 'appleTerminal', options });
      return Promise.resolve({ pid: 100, terminalWindowId: '5000' });
    },
    launchGhosttyWindowFn(options) {
      launches.push({ type: 'ghostty', options });
      return Promise.resolve({ pid: 200, ghosttyWindowId: 'tab-group-xyz' });
    },
    launchKittyWindowFn(options) {
      launches.push({ type: 'kitty', options });
      return Promise.resolve({ pid: 300, kittyWindowId: '42' });
    },
    launchAlacrittyWindowFn(options) {
      launches.push({ type: 'alacritty', options });
      return Promise.resolve({ pid: 400 });
    },
  });

  for (const entry of entries) {
    entry.snapshot();
    await entry.launch();
  }

  assert.deepEqual(launches, [
    { type: 'snapshot', ownerName: 'Terminal' },
    { type: 'appleTerminal', options: { command: 'npm run dev', cwd: '/repos/demo' } },
    { type: 'snapshot', ownerName: 'Ghostty' },
    { type: 'ghostty', options: { command: 'npm run dev', cwd: '/repos/demo' } },
    { type: 'snapshot', ownerName: 'kitty' },
    { type: 'kitty', options: { command: 'npm run dev', cwd: '/repos/demo' } },
    { type: 'snapshot', ownerName: 'Alacritty' },
    { type: 'alacritty', options: { command: 'npm run dev', cwd: '/repos/demo' } },
  ]);
});

test('createOwnedWindowResolutionEntries forwards source files to the generic launcher', async () => {
  const logger = createLogger();
  const launches = [];
  const entries = createOwnedWindowResolutionEntries({
    config: {
      sources: {
        Image: { id: 'Image', kind: 'app', app: 'Preview', files: ['/abs/image.jpg'] },
      },
    },
    logger,
    enumerateWindowsByOwnerNameFn() {
      return [];
    },
    launchAppWindowFn(options) {
      launches.push(options);
      return Promise.resolve({ ownerName: options.app });
    },
  });

  await entries[0].launch();

  assert.equal(launches.length, 1);
  assertContainsProps(launches[0], {
    app: 'Preview',
    files: ['/abs/image.jpg'],
  });
});

test('createOwnedWindowResolutionEntries forwards openArgs verbatim and skips args/files', async () => {
  const logger = createLogger();
  const launches = [];
  const entries = createOwnedWindowResolutionEntries({
    config: {
      sources: {
        Site: { id: 'Site', kind: 'app', app: 'Safari', openArgs: ['-g', 'https://example.com'] },
      },
    },
    logger,
    enumerateWindowsByOwnerNameFn() {
      return [];
    },
    launchAppWindowFn(options) {
      launches.push(options);
      return Promise.resolve({ ownerName: options.app });
    },
  });

  await entries[0].launch();

  assert.equal(launches.length, 1);
  assert.equal(launches[0].app, 'Safari');
  assert.deepEqual(launches[0].openArgs, ['-g', 'https://example.com']);
  assert.equal(launches[0].args, undefined);
  assert.equal(launches[0].files, undefined);
});

test('buildBootstrapBinding uses adapter bootstrap app names while preserving titleIncludes', () => {
  assert.deepEqual(
    buildBootstrapBinding(
      { id: 'Terminal', kind: 'app', app: 'iTerm2' },
      { app: 'Wrong App Name', titleIncludes: 'demo — fish' },
    ),
    { app: 'iTerm2', titleIncludes: 'demo — fish' },
  );

  assert.deepEqual(
    buildBootstrapBinding(
      { id: 'Editor', kind: 'app', app: 'Visual Studio Code' },
      { titleIncludes: 'index.js - demo' },
    ),
    { app: 'Visual Studio Code', titleIncludes: 'index.js - demo' },
  );
});

test('buildObsWindowBindings uses CGWindow owner names for app sources', () => {
  const config = {
    sources: {
      Terminal: { id: 'Terminal', kind: 'app', app: 'iTerm2' },
      Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' },
    },
    presenter: { windows: {} },
  };

  assert.deepEqual(buildObsWindowBindings(config, {
    Terminal: { macWindowId: 555, pid: 4321 },
    Editor: { macWindowId: 888 },
  }), {
    Terminal: { app: 'iTerm', macWindowId: 555, pid: 4321, strict: true },
    Editor: { app: 'Code', macWindowId: 888, strict: true },
  });
});

test('closeOwnedAppWindows uses the adapter close path for iTerm2 and AX close for default apps', async () => {
  const logger = createLogger();
  const closeCalls = [];
  const iterm2Closes = [];

  await closeOwnedAppWindows({
    entries: [
      {
        sourceId: 'Terminal',
        source: { id: 'Terminal', kind: 'app', app: 'iTerm2' },
        binding: { sourceId: 'Terminal', sessionId: 'session-1', macWindowId: 555, pid: 4321 },
      },
      {
        sourceId: 'Editor',
        source: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' },
        binding: { sourceId: 'Editor', macWindowId: 888, pid: 9999 },
      },
    ],
    logger,
    closeMacWindowFn(macWindowId, pid, options) {
      closeCalls.push({ macWindowId, pid, options });
      return true;
    },
    closeIterm2OwnedWindowFn(sessionId) {
      iterm2Closes.push(sessionId);
    },
  });

  assert.deepEqual(iterm2Closes, ['session-1']);
  assert.deepEqual(closeCalls, [{
    macWindowId: 888,
    pid: 9999,
    options: { discardUnsavedChanges: true },
  }]);
});

test('closeOwnedAppWindows routes Apple Terminal, Ghostty, and kitty close handles through their dedicated primitives', async () => {
  const logger = createLogger();
  const terminalCloses = [];
  const ghosttyCloses = [];
  const kittyCloses = [];

  await closeOwnedAppWindows({
    entries: [
      {
        sourceId: 'AppleTerminal',
        source: { id: 'AppleTerminal', kind: 'app', app: 'Terminal' },
        binding: { sourceId: 'AppleTerminal', terminalWindowId: '5000', macWindowId: 111, pid: 100 },
      },
      {
        sourceId: 'Ghostty',
        source: { id: 'Ghostty', kind: 'app', app: 'Ghostty' },
        binding: { sourceId: 'Ghostty', ghosttyWindowId: 'tab-group-xyz', macWindowId: 222, pid: 200 },
      },
      {
        sourceId: 'Kitty',
        source: { id: 'Kitty', kind: 'app', app: 'kitty' },
        binding: { sourceId: 'Kitty', kittyWindowId: '42', macWindowId: 333, pid: 300 },
      },
    ],
    logger,
    closeMacWindowFn() { return true; },
    closeIterm2OwnedWindowFn() {},
    closeTerminalOwnedWindowFn(windowId) { terminalCloses.push(windowId); },
    closeGhosttyOwnedWindowFn(windowId) { ghosttyCloses.push(windowId); },
    closeKittyOwnedWindowFn(windowId) { kittyCloses.push(windowId); },
  });

  assert.deepEqual(terminalCloses, ['5000']);
  assert.deepEqual(ghosttyCloses, ['tab-group-xyz']);
  assert.deepEqual(kittyCloses, ['42']);
});

test('createOwnedWindowResolutionEntries marks Slack navigation-mode sources as skipDiff and routes them through the generic open launcher', async () => {
  const logger = createLogger();
  const launches = [];
  const chromeLaunches = [];

  const entries = createOwnedWindowResolutionEntries({
    config: {
      sources: {
        QnA: {
          id: 'QnA',
          kind: 'app',
          app: 'Slack',
          slack: { target: 'channel', team: 'T1', id: 'C1' },
        },
      },
    },
    logger,
    enumerateWindowsByOwnerNameFn() { return []; },
    launchAppWindowFn(options) {
      launches.push(options);
      return Promise.resolve({});
    },
    launchChromeWindowWithUrlFn(url) {
      chromeLaunches.push(url);
      return Promise.resolve({});
    },
  });

  const qna = entries[0];
  assert.equal(qna.skipDiff, true);
  await qna.launch();

  assert.deepEqual(launches, [
    { app: 'Slack', openArgs: ['slack://channel?team=T1&id=C1'] },
  ]);
  assert.deepEqual(chromeLaunches, []);
});

test('createOwnedWindowResolutionEntries marks Slack browser-mode sources as diff-bound and routes them through the Chrome launcher', async () => {
  const logger = createLogger();
  const launches = [];
  const chromeLaunches = [];

  const entries = createOwnedWindowResolutionEntries({
    config: {
      sources: {
        QnA: {
          id: 'QnA',
          kind: 'app',
          app: 'Slack',
          slack: { target: 'channel', team: 'T1', id: 'C1', newWindow: true },
        },
      },
    },
    logger,
    enumerateWindowsByOwnerNameFn() { return []; },
    launchAppWindowFn() { launches.push('open'); return Promise.resolve({}); },
    launchChromeWindowWithUrlFn(url) {
      chromeLaunches.push(url);
      return Promise.resolve({ pid: 4242 });
    },
  });

  const qna = entries[0];
  assert.equal(qna.skipDiff, false);
  await qna.launch();

  assert.deepEqual(launches, []);
  assert.deepEqual(chromeLaunches, ['https://app.slack.com/client/T1/C1']);
});

test('closeOwnedAppWindows skips sources whose adapter declares ownsWindow(source) === false', async () => {
  const logger = createLogger();
  const closeCalls = [];

  await closeOwnedAppWindows({
    entries: [
      {
        sourceId: 'QnA',
        source: { id: 'QnA', kind: 'app', app: 'Slack', slack: { team: 'T1', id: 'C1' } },
        binding: { sourceId: 'QnA', macWindowId: 123, pid: 456 },
      },
    ],
    logger,
    closeMacWindowFn(macWindowId, pid) {
      closeCalls.push({ macWindowId, pid });
      return true;
    },
  });

  assert.deepEqual(closeCalls, []);
});

test('closeOwnedAppWindows warns and does not escalate when tracked app close does not confirm', async () => {
  const logger = createLogger();

  await closeOwnedAppWindows({
    entries: [{
      sourceId: 'Editor',
      source: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' },
      binding: { sourceId: 'Editor', macWindowId: 888, pid: 9999 },
    }],
    logger,
    closeMacWindowFn() {
      return false;
    },
    closeIterm2OwnedWindowFn() {},
  });

  assert.equal(logger.warns.length, 1);
  assert.match(logger.warns[0].message, /leaving app process running/i);
});

test('closeOwnedAppWindows awaits closeMacWindowFn implementations that resolve asynchronously', async () => {
  // The real `closeMacWindow` is async after the Phase B subprocess
  // conversion; the close flow must wait for the promise and read its
  // resolved boolean, not treat the promise itself as truthy.
  const logger = createLogger();

  await closeOwnedAppWindows({
    entries: [
      {
        sourceId: 'Confirmed',
        source: { id: 'Confirmed', kind: 'app', app: 'Visual Studio Code' },
        binding: { sourceId: 'Confirmed', macWindowId: 888, pid: 9999 },
      },
      {
        sourceId: 'Unconfirmed',
        source: { id: 'Unconfirmed', kind: 'app', app: 'Visual Studio Code' },
        binding: { sourceId: 'Unconfirmed', macWindowId: 777, pid: 8888 },
      },
    ],
    logger,
    async closeMacWindowFn(macWindowId) {
      return macWindowId === 888;
    },
    closeIterm2OwnedWindowFn() {},
  });

  assert.equal(logger.warns.length, 1);
  assert.match(logger.warns[0].message, /leaving app process running/i);
  assert.equal(logger.warns[0].context.source, 'Unconfirmed');
});

test('seedBrowserMacWindowBindings seeds macWindowId from the browser-session registry', () => {
  const browserSession = {
    getStatus() { return { chromePid: 47213 }; },
    getRegistry() {
      return {
        sources: {
          Slide: { macWindowId: 11111 },
          BrowserA: { macWindowId: 12345 },
          BrowserB: { macWindowId: null },
        },
      };
    },
  };

  const result = seedBrowserMacWindowBindings({
    browserSession,
    browserSourceIds: ['Slide', 'BrowserA', 'BrowserB'],
  });

  assert.deepEqual(result, {
    Slide: { macWindowId: 11111, pid: 47213 },
    BrowserA: { macWindowId: 12345, pid: 47213 },
  });
});

test('seedBrowserMacWindowBindings omits pid when chromePid is unknown', () => {
  const browserSession = {
    getStatus() { return { chromePid: null }; },
    getRegistry() {
      return { sources: { Slide: { macWindowId: 11111 } } };
    },
  };

  const result = seedBrowserMacWindowBindings({
    browserSession,
    browserSourceIds: ['Slide'],
  });

  assert.deepEqual(result, { Slide: { macWindowId: 11111 } });
});
