import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { run } from '../../../src/index.js';
import {
  createCdpClientStub,
  createEmittingHubStub,
  createObsClientStub,
  createPresentationServerStub,
  createPresenterHttpStub,
  createSilentConsole,
  writeExamplePresentationConfig,
} from './helpers.js';

const CONSOLE_AUX_WINDOW = {
  key: 'presenter-console',
  targetId: 'TARGET_CONSOLE',
  cdpWindowId: 888,
  macWindowId: 33333,
  title: 'Deckhand Console',
  url: 'http://127.0.0.1:3001/presenter/',
};

const TELEPROMPTER_AUX_WINDOW = {
  key: 'presenter-teleprompter',
  targetId: 'TARGET_1',
  cdpWindowId: 777,
  macWindowId: 22222,
  title: 'Deckhand Presenter',
  url: 'http://127.0.0.1:3001/presenter/teleprompter.html',
};

/**
 * Browser-session stub for presenter-window suites: opens keyed aux windows
 * (console/teleprompter) and reports a registry without macWindowIds so the
 * windows must come from the presenter-side resolvers.
 * @param {{ consoleWindow?: object | Error }} [options]
 *   `consoleWindow` overrides the console aux window result (or throws).
 * @returns {(chromePid: number) => object} factory for `createBrowserSessionFn`
 */
function createPresenterWindowBrowserSessionFn({ consoleWindow = CONSOLE_AUX_WINDOW } = {}) {
  return (chromePid) => ({
    async start() {},
    async stop() {},
    async measureMinimumWindowSize() { return null; },
    async openWindow() { return { windowId: 999 }; },
    async openAuxWindow({ key }) {
      if (key === 'presenter-console') {
        if (consoleWindow instanceof Error) {
          throw consoleWindow;
        }
        return { ...consoleWindow, key };
      }
      return TELEPROMPTER_AUX_WINDOW;
    },
    getStatus() { return { connected: true, chromePid, sources: {} }; },
    getRegistry() {
      return {
        sources: {
          Slide: { title: 'Deckhand Deck' },
          BrowserA: { title: 'Deckhand Demo Primary' },
          BrowserB: { title: 'Deckhand Demo Secondary' },
        },
        auxWindows: {},
      };
    },
    async activateTab() {},
    async navigateTab() {},
  });
}

test('run resolves and caches the presenter teleprompter window binding without sending it to OBS', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presenter-binding-'));
  let capturedGetManagedWindowBindings = null;
  const reconcileCalls = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-presenter-binding',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() {
        return createCdpClientStub(47213);
      },
      createBrowserSessionFn() {
        return {
          async start() {},
          async stop() {},
          async measureMinimumWindowSize() { return null; },
          async openAuxWindow() { return TELEPROMPTER_AUX_WINDOW; },
          getStatus() { return { connected: true, chromePid: 47213, sources: {} }; },
          getRegistry() {
            return {
              sources: {
                Slide: { title: 'Deckhand Deck' },
                BrowserA: { title: 'Deckhand Demo Primary' },
                BrowserB: { title: 'Deckhand Demo Secondary' },
              },
              auxWindows: {},
            };
          },
          async activateTab() {},
          async navigateTab() {},
        };
      },
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return {
          async start() {},
          async stop() {},
          getCurrentPresentationState() { return null; },
        };
      },
      createPresenterHttpFn() { return createPresenterHttpStub(); },
      createPresentationServerFn() {
        return createPresentationServerStub();
      },
      reconcileObsFn: async ({ windowBindings }) => {
        reconcileCalls.push({ ...windowBindings });
      },
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolvePresenterTeleprompterBindingFn: async () => ({ macWindowId: 22222, pid: 47213 }),
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
        BrowserA: { macWindowId: 12345, pid: 47213 },
        BrowserB: { macWindowId: 67890, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    const bindings = capturedGetManagedWindowBindings();
    assert.deepEqual(bindings.Presenter, {
      app: 'Google Chrome',
      titleIncludes: 'Deckhand Presenter',
      pid: 47213,
      macWindowId: 22222,
    });
    assert.equal(
      reconcileCalls.some((call) => Object.prototype.hasOwnProperty.call(call, 'Presenter')),
      false,
      'the presenter teleprompter binding must never be sent to OBS reconciliation',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run registers the presenter console window binding for Hammerspoon positioning', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-console-binding-'));
  let capturedGetManagedWindowBindings = null;
  // Registration-time pid; mutated after run() so the bindings callback
  // observes a different chromePid and the cached pid's precedence is pinned.
  let currentChromePid = 47213;

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-console-binding',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() {
        return createCdpClientStub(47213);
      },
      createBrowserSessionFn() {
        return {
          ...createPresenterWindowBrowserSessionFn()(47213),
          // The pid is read through a mutable binding so the test can simulate
          // Chrome relaunching after the console window was registered.
          getStatus() { return { connected: true, chromePid: currentChromePid, sources: {} }; },
        };
      },
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return { async start() {}, async stop() {}, getCurrentPresentationState() { return null; } };
      },
      createPresenterHttpFn() { return createPresenterHttpStub(); },
      createPresentationServerFn() {
        return createPresentationServerStub();
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolvePresenterTeleprompterBindingFn: async () => null,
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
        BrowserA: { macWindowId: 12345, pid: 47213 },
        BrowserB: { macWindowId: 67890, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);

    // Simulate Chrome relaunching after registration: the bindings callback now
    // observes a different chromePid than the one cached at console-open time.
    currentChromePid = 99999;

    const bindings = capturedGetManagedWindowBindings();
    // The cached registration pid (47213) must win over the current chromePid.
    assert.deepEqual(bindings.Console, {
      app: 'Google Chrome',
      titleIncludes: 'Deckhand Console',
      pid: 47213,
      macWindowId: 33333,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run refreshes the presentation state after the presenter console window opens', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-console-refresh-'));
  const refreshReasons = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-console-refresh',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() {
        return createCdpClientStub(47213);
      },
      createBrowserSessionFn() {
        return createPresenterWindowBrowserSessionFn()(47213);
      },
      createCoordinatorFn() {
        return {
          async start() {},
          async stop() {},
          getCurrentPresentationState() { return null; },
          async refreshCurrentPresentationState(reason) {
            refreshReasons.push(reason);
          },
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
      resolvePresenterTeleprompterBindingFn: async () => null,
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
        BrowserA: { macWindowId: 12345, pid: 47213 },
        BrowserB: { macWindowId: 67890, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(refreshReasons, ['consoleOpened']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run warns accurately when the presentation state refresh fails after console open', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-console-refresh-fail-'));
  const warnings = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onWarn: (message) => warnings.push(message) }),
      createHubFn() {
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-console-refresh-fail',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() {
        return createCdpClientStub(47213);
      },
      createBrowserSessionFn() {
        return createPresenterWindowBrowserSessionFn()(47213);
      },
      createCoordinatorFn() {
        return {
          async start() {},
          async stop() {},
          getCurrentPresentationState() { return null; },
          async refreshCurrentPresentationState() {
            throw new Error('refresh boom');
          },
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
      resolvePresenterTeleprompterBindingFn: async () => null,
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
        BrowserA: { macWindowId: 12345, pid: 47213 },
        BrowserB: { macWindowId: 67890, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    assert.ok(
      warnings.some((message) => message.includes('Failed to refresh presentation state after console open') && message.includes('refresh boom')),
      `expected a refresh-failure warn, got: ${JSON.stringify(warnings)}`,
    );
    assert.equal(
      warnings.some((message) => message.includes('Failed to open presenter console window')),
      false,
      `the open itself succeeded, so the open-window warn must not appear, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run warns and skips the console binding when the console window fails to open', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-console-open-fail-'));
  const warnings = [];
  let capturedGetManagedWindowBindings = null;

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onWarn: (message) => warnings.push(message) }),
      createHubFn() {
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-console-open-fail',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() {
        return createCdpClientStub(47213);
      },
      createBrowserSessionFn() {
        return createPresenterWindowBrowserSessionFn({ consoleWindow: new Error('open boom') })(47213);
      },
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return {
          async start() {},
          async stop() {},
          getCurrentPresentationState() { return null; },
          async refreshCurrentPresentationState() {
            throw new Error('refresh boom');
          },
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
      resolvePresenterTeleprompterBindingFn: async () => null,
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
        BrowserA: { macWindowId: 12345, pid: 47213 },
        BrowserB: { macWindowId: 67890, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    assert.ok(
      warnings.some((message) => message.includes('Failed to open presenter console window') && message.includes('open boom')),
      `expected the open-failure warn with the error text, got: ${JSON.stringify(warnings)}`,
    );
    assert.equal(
      warnings.some((message) => message.includes('Failed to refresh presentation state after console open')),
      false,
      `the open failed, so the refresh must never run, got: ${JSON.stringify(warnings)}`,
    );
    const bindings = capturedGetManagedWindowBindings();
    assert.equal(Object.prototype.hasOwnProperty.call(bindings, 'Console'), false);
    assert.equal(bindings.Console, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run drops the presenter console binding when the console window has no macWindowId', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-console-no-macwindow-'));
  let capturedGetManagedWindowBindings = null;

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-console-no-macwindow',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() {
        return createCdpClientStub(47213);
      },
      createBrowserSessionFn() {
        return createPresenterWindowBrowserSessionFn({ consoleWindow: { ...CONSOLE_AUX_WINDOW, macWindowId: null } })(47213);
      },
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return { async start() {}, async stop() {}, getCurrentPresentationState() { return null; } };
      },
      createPresenterHttpFn() { return createPresenterHttpStub(); },
      createPresentationServerFn() {
        return createPresentationServerStub();
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolvePresenterTeleprompterBindingFn: async () => null,
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
        BrowserA: { macWindowId: 12345, pid: 47213 },
        BrowserB: { macWindowId: 67890, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    const bindings = capturedGetManagedWindowBindings();
    assert.equal(Object.prototype.hasOwnProperty.call(bindings, 'Console'), false);
    assert.equal(bindings.Console, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run never sends the presenter console binding to OBS reconciliation', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-console-obs-isolation-'));
  let capturedGetManagedWindowBindings = null;
  const reconcileCalls = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-console-obs-isolation',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() {
        return createCdpClientStub(47213);
      },
      createBrowserSessionFn() {
        return createPresenterWindowBrowserSessionFn()(47213);
      },
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return { async start() {}, async stop() {}, getCurrentPresentationState() { return null; } };
      },
      createPresenterHttpFn() { return createPresenterHttpStub(); },
      createPresentationServerFn() {
        return createPresentationServerStub();
      },
      reconcileObsFn: async ({ windowBindings }) => {
        reconcileCalls.push({ ...windowBindings });
      },
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolvePresenterTeleprompterBindingFn: async () => null,
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
        BrowserA: { macWindowId: 12345, pid: 47213 },
        BrowserB: { macWindowId: 67890, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    const bindings = capturedGetManagedWindowBindings();
    assert.deepEqual(bindings.Console, {
      app: 'Google Chrome',
      titleIncludes: 'Deckhand Console',
      pid: 47213,
      macWindowId: 33333,
    });

    assert.ok(reconcileCalls.length > 0, 'expected at least one OBS reconcile call');
    assert.ok(
      reconcileCalls.every((call) => !Object.prototype.hasOwnProperty.call(call, 'Console')),
      `the console binding must never reach OBS reconciliation, got: ${JSON.stringify(reconcileCalls)}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
