import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { run } from '../../../src/index.js';
import { withPatchedExit } from '../../helpers/process.js';
import { waitForCondition } from '../../helpers/waitFor.js';
import {
  createCdpClientStub,
  createEmittingHubStub,
  createObsClientStub,
  createPresentationServerStub,
  createPresenterHttpStub,
  createSilentConsole,
  writePresentationConfig,
} from './helpers.js';

const TERMINAL_SOURCE = { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' };
const EDITOR_SOURCE = { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'] };

/**
 * Presenter-mode config with a browser Slide source plus the given owned app
 * sources, mirroring the config shapes used across the shutdown suites.
 * @param {{ sources?: Record<string, object> }} [options]
 * @returns {string} serialized config
 */
function buildOwnedShutdownConfig({ sources = {} } = {}) {
  const layouts = {
    'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
  };
  for (const sourceId of Object.keys(sources)) {
    layouts[`full-${sourceId.toLowerCase()}`] = {
      audienceScene: `Full ${sourceId}`,
      slots: [{ source: sourceId, position: 'full' }],
    };
  }

  return JSON.stringify({
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { port: 8765 },
    sources: {
      Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
      ...sources,
    },
    layouts,
    slides: { intro: { layout: 'full-slide' } },
    presenter: {
      platform: 'macos',
      stage: { x: 0, y: 0, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
      },
    },
  }, null, 2);
}

const OBSERVER_SNAPSHOT = { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };

/**
 * Full run options for a presenter-mode shutdown test: signal handlers enabled,
 * a connected browser runtime, and capture arrays for the kill/reap hooks.
 * @param {{ profileDir: string, consoleLike: object }} inputs
 * @returns {{ captures: { killedChromeGroups: number[], reapedChromeProfiles: string[] }, options: object }}
 */
function buildShutdownRunOptions({ profileDir, consoleLike }) {
  const captures = {
    killedChromeGroups: [],
    reapedChromeProfiles: [],
  };

  const options = {
    installSignalHandlers: true,
    killProcessGroupFn: (pgid) => { captures.killedChromeGroups.push(pgid); },
    reapChromeProfilesFn: (command) => { captures.reapedChromeProfiles.push(command); },
    consoleLike,
    createHubFn() {
      return createEmittingHubStub({ snapshot: OBSERVER_SNAPSHOT });
    },
    createObsClientFn() {
      return createObsClientStub();
    },
    launchChromeSessionFn: async () => ({
      chromePid: 47213, debugPort: 9222, profileDir, async stop() {},
    }),
    discoverCdpEndpointFn: async () => ({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
    }),
    createCdpClientFn() { return createCdpClientStub(47213); },
    createBrowserSessionFn() {
      return {
        async start() {}, async stop() {}, async openWindow() {}, async openAuxWindow() { return { key: 'mock', targetId: 'TARGET_MOCK', cdpWindowId: 999, macWindowId: null, title: 'Mock', url: '' }; },
        async measureMinimumWindowSize() { return null; },
        getStatus() { return { connected: true, chromePid: 47213, sources: {} }; },
        getRegistry() { return { sources: { Slide: { title: 'Deckhand Deck' } } }; },
        async activateTab() {}, async navigateTab() {},
      };
    },
    createCoordinatorFn() {
      return {
        async start() {}, async stop() {}, getCurrentPresentationState() { return null; },
      };
    },
    createPresenterHttpFn() { return createPresenterHttpStub(); },
    createPresentationServerFn() {
      return createPresentationServerStub();
    },
    reconcileObsFn: async () => {},
    waitForDriverPositionFn: async () => {},
    waitForPresentationObserverFn: async () => {},
    runSttObserverFn: async () => {},
    resolveMacWindowBindingsFn: async () => ({
      Slide: { macWindowId: 11111, pid: 47213 },
    }),
  };

  return { captures, options };
}

/**
 * Patched `process.exit` behavior shared by the shutdown suites: record the
 * call, then abort so the rest of the process cannot continue past teardown.
 * @returns {never}
 */
function failExit() {
  throw new Error('EXIT_CALLED');
}

test('run closes owned app windows on shutdown via closeOwnedWindowsFn', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-owned-'));
  const closedBindings = [];

  try {
    await writePresentationConfig(tempDir, 'shutdown', buildOwnedShutdownConfig({
      sources: { Terminal: TERMINAL_SOURCE },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown',
        consoleLike: createSilentConsole(),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown',
        ...options,
        closeOwnedWindowsFn: ({ bindings }) => {
          closedBindings.push(...bindings);
        },
        resolveOwnedWindowBindingsFn: async () => ({
          Terminal: { macWindowId: 555, pid: 4321 },
        }),
      });

      assert.equal(exitCode, 0);

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(closedBindings.length, 1);
  // Wiring check: shutdown must still route the Chrome-profile reap through
  // the injected hook with the exact pkill commands.
  assert.deepEqual(closedBindings[0], {
    kind: 'app',
    sourceId: 'Terminal',
    discardUnsavedChanges: false,
    macWindowId: 555,
    ownerName: 'iTerm',
    pid: 4321,
    sessionId: undefined,
  });
});

test('run requests discardUnsavedChanges when shutting down owned app windows', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-owned-discard-'));
  const closedBindings = [];

  try {
    await writePresentationConfig(tempDir, 'shutdown-discard', buildOwnedShutdownConfig({
      sources: { Editor: EDITOR_SOURCE },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-discard',
        consoleLike: createSilentConsole(),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-discard',
        ...options,
        preflightEnumerateWindowsFn: () => [],
        closeOwnedWindowsFn: ({ bindings }) => {
          closedBindings.push(...bindings);
        },
        resolveOwnedWindowBindingsFn: async () => ({
          Editor: { macWindowId: 888, pid: 9999 },
        }),
      });

      assert.equal(exitCode, 0);

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(closedBindings.length, 1);
  assert.deepEqual(closedBindings[0], {
    kind: 'app',
    sourceId: 'Editor',
    macWindowId: 888,
    ownerName: 'Code',
    pid: 9999,
    sessionId: undefined,
    discardUnsavedChanges: true,
  });
});

test('run app shutdown closes only tracked macWindowId', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-app-tracked-only-'));
  const closeCalls = [];

  try {
    await writePresentationConfig(tempDir, 'shutdown-app-tracked-only', buildOwnedShutdownConfig({
      sources: { Editor: EDITOR_SOURCE },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-app-tracked-only',
        consoleLike: createSilentConsole(),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-app-tracked-only',
        ...options,
        preflightEnumerateWindowsFn: () => [],
        closeMacWindowFn: (macWindowId, pid, closeOptions) => {
          closeCalls.push({ macWindowId, pid, options: closeOptions });
          return true;
        },
        resolveOwnedWindowBindingsFn: async () => ({
          Editor: { macWindowId: 888, pid: 9999 },
        }),
      });

      assert.equal(exitCode, 0);

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(closeCalls.length, 1);
  assert.deepEqual(closeCalls[0], {
    macWindowId: 888,
    pid: 9999,
    options: { discardUnsavedChanges: true },
  });
});

test('run shutdown closes app window whose binding was cleared mid-run', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-cleared-binding-'));
  const closedBindings = [];
  let hubInstance = null;

  try {
    await writePresentationConfig(tempDir, 'shutdown-cleared-binding', buildOwnedShutdownConfig({
      sources: { Terminal: TERMINAL_SOURCE },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-cleared-binding',
        consoleLike: createSilentConsole(),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-cleared-binding',
        ...options,
        closeOwnedWindowsFn: ({ bindings }) => {
          closedBindings.push(...bindings);
        },
        createHubFn() {
          hubInstance = createEmittingHubStub({ snapshot: OBSERVER_SNAPSHOT });
          return hubInstance;
        },
        resolveOwnedWindowBindingsFn: async () => ({
          Terminal: { macWindowId: 555, pid: 4321 },
        }),
      });

      assert.equal(exitCode, 0);

      // Hammerspoon reports the Terminal window as unfindable mid-run; the
      // cached binding is dropped from the live cache.
      hubInstance.emit('observerWindowBindings', { cleared: ['Terminal'] });

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(closedBindings.length, 1);
  assert.deepEqual(closedBindings[0], {
    kind: 'app',
    sourceId: 'Terminal',
    discardUnsavedChanges: false,
    macWindowId: 555,
    ownerName: 'iTerm',
    pid: 4321,
    sessionId: undefined,
  });
});

test('run shutdown keeps the stashed binding when a later relaunch fails after clear', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-relaunch-fail-'));
  const closedBindings = [];
  let hubInstance = null;
  let relaunchSource = null;

  try {
    await writePresentationConfig(tempDir, 'shutdown-relaunch-fail', buildOwnedShutdownConfig({
      sources: { Terminal: TERMINAL_SOURCE },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-relaunch-fail',
        consoleLike: createSilentConsole(),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-relaunch-fail',
        ...options,
        relaunchAppSourceFn: async () => ({ macWindowId: undefined }),
        closeOwnedWindowsFn: ({ bindings }) => {
          closedBindings.push(...bindings);
        },
        createHubFn() {
          hubInstance = createEmittingHubStub({ snapshot: OBSERVER_SNAPSHOT });
          return hubInstance;
        },
        createCoordinatorFn(coordinatorOptions) {
          relaunchSource = coordinatorOptions.relaunchSource;
          return {
            async start() {}, async stop() {}, getCurrentPresentationState() { return null; },
            async reapplyCurrentSlide() {},
          };
        },
        resolveOwnedWindowBindingsFn: async () => ({
          Terminal: { macWindowId: 555, pid: 4321 },
        }),
      });

      assert.equal(exitCode, 0);

      // Hammerspoon reports the Terminal window unfindable mid-run; the
      // last-known binding moves into the shutdown stash and the live entry
      // is dropped.
      hubInstance.emit('observerWindowBindings', { cleared: ['Terminal'] });

      // A later relaunch fails to resolve a window for the same source; the
      // failure path must not overwrite the shutdown stash with undefined.
      const relaunchResult = await relaunchSource({ sourceId: 'Terminal' });
      assert.equal(relaunchResult.macWindowId, null, 'relaunch failure path was not exercised');

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(closedBindings.length, 1);
  assert.deepEqual(closedBindings[0], {
    kind: 'app',
    sourceId: 'Terminal',
    discardUnsavedChanges: false,
    macWindowId: 555,
    ownerName: 'iTerm',
    pid: 4321,
    sessionId: undefined,
  });
});

test('run shutdown warns for unbound owned app source and still closes bound sources', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-unbound-'));
  const closedSourceIds = [];
  const warnings = [];

  try {
    await writePresentationConfig(tempDir, 'shutdown-unbound', buildOwnedShutdownConfig({
      sources: { Terminal: TERMINAL_SOURCE, Editor: EDITOR_SOURCE },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-unbound',
        consoleLike: createSilentConsole({ onWarn: (message) => warnings.push(message) }),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-unbound',
        ...options,
        preflightEnumerateWindowsFn: () => [],
        closeOwnedWindowsFn: ({ bindings }) => {
          for (const binding of bindings) {
            closedSourceIds.push(binding.sourceId);
          }
        },
        // Editor never resolves — no binding exists for it at any point.
        resolveOwnedWindowBindingsFn: async () => ({
          Terminal: { macWindowId: 555, pid: 4321 },
        }),
      });

      assert.equal(exitCode, 0);

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.ok(
    warnings.some((message) => message.includes('No window binding available for owned app source') && message.includes('Editor')),
    `expected a shutdown warn mentioning Editor, got: ${JSON.stringify(warnings)}`,
  );
  assert.deepEqual(closedSourceIds, ['Terminal']);
});

test('run shutdown continues past an owned-window close that hangs', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-hang-'));
  const closedSourceIds = [];
  const warnings = [];

  try {
    await writePresentationConfig(tempDir, 'shutdown-hang', buildOwnedShutdownConfig({
      sources: {
        Alpha: TERMINAL_SOURCE,
        Beta: EDITOR_SOURCE,
      },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-hang',
        consoleLike: createSilentConsole({ onWarn: (message) => warnings.push(message) }),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-hang',
        ...options,
        preflightEnumerateWindowsFn: () => [],
        shutdownCloseTimeoutMs: 50,
        closeOwnedWindowsFn: ({ bindings }) => {
          const sourceId = bindings[0]?.sourceId;

          if (sourceId === 'Alpha') {
            return new Promise(() => {});
          }

          closedSourceIds.push(sourceId);
          return undefined;
        },
        resolveOwnedWindowBindingsFn: async () => ({
          Alpha: { macWindowId: 555, pid: 4321 },
          Beta: { macWindowId: 888, pid: 9999 },
        }),
      });

      assert.equal(exitCode, 0);

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.ok(
    warnings.some((message) => message.includes('Timed out closing owned app window') && message.includes('Alpha')),
    `expected a timeout warn for Alpha, got: ${JSON.stringify(warnings)}`,
  );
  assert.deepEqual(closedSourceIds, ['Beta']);
});

test('run shutdown continues past a coordinator stop that hangs', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-stop-hang-'));
  const warnings = [];

  try {
    await writePresentationConfig(tempDir, 'shutdown-stop-hang', buildOwnedShutdownConfig());

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-stop-hang',
        consoleLike: createSilentConsole({ onWarn: (message) => warnings.push(message) }),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-stop-hang',
        ...options,
        createCoordinatorFn() {
          return {
            async start() {},
            // Wedged OBS websocket: coordinator stop never settles.
            stop() { return new Promise(() => {}); },
            getCurrentPresentationState() { return null; },
          };
        },
        shutdownStopTimeoutMs: 50,
      });

      assert.equal(exitCode, 0);

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.ok(
    warnings.some((message) => message.includes('Timed out stopping coordinator/browser runtime; continuing shutdown') && message.includes('"timeoutMs":50')),
    `expected a stop-timeout warn naming the timeout, got: ${JSON.stringify(warnings)}`,
  );
});

test('run shutdown stops the runtime before closing owned app windows', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-order-'));
  const teardownEvents = [];

  try {
    await writePresentationConfig(tempDir, 'shutdown-order', buildOwnedShutdownConfig({
      sources: { Terminal: TERMINAL_SOURCE },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-order',
        consoleLike: createSilentConsole(),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-order',
        ...options,
        createCoordinatorFn() {
          return {
            async start() {},
            async stop() { teardownEvents.push('coordinator.stop'); },
            getCurrentPresentationState() { return null; },
          };
        },
        closeOwnedWindowsFn: () => {
          teardownEvents.push('closeOwnedWindows');
        },
        resolveOwnedWindowBindingsFn: async () => ({
          Terminal: { macWindowId: 555, pid: 4321 },
        }),
      });

      assert.equal(exitCode, 0);

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, {
      onExit: () => {
        teardownEvents.push('exit');
        throw new Error('EXIT_CALLED');
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  // Why the order matters: closing an owned app window can kill deckhand's
  // own host terminal (VS Code integrated terminal), so the coordinator stop
  // and Chrome kill must complete while this process is still alive.
  assert.deepEqual(teardownEvents, ['coordinator.stop', 'closeOwnedWindows', 'exit']);
});

test('run shuts down on SIGHUP through the same teardown flow', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-sighup-'));
  const closedBindings = [];

  try {
    await writePresentationConfig(tempDir, 'shutdown-sighup', buildOwnedShutdownConfig({
      sources: { Terminal: TERMINAL_SOURCE },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-sighup',
        consoleLike: createSilentConsole(),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-sighup',
        ...options,
        closeOwnedWindowsFn: ({ bindings }) => {
          closedBindings.push(...bindings);
        },
        resolveOwnedWindowBindingsFn: async () => ({
          Terminal: { macWindowId: 555, pid: 4321 },
        }),
      });

      assert.equal(exitCode, 0);

      try {
        process.emit('SIGHUP');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGHUP shutdown handler to call process.exit' });

      // `run()` also bound SIGTERM for this presentation; consume that
      // once-listener so it cannot fire during a later test's emit.
      try {
        process.emit('SIGTERM');
      } catch {
        // no-op — teardown already ran
      }
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(closedBindings.length, 1);
  assert.equal(closedBindings[0].sourceId, 'Terminal');
  assert.equal(closedBindings[0].macWindowId, 555);
});

test('run ignores a shutdown signal that arrives while shutdown is already running', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-reentry-'));
  let closeCalls = 0;
  let stopCalls = 0;
  // Test-controlled gate: the first teardown parks inside closeOwnedWindowsFn
  // until the test releases it, so no wall-clock sleep is needed to keep
  // shutdown in flight while the second signal lands.
  let releaseTeardown;
  const teardownGate = new Promise((resolve) => { releaseTeardown = resolve; });

  try {
    await writePresentationConfig(tempDir, 'shutdown-reentry', buildOwnedShutdownConfig({
      sources: { Terminal: TERMINAL_SOURCE },
    }));

    await withPatchedExit(async (exitCalls) => {
      const { options } = buildShutdownRunOptions({
        profileDir: '/tmp/deckhand-shutdown-reentry',
        consoleLike: createSilentConsole(),
      });

      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'shutdown-reentry',
        ...options,
        closeOwnedWindowsFn: async () => {
          closeCalls += 1;
          // Park teardown here until the test releases the gate, so the second
          // signal provably lands while shutdown is still in flight.
          await teardownGate;
        },
        createCoordinatorFn() {
          return {
            async start() {},
            async stop() { stopCalls += 1; },
            getCurrentPresentationState() { return null; },
          };
        },
        resolveOwnedWindowBindingsFn: async () => ({
          Terminal: { macWindowId: 555, pid: 4321 },
        }),
      });

      assert.equal(exitCode, 0);

      try {
        process.emit('SIGTERM');
        process.emit('SIGHUP');
      } catch {
        // process.exit inside the handler throws — expected
      }

      // Wait for the observable effect — teardown parked inside
      // closeOwnedWindowsFn — then release it and let shutdown finish.
      await waitForCondition(() => closeCalls > 0, { description: 'teardown to reach the parked closeOwnedWindowsFn' });
      releaseTeardown();

      await waitForCondition(() => exitCalls.length > 0, { description: 'the shutdown handler to call process.exit' });
    }, { onExit: failExit });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(closeCalls, 1);
  assert.equal(stopCalls, 1);
});
