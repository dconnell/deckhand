import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { run } from '../../../src/index.js';
import {
  createBrowserSessionStub,
  createCdpClientStub,
  createEmittingHubStub,
  createHubStub,
  createObsClientStub,
  createPresentationServerStub,
  createPresenterHttpStub,
  createSilentConsole,
  writeExamplePresentationConfig,
} from './helpers.js';

test('run discovers the actual DevTools port from the launched Chrome session', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-actual-devtools-port-'));
  const discovered = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {} },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9321,
        profileDir: '/tmp/deckhand-run',
        async stop() {},
      }),
      discoverCdpEndpointFn: async ({ debugPort, profileDir }) => {
        discovered.push({ debugPort, profileDir });
        return {
          webSocketDebuggerUrl: 'ws://127.0.0.1:9313/devtools/browser/abc',
          chromePid: null,
        };
      },
      createCdpClientFn({ discover }) {
        return {
          async connect() {
            await discover();
          },
          async disconnect() {},
          isConnected() {
            return true;
          },
          getChromePid() {
            return 47213;
          },
          on() {},
          async createWindow() { throw new Error('not used'); },
          async createTab() { throw new Error('not used'); },
          async activateTab() {},
          async navigateTab() {},
          async closeTarget() {},
        };
      },
      createBrowserSessionFn({ createCdpClient }) {
        const cdpClient = createCdpClient();
        return {
          async start() { await cdpClient.connect(); },
          async stop() { await cdpClient.disconnect(); },
          async openWindow() {},
          async measureMinimumWindowSize() { return null; },
          getStatus() { return { connected: true, chromePid: 47213, sources: {} }; },
          async activateTab() {},
          async navigateTab() {},
        };
      },
      createCoordinatorFn({ executor, obs, hub }) {
        return {
          async start() {
            await executor.start();
            await obs.connect();
            await hub.start();
          },
          async stop() {
            await executor.stop();
            await hub.stop();
            await obs.disconnect();
          },
          getCurrentPresentationState() {
            return {
              type: 'presentationState',
              seq: 1,
              slideId: 'intro',
              layoutId: 'full-slide',
              audienceScene: 'Full Slide',
              focus: null,
              slots: [],
            };
          },
          getRuntimeWindowBindings() {
            return {};
          },
        };
      },
      createPresenterHttpFn() {
        return createPresenterHttpStub();
      },
      createPresentationServerFn() {
        return createPresentationServerStub();
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => {},
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    // The discover fn must receive the debugPort/profileDir of the session
    // run actually launched — not a config-defaulted guess.
    assert.deepEqual(discovered, [
      { debugPort: 9321, profileDir: '/tmp/deckhand-run' },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run clears the stale Chrome launch handle on transportLost so recovery relaunches Chrome', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-transport-lost-'));
  const killedChromeGroups = [];
  const reapedChromeProfiles = [];
  let launchCount = 0;
  let capturedDiscover = null;
  let transportLostHandler = null;

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      killProcessGroupFn: (pgid) => { killedChromeGroups.push(pgid); },
      reapChromeProfilesFn: (command) => { reapedChromeProfiles.push(command); },
      consoleLike: createSilentConsole(),
      createHubFn() {
        return createHubStub();
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => {
        launchCount += 1;
        return {
          chromePid: 47213,
          debugPort: 9321,
          profileDir: '/tmp/deckhand-transport-lost',
          async stop() {},
        };
      },
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9313/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn({ discover }) {
        capturedDiscover = discover;
        return {
          async connect() {
            await discover();
          },
          async disconnect() {},
          isConnected() {
            return true;
          },
          getChromePid() {
            return 47213;
          },
          on() {},
          async createWindow() { throw new Error('not used'); },
          async createTab() { throw new Error('not used'); },
          async activateTab() {},
          async navigateTab() {},
          async closeTarget() {},
        };
      },
      createBrowserSessionFn({ createCdpClient }) {
        const cdpClient = createCdpClient();
        return {
          async start() { await cdpClient.connect(); },
          async stop() { await cdpClient.disconnect(); },
          on(event, handler) {
            if (event === 'transportLost') {
              transportLostHandler = handler;
            }
          },
          async openWindow() {},
          async measureMinimumWindowSize() { return null; },
          getStatus() { return { connected: true, chromePid: 47213, sources: {} }; },
          async activateTab() {},
          async navigateTab() {},
        };
      },
      createCoordinatorFn({ executor, obs, hub }) {
        return {
          async start() {
            await executor.start();
            await obs.connect();
            await hub.start();
          },
          async stop() {
            await executor.stop();
            await hub.stop();
            await obs.disconnect();
          },
          getCurrentPresentationState() {
            return {
              type: 'presentationState',
              seq: 1,
              slideId: 'intro',
              layoutId: 'full-slide',
              audienceScene: 'Full Slide',
              focus: null,
              slots: [],
            };
          },
          getRuntimeWindowBindings() {
            return {};
          },
        };
      },
      createPresenterHttpFn() {
        return createPresenterHttpStub();
      },
      createPresentationServerFn() {
        return createPresentationServerStub();
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => {},
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    assert.equal(launchCount, 1, 'Chrome is launched once during initial startup');
    assert.equal(typeof transportLostHandler, 'function', 'run subscribes to browser transportLost');

    transportLostHandler();
    await capturedDiscover();

    assert.equal(launchCount, 2, 'clearing the stale handle lets recovery relaunch Chrome');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run uses the browser session cleanup before stopping the launched Chrome process on startup failure', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-chrome-cleanup-'));
  const errors = [];
  const lifecycle = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onError: (message) => errors.push(message) }),
      createHubFn() {
        return createEmittingHubStub({
          sendCommand: async () => [],
        });
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          getClient() { return this; },
          isConnected() {
            return false;
          },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        async stop() {
          lifecycle.push('chrome.stop');
        },
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn({ discover }) {
        return {
          async connect() {
            await discover();
          },
          async disconnect() {
            lifecycle.push('cdp.disconnect');
          },
          isConnected() {
            return true;
          },
          getChromePid() {
            return 47213;
          },
          on() {},
          async createWindow() {
            throw new Error('not used');
          },
          async createTab() {
            throw new Error('not used');
          },
          async activateTab() {},
          async navigateTab() {},
        };
      },
      createBrowserSessionFn({ createCdpClient }) {
        const cdpClient = createCdpClient();

        return {
          async start() {
            await cdpClient.connect();
          },
          async stop() {
            lifecycle.push('browserSession.stop');
            await cdpClient.disconnect();
          },
          getStatus() {
            return { connected: true, chromePid: 47213, sources: {} };
          },
          async activateTab() {},
          async navigateTab() {},
        };
      },
      createCoordinatorFn({ executor }) {
        return {
          async start() {
            lifecycle.push('coordinator.start');
            await executor.start();
            throw new Error('startup exploded');
          },
          async stop() {
            lifecycle.push('coordinator.stop');
            await executor.stop();
          },
          getCurrentPresentationState() {
            return null;
          },
        };
      },
      createPresentationServerFn() {
        return {
          async start() {
            lifecycle.push('presentationServer.start');
          },
          async stop() {
            lifecycle.push('presentationServer.stop');
          },
          getAddress() {
            return { host: '127.0.0.1', port: 3000 };
          },
        };
      },
      reconcileObsFn: async () => {},
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0], /Coordinator failed to start: startup exploded/);
    // Close-before-kill: the browser session's graceful cleanup (which
    // includes the CDP disconnect) must complete BEFORE the launched Chrome
    // process is stopped, or the disconnect races the process dying.
    const browserStopAt = lifecycle.indexOf('browserSession.stop');
    const cdpDisconnectAt = lifecycle.indexOf('cdp.disconnect');
    const chromeStopAt = lifecycle.indexOf('chrome.stop');
    assert.notEqual(browserStopAt, -1);
    assert.notEqual(cdpDisconnectAt, -1);
    assert.notEqual(chromeStopAt, -1);
    assert.ok(browserStopAt < chromeStopAt);
    assert.ok(cdpDisconnectAt < chromeStopAt);
    // The remaining teardown stops are required, but their order is not the
    // concern under test.
    assert.ok(lifecycle.includes('coordinator.stop'));
    assert.ok(lifecycle.includes('presentationServer.stop'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run stops a stale Deckhand Chrome process if discovery fails on the requested port', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-stale-chrome-'));
  const errors = [];
  const lifecycle = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onError: (message) => errors.push(message) }),
      createHubFn() {
        return createHubStub();
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      createCoordinatorFn({ executor, obs, hub }) {
        return {
          async start() {
            await obs.connect();
            await hub.start();
            await executor?.start?.();
          },
          async stop() {
            await executor?.stop?.();
            await hub.stop();
            await obs.disconnect();
          },
          getCurrentPresentationState() {
            return null;
          },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9292,
        async stop() {
          lifecycle.push('chrome.stop');
        },
      }),
      discoverCdpEndpointFn: async () => {
        throw new Error('fetch failed');
      },
      reconcileObsFn: async () => {},
      resolveMacWindowBindingsFn: async () => {},
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0], /fetch failed/);
    assert.deepEqual(lifecycle, ['chrome.stop']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
