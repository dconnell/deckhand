import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { run } from '../../../src/index.js';
import {
  createCdpClientStub,
  createHubStub,
  createObsClientStub,
  createPresentationServerStub,
  createPresenterHttpStub,
  createSilentConsole,
  writeExamplePresentationConfig,
} from './helpers.js';

/**
 * Run options for the relaunchSource suites: a connected browser runtime whose
 * browser session records `relaunchBrowserSource` calls and whose coordinator
 * exposes the injected `relaunchSource` hook via `captures`.
 * @param {{ browserRelaunches: string[], reapplies: string[], relaunchedAppSources: string[] }} captures
 * @returns {object} run options
 */
function buildRelaunchRunOptions({ captures }) {
  return {
    installSignalHandlers: false,
    consoleLike: createSilentConsole(),
    createHubFn() {
      return createHubStub();
    },
    createObsClientFn() {
      return createObsClientStub();
    },
    launchChromeSessionFn: async () => ({
      chromePid: 47213,
      debugPort: 9321,
      profileDir: '/tmp/deckhand-relaunch',
      async stop() {},
    }),
    discoverCdpEndpointFn: async () => ({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9313/devtools/browser/abc',
      chromePid: null,
    }),
    createCdpClientFn({ discover }) {
      return {
        async connect() { await discover(); },
        async disconnect() {},
        isConnected() { return true; },
        getChromePid() { return 47213; },
        on() {},
        async createWindow() { throw new Error('not used'); },
        async createTab() { throw new Error('not used'); },
        async activateTab() {},
        async navigateTab() {},
        async closeTarget() {},
      };
    },
    createBrowserSessionFn({ createCdpClient }) {
      createCdpClient();
      return {
        async start() {},
        async stop() {},
        on() {},
        async openWindow() {},
        async measureMinimumWindowSize() { return null; },
        async openAuxWindow() { return { macWindowId: null }; },
        getStatus() { return { connected: true, chromePid: 47213, sources: {} }; },
        getRegistry() { return { sources: {}, auxWindows: {} }; },
        async activateTab() {},
        async navigateTab() {},
        async relaunchBrowserSource(sourceId) {
          captures.browserRelaunches.push(sourceId);
          return { macWindowId: 555 };
        },
      };
    },
    createCoordinatorFn(options) {
      captures.relaunchSource = options.relaunchSource;
      return {
        async start() {},
        async stop() {},
        getCurrentPresentationState() { return null; },
        getRuntimeWindowBindings() { return {}; },
        async reapplyCurrentSlide(reason) { captures.reapplies.push(reason); },
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
  };
}

test('relaunchSource rebuilds a browser source and re-applies OBS bindings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-relaunch-browser-'));
  const captures = { browserRelaunches: [], reapplies: [], relaunchedAppSources: [] };

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      ...buildRelaunchRunOptions({ captures }),
    });

    assert.equal(exitCode, 0);

    const result = await captures.relaunchSource({ sourceId: 'Slide' });

    assert.deepEqual(captures.browserRelaunches, ['Slide']);
    assert.deepEqual(captures.reapplies, ['sourceRelaunched']);
    assert.equal(result.sourceId, 'Slide');
    assert.equal(result.macWindowId, 555);
    assert.equal(result.binding.macWindowId, 555);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('relaunchSource re-launches an app source via the injected app relauncher', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-relaunch-app-'));
  const captures = { browserRelaunches: [], reapplies: [], relaunchedAppSources: [] };

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      relaunchAppSourceFn: async ({ sourceId }) => {
        captures.relaunchedAppSources.push(sourceId);
        return { macWindowId: 777, pid: 1234, sessionId: 'session-uuid-new' };
      },
      ...buildRelaunchRunOptions({ captures }),
    });

    assert.equal(exitCode, 0);

    const result = await captures.relaunchSource({ sourceId: 'Terminal' });

    assert.deepEqual(captures.relaunchedAppSources, ['Terminal']);
    assert.deepEqual(captures.browserRelaunches, [], 'a browser relaunch is not triggered for an app source');
    assert.deepEqual(captures.reapplies, ['sourceRelaunched']);
    assert.deepEqual(result, {
      sourceId: 'Terminal',
      macWindowId: 777,
      binding: { macWindowId: 777, pid: 1234, sessionId: 'session-uuid-new' },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('relaunchSource rejects an unknown source id', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-relaunch-unknown-'));
  const captures = { browserRelaunches: [], reapplies: [], relaunchedAppSources: [] };

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    await run({
      cwd: tempDir,
      presentationName: 'demo',
      ...buildRelaunchRunOptions({ captures }),
    });

    await assert.rejects(captures.relaunchSource({ sourceId: 'Mystery' }), /unknown source/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
