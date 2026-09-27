import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { run } from '../../../src/index.js';
import {
  createBrowserSessionStub,
  createCdpClientStub,
  createHubStub,
  createObsClientStub,
  createPresentationServerStub,
  createPresenterHttpStub,
  createSilentConsole,
  writeExamplePresentationConfig,
} from './helpers.js';

/**
 * Run options for the resume-replay suites: a fully-stubbed browser runtime
 * whose coordinator reports `currentSlideId` as the live presentation state.
 * @param {{ currentSlideId: string, sentCommands: Array<object> }} inputs
 * @returns {object} run options
 */
function buildResumeRunOptions({ currentSlideId, sentCommands }) {
  return {
    installSignalHandlers: false,
    consoleLike: createSilentConsole(),
    createHubFn() {
      return createHubStub({
        sendCommand: async (target, command) => {
          sentCommands.push({ target, command });
        },
      });
    },
    createObsClientFn() {
      return createObsClientStub();
    },
    launchChromeSessionFn: async () => ({
      chromePid: 47213,
      debugPort: 9321,
      profileDir: '/tmp/deckhand-resume',
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
      const cdpClient = createCdpClient();
      return {
        async start() { await cdpClient.connect(); },
        async stop() { await cdpClient.disconnect(); },
        on() {},
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
            slideId: currentSlideId,
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
  };
}

test('run replays a persisted slide id via goTo when it differs from the reported position', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-resume-replay-'));
  const sentCommands = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');
    const statePath = path.join(tempDir, 'presentation', 'demo', '.deckhand-state.json');
    await writeFile(statePath, JSON.stringify({ slideId: 'demo', index: { h: 1, v: 0 }, savedAtMs: 1 }), 'utf8');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      ...buildResumeRunOptions({ currentSlideId: 'intro', sentCommands }),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(sentCommands, [
      { target: { role: 'driver' }, command: { type: 'goTo', id: 'demo' } },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run does not replay a goTo when the persisted slide matches the reported position', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-resume-match-'));
  const sentCommands = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');
    const statePath = path.join(tempDir, 'presentation', 'demo', '.deckhand-state.json');
    await writeFile(statePath, JSON.stringify({ slideId: 'intro', index: { h: 0, v: 0 }, savedAtMs: 1 }), 'utf8');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      ...buildResumeRunOptions({ currentSlideId: 'intro', sentCommands }),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(sentCommands, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run skips resume replay entirely when the --no-resume flag is set', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-resume-disabled-'));
  const sentCommands = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');
    const statePath = path.join(tempDir, 'presentation', 'demo', '.deckhand-state.json');
    await writeFile(statePath, JSON.stringify({ slideId: 'demo', index: { h: 1, v: 0 }, savedAtMs: 1 }), 'utf8');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      noResume: true,
      ...buildResumeRunOptions({ currentSlideId: 'intro', sentCommands }),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(sentCommands, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
