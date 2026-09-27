import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { run } from '../../src/index.js';

const exampleConfigPath = fileURLToPath(new URL('../../presentation/example/config.json', import.meta.url));

async function writePresentationConfig(tempDir, presentationName, configText) {
  const presentationDir = path.join(tempDir, 'presentation', presentationName);
  await mkdir(presentationDir, { recursive: true });
  await writeFile(path.join(presentationDir, 'config.json'), configText, 'utf8');
}

async function waitForCondition(check, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for condition');
}

test('run exits clearly when config is missing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-missing-config-'));
  const errors = [];

  try {
    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'missing-presentation',
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0], /Missing configuration file:/);
    assert.match(errors[0], /presentation\/missing-presentation\/config\.json/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run reports adapter construction failures clearly', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-adapter-failure-'));
  const errors = [];

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
      createHubFn() {
        throw new Error('adapter load failed');
      },
      createObsClientFn() {
        return {};
      },
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0], /Failed to build application dependencies: adapter load failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run starts the presenter HTTP server when presenter mode is enabled', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presenter-http-start-'));
  const errors = [];
  const lifecycle = [];

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
      createCoordinatorFn() {
        return {
          async start() {
            lifecycle.push('coordinator.start');
          },
          async stop() {
            lifecycle.push('coordinator.stop');
          },
          getCurrentPresentationState() {
            return null;
          },
        };
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) {
            handlers.set(eventName, handler);
          },
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) {
            return handlers.get(eventName)?.(payload);
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          async applyInputSettings() {},
          getClient() { return this; },
          isConnected() {
            return false;
          },
        };
      },
      createPresenterHttpFn() {
        return {
          async start() {
            lifecycle.push('presenterHttp.start');
          },
          async stop() {
            lifecycle.push('presenterHttp.stop');
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
      reconcileObsFn: async () => {
        lifecycle.push('reconcileObs');
      },
      waitForDriverPositionFn: async ({ hub }) => {
        lifecycle.push('waitForDriverPosition');
        await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });
      },
      waitForPresentationObserverFn: async () => {
        lifecycle.push('waitForPresentationObserver');
      },
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => {
        lifecycle.push('resolveMacWindowBindings');
      },
      resolveOwnedWindowBindingsFn: async () => {
        lifecycle.push('resolveOwnedWindowBindings');
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(lifecycle, [
      'presentationServer.start',
      'coordinator.start',
      'presenterHttp.start',
      'reconcileObs',
      'waitForDriverPosition',
      'waitForPresentationObserver',
      'resolveMacWindowBindings',
      'reconcileObs',
      'resolveOwnedWindowBindings',
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run discovers the actual DevTools port from the launched Chrome session', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-actual-devtools-port-'));
  const lifecycle = [];

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn() {},
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) {
            handlers.set(eventName, handler);
          },
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {} };
          },
          emit(eventName, payload) {
            return handlers.get(eventName)?.(payload);
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          async applyInputSettings() {},
          getClient() { return this; },
          isConnected() {
            return false;
          },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9321,
        profileDir: '/tmp/deckhand-run',
        async stop() {},
      }),
      discoverCdpEndpointFn: async ({ debugPort, profileDir }) => {
        lifecycle.push(`discover:${debugPort}:${profileDir}`);
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
        return {
          async start() {},
          async stop() {},
        };
      },
      createPresentationServerFn() {
        return {
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 3000 }; },
        };
      },
      reconcileObsFn: async () => {
        lifecycle.push('reconcileObs');
      },
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => {},
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(lifecycle, [
      'discover:9321:/tmp/deckhand-run',
      'reconcileObs',
      'reconcileObs',
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run clears the stale Chrome launch handle on transportLost so recovery relaunches Chrome', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-transport-lost-'));
  let launchCount = 0;
  let capturedDiscover = null;
  let transportLostHandler = null;

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn() {},
      },
      createHubFn() {
        return {
          on() {},
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [], sticky: {} };
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          async applyInputSettings() {},
          getClient() { return this; },
          isConnected() {
            return false;
          },
        };
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
        return { async start() {}, async stop() {} };
      },
      createPresentationServerFn() {
        return {
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 3000 }; },
        };
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

function buildResumeRunOptions({ currentSlideId, sentCommands }) {
  return {
    installSignalHandlers: false,
    consoleLike: {
      error() {},
      info() {},
      log() {},
      warn() {},
    },
    createHubFn() {
      return {
        on() {},
        async start() {},
        async stop() {},
        getAddress() {
          return { host: '127.0.0.1', port: 8765 };
        },
        getSnapshot() {
          return { activeDriver: null, observers: [], sticky: {} };
        },
        async sendCommand(target, command) {
          sentCommands.push({ target, command });
        },
      };
    },
    createObsClientFn() {
      return {
        async connect() {},
        async disconnect() {},
        async setScene() {},
        async applyInputSettings() {},
        getClient() { return this; },
        isConnected() {
          return false;
        },
      };
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
      return { async start() {}, async stop() {} };
    },
    createPresentationServerFn() {
      return {
        async start() {},
        async stop() {},
        getAddress() { return { host: '127.0.0.1', port: 3000 }; },
      };
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);
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

function buildRelaunchRunOptions({ captures }) {
  return {
    installSignalHandlers: false,
    consoleLike: {
      error() {},
      info() {},
      log() {},
      warn() {},
    },
    createHubFn() {
      return {
        on() {},
        async start() {},
        async stop() {},
        getAddress() { return { host: '127.0.0.1', port: 8765 }; },
        getSnapshot() { return { activeDriver: null, observers: [], sticky: {} }; },
        async sendCommand() {},
      };
    },
    createObsClientFn() {
      return {
        async connect() {},
        async disconnect() {},
        async setScene() {},
        async applyInputSettings() {},
        getClient() { return this; },
        isConnected() { return false; },
      };
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
      return { async start() {}, async stop() {} };
    },
    createPresentationServerFn() {
      return {
        async start() {},
        async stop() {},
        getAddress() { return { host: '127.0.0.1', port: 3000 }; },
      };
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

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

test('run does not create the presenter HTTP server for audience-only configs', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-no-presenter-http-'));
  let presenterHttpCreated = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
      },
      layouts: {
        'full-slide': {
          audienceScene: 'Full Slide',
          slots: [{ source: 'Slide', position: 'full' }],
        },
      },
      slides: {
        intro: { layout: 'full-slide' },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'audience-only', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'audience-only',
      installSignalHandlers: false,
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn() {},
      },
      createCoordinatorFn() {
        return {
          async start() {},
          async stop() {},
          getCurrentPresentationState() {
            return null;
          },
        };
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) {
            handlers.set(eventName, handler);
          },
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [], sticky: {}, targets: [] };
          },
          emit(eventName, payload) {
            return handlers.get(eventName)?.(payload);
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          async applyInputSettings() {},
          getClient() { return this; },
          isConnected() {
            return false;
          },
        };
      },
      createPresenterHttpFn() {
        presenterHttpCreated = true;
        return {
          async start() {},
          async stop() {},
        };
      },
      createPresentationServerFn() {
        return {
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 3000 };
          },
        };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async ({ hub }) => {
        await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });
      },
      resolveMacWindowBindingsFn: async () => {},
    });

    assert.equal(exitCode, 0);
    assert.equal(presenterHttpCreated, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run uses the browser session cleanup before stopping the launched Chrome process on startup failure', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-chrome-cleanup-'));
  const errors = [];
  const lifecycle = [];

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) {
            handlers.set(eventName, handler);
          },
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [], sticky: {} };
          },
          async publishSticky() {},
          async sendCommand() {
            return [];
          },
          emit(eventName, payload) {
            return handlers.get(eventName)?.(payload);
          },
        };
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
            lifecycle.push('cdp.connect');
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
            lifecycle.push('browserSession.start');
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
    assert.deepEqual(lifecycle, [
      'presentationServer.start',
      'coordinator.start',
      'browserSession.start',
      'cdp.connect',
      'coordinator.stop',
      'browserSession.stop',
      'cdp.disconnect',
      'chrome.stop',
      'presentationServer.stop',
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run fails startup when the first driver position never arrives', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-driver-timeout-'));
  const errors = [];
  const lifecycle = [];

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
      createHubFn() {
        return {
          on() {},
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [], sticky: {} };
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          isConnected() {
            return false;
          },
        };
      },
      createCoordinatorFn() {
        return {
          async start() {
            lifecycle.push('coordinator.start');
          },
          async stop() {
            lifecycle.push('coordinator.stop');
          },
          getCurrentPresentationState() {
            return null;
          },
        };
      },
      createPresenterHttpFn() {
        return {
          async start() {
            lifecycle.push('presenterHttp.start');
          },
          async stop() {
            lifecycle.push('presenterHttp.stop');
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
      waitForDriverPositionFn: async () => {
        throw new Error('Timed out waiting for the first driver position');
      },
      resolveMacWindowBindingsFn: async () => {},
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0], /Timed out waiting for the first driver position/);
    assert.deepEqual(lifecycle, [
      'presentationServer.start',
      'coordinator.start',
      'presenterHttp.start',
      'presenterHttp.stop',
      'coordinator.stop',
      'presentationServer.stop',
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run stops a stale Deckhand Chrome process if discovery fails on the requested port', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-stale-chrome-'));
  const errors = [];
  const lifecycle = [];

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
      createHubFn() {
        return {
          on() {},
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [], sticky: {} };
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          async applyInputSettings() {},
          getClient() { return this; },
          isConnected() {
            return false;
          },
        };
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

test('run fails startup in presenter mode when no presentation observer connects', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presenter-timeout-'));
  const errors = [];
  const lifecycle = [];

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) {
            handlers.set(eventName, handler);
          },
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [], sticky: {} };
          },
          emit(eventName, payload) {
            return handlers.get(eventName)?.(payload);
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          isConnected() {
            return false;
          },
        };
      },
      createCoordinatorFn() {
        return {
          async start() {
            lifecycle.push('coordinator.start');
          },
          async stop() {
            lifecycle.push('coordinator.stop');
          },
          getCurrentPresentationState() {
            return null;
          },
        };
      },
      createPresenterHttpFn() {
        return {
          async start() {
            lifecycle.push('presenterHttp.start');
          },
          async stop() {
            lifecycle.push('presenterHttp.stop');
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
      waitForDriverPositionFn: async ({ hub }) => {
        await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });
      },
      waitForPresentationObserverFn: async () => {
        throw new Error('Timed out waiting for a presenter observer');
      },
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => {},
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0], /Timed out waiting for a presenter observer/);
    assert.deepEqual(lifecycle, [
      'presentationServer.start',
      'coordinator.start',
      'presenterHttp.start',
      'presenterHttp.stop',
      'coordinator.stop',
      'presentationServer.stop',
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function createBrowserSessionMock(chromePid) {
  return {
    async start() {},
    async stop() {},
    async openWindow() { return { windowId: 999 }; },
    async openAuxWindow() { return { key: 'mock', targetId: 'TARGET_MOCK', cdpWindowId: 999, macWindowId: null, title: 'Mock', url: '' }; },
    async measureMinimumWindowSize() { return null; },
    getStatus() {
      return { connected: true, chromePid, sources: {} };
    },
    getRegistry() {
      return {
        sources: {
          Slide: { title: 'Deckhand Deck', macWindowId: 11111 },
          BrowserA: { title: 'Deckhand Demo Primary', macWindowId: 12345 },
          BrowserB: { title: 'Deckhand Demo Secondary', macWindowId: 67890 },
        },
      };
    },
    async activateTab() {},
    async navigateTab() {},
  };
}

function createCdpClientMock(chromePid) {
  return {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getChromePid() {
      return chromePid;
    },
    on() {},
    async createWindow() {},
    async createTab() {},
    async activateTab() {},
    async navigateTab() {},
    async closeTarget() {},
  };
}

function createSilentConsole() {
  return {
    error() {},
    info() {},
    log() {},
    warn() {},
  };
}

test('run caches startup window resolution and returns macWindowId from getManagedWindowBindings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-mac-window-id-cache-'));
  let capturedGetManagedWindowBindings = null;

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) {
            handlers.set(eventName, handler);
          },
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) {
            return handlers.get(eventName)?.(payload);
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          async applyInputSettings() {},
          getClient() { return this; },
          isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-run',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() {
        return createCdpClientMock(47213);
      },
      createBrowserSessionFn() {
        return createBrowserSessionMock(47213);
      },
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return {
          async start() {},
          async stop() {},
          getCurrentPresentationState() { return null; },
        };
      },
      createPresenterHttpFn() {
        return {
          async start() {},
          async stop() {},
        };
      },
      createPresentationServerFn() {
        return {
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 3000 }; },
        };
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
    assert.equal(typeof capturedGetManagedWindowBindings, 'function');

    const bindings = capturedGetManagedWindowBindings();

    assert.equal(bindings.BrowserA.macWindowId, 12345);
    assert.equal(bindings.BrowserB.macWindowId, 67890);
    assert.equal(bindings.Slide.macWindowId, 11111);
    assert.equal(bindings.BrowserA.app, 'Google Chrome');
    assert.equal(bindings.BrowserA.pid, 47213);
    assert.equal(bindings.BrowserA.titleIncludes, 'Deckhand Demo Primary');
    assert.deepEqual(bindings.Presenter, {
      app: 'Google Chrome',
      titleIncludes: 'Deckhand Presenter',
      pid: 47213,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run seeds browser macWindowId bindings from the browser-session registry by default', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-registry-seed-'));
  let capturedGetManagedWindowBindings = null;

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-registry-seed', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
      createBrowserSessionFn() { return createBrowserSessionMock(47213); },
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return { async start() {}, async stop() {}, getCurrentPresentationState() { return null; } };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolvePresenterTeleprompterBindingFn: async () => null,
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);

    const bindings = capturedGetManagedWindowBindings();

    assert.equal(bindings.BrowserA.macWindowId, 12345);
    assert.equal(bindings.BrowserB.macWindowId, 67890);
    assert.equal(bindings.Slide.macWindowId, 11111);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run resolves and caches the presenter teleprompter window binding without sending it to OBS', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presenter-binding-'));
  let capturedGetManagedWindowBindings = null;
  const reconcileCalls = [];

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
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
        return createCdpClientMock(47213);
      },
      createBrowserSessionFn() {
        return {
          async start() {},
          async stop() {},
          async measureMinimumWindowSize() { return null; },
          async openAuxWindow() { return { key: 'presenter-teleprompter', targetId: 'TARGET_1', cdpWindowId: 777, macWindowId: 22222, title: 'Deckhand Presenter', url: 'http://127.0.0.1:3001/presenter/teleprompter.html' }; },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
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
    assert.equal(reconcileCalls.some((call) => Object.prototype.hasOwnProperty.call(call, 'Presenter')), false);
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
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
        return createCdpClientMock(47213);
      },
      createBrowserSessionFn() {
        return {
          async start() {},
          async stop() {},
          async measureMinimumWindowSize() { return null; },
          async openWindow() { return { windowId: 999 }; },
          async openAuxWindow({ key }) {
            if (key === 'presenter-console') {
              return { key, targetId: 'TARGET_CONSOLE', cdpWindowId: 888, macWindowId: 33333, title: 'Deckhand Console', url: 'http://127.0.0.1:3001/presenter/' };
            }
            return { key: 'presenter-teleprompter', targetId: 'TARGET_1', cdpWindowId: 777, macWindowId: 22222, title: 'Deckhand Presenter', url: 'http://127.0.0.1:3001/presenter/teleprompter.html' };
          },
          getStatus() { return { connected: true, chromePid: currentChromePid, sources: {} }; },
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
        return { async start() {}, async stop() {}, getCurrentPresentationState() { return null; } };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
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
        return createCdpClientMock(47213);
      },
      createBrowserSessionFn() {
        return {
          async start() {},
          async stop() {},
          async measureMinimumWindowSize() { return null; },
          async openWindow() { return { windowId: 999 }; },
          async openAuxWindow({ key }) {
            if (key === 'presenter-console') {
              return { key, targetId: 'TARGET_CONSOLE', cdpWindowId: 888, macWindowId: 33333, title: 'Deckhand Console', url: 'http://127.0.0.1:3001/presenter/' };
            }
            return { key: 'presenter-teleprompter', targetId: 'TARGET_1', cdpWindowId: 777, macWindowId: 22222, title: 'Deckhand Presenter', url: 'http://127.0.0.1:3001/presenter/teleprompter.html' };
          },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn(message) { warnings.push(message); },
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
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
        return createCdpClientMock(47213);
      },
      createBrowserSessionFn() {
        return {
          async start() {},
          async stop() {},
          async measureMinimumWindowSize() { return null; },
          async openWindow() { return { windowId: 999 }; },
          async openAuxWindow({ key }) {
            if (key === 'presenter-console') {
              return { key, targetId: 'TARGET_CONSOLE', cdpWindowId: 888, macWindowId: 33333, title: 'Deckhand Console', url: 'http://127.0.0.1:3001/presenter/' };
            }
            return { key: 'presenter-teleprompter', targetId: 'TARGET_1', cdpWindowId: 777, macWindowId: 22222, title: 'Deckhand Presenter', url: 'http://127.0.0.1:3001/presenter/teleprompter.html' };
          },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn(message) { warnings.push(message); },
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
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
        return createCdpClientMock(47213);
      },
      createBrowserSessionFn() {
        return {
          async start() {},
          async stop() {},
          async measureMinimumWindowSize() { return null; },
          async openWindow() { return { windowId: 999 }; },
          async openAuxWindow({ key }) {
            if (key === 'presenter-console') {
              throw new Error('open boom');
            }
            return { key: 'presenter-teleprompter', targetId: 'TARGET_1', cdpWindowId: 777, macWindowId: 22222, title: 'Deckhand Presenter', url: 'http://127.0.0.1:3001/presenter/teleprompter.html' };
          },
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
          async refreshCurrentPresentationState() {
            throw new Error('refresh boom');
          },
        };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
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
        return createCdpClientMock(47213);
      },
      createBrowserSessionFn() {
        return {
          async start() {},
          async stop() {},
          async measureMinimumWindowSize() { return null; },
          async openWindow() { return { windowId: 999 }; },
          async openAuxWindow() { return { key: 'presenter-console', targetId: 'TARGET_CONSOLE', cdpWindowId: 888, macWindowId: null, title: 'Deckhand Console', url: 'http://127.0.0.1:3001/presenter/' }; },
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
        return { async start() {}, async stop() {}, getCurrentPresentationState() { return null; } };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
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
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
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
        return createCdpClientMock(47213);
      },
      createBrowserSessionFn() {
        return {
          async start() {},
          async stop() {},
          async measureMinimumWindowSize() { return null; },
          async openWindow() { return { windowId: 999 }; },
          async openAuxWindow({ key }) {
            if (key === 'presenter-console') {
              return { key, targetId: 'TARGET_CONSOLE', cdpWindowId: 888, macWindowId: 33333, title: 'Deckhand Console', url: 'http://127.0.0.1:3001/presenter/' };
            }
            return { key: 'presenter-teleprompter', targetId: 'TARGET_1', cdpWindowId: 777, macWindowId: 22222, title: 'Deckhand Presenter', url: 'http://127.0.0.1:3001/presenter/teleprompter.html' };
          },
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
        return { async start() {}, async stop() {}, getCurrentPresentationState() { return null; } };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
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

    assert.equal(exitCode, 0);
    assert.equal(reconcileCalls.length >= 1, true);
    assert.equal(reconcileCalls.every((call) => Object.prototype.hasOwnProperty.call(call, 'Console') === false), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run invalidates cached macWindowId when Hammerspoon reports clearedBindings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-cache-invalidation-'));
  let capturedGetManagedWindowBindings = null;
  let capturedHub = null;

  try {
    const config = await readFile(exampleConfigPath, 'utf8');
    await writePresentationConfig(tempDir, 'demo', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        capturedHub = {
          on(eventName, handler) {
            const queue = handlers.get(eventName) ?? [];
            queue.push(handler);
            handlers.set(eventName, queue);
          },
          async start() {},
          async stop() {},
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          async emit(eventName, payload) {
            const queue = handlers.get(eventName) ?? [];
            for (const handler of queue) {
              await handler(payload);
            }
          },
        };
        return capturedHub;
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          async applyInputSettings() {},
          getClient() { return this; },
          isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-run',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() {
        return createCdpClientMock(47213);
      },
      createBrowserSessionFn() {
        return createBrowserSessionMock(47213);
      },
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return {
          async start() {},
          async stop() {},
          getCurrentPresentationState() { return null; },
        };
      },
      createPresenterHttpFn() {
        return {
          async start() {},
          async stop() {},
        };
      },
      createPresentationServerFn() {
        return {
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 3000 }; },
        };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
        BrowserA: { macWindowId: 12345, pid: 47213 },
        BrowserB: { macWindowId: 67890, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);

    const bindingsBefore = capturedGetManagedWindowBindings();
    assert.equal(bindingsBefore.BrowserA.macWindowId, 12345);
    assert.equal(bindingsBefore.BrowserB.macWindowId, 67890);

    await capturedHub.emit('observerWindowBindings', {
      bindings: {},
      cleared: ['BrowserA'],
      sender: { role: 'observer', sessionId: 'observer-1' },
    });

    const bindingsAfter = capturedGetManagedWindowBindings();
    assert.equal(bindingsAfter.BrowserA.macWindowId, undefined);
    assert.equal(bindingsAfter.BrowserA.titleIncludes, 'Deckhand Demo Primary');
    assert.equal(bindingsAfter.BrowserB.macWindowId, 67890);
    assert.equal(bindingsAfter.Slide.macWindowId, 11111);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run derives owner names and publishes strict macWindowId bindings for owned app sources', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-owned-bindings-'));
  let capturedGetManagedWindowBindings = null;
  const reconcileCalls = [];

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Terminal: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
        Editor: { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'] },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-terminal': { audienceScene: 'Full Terminal', slots: [{ source: 'Terminal', position: 'full' }] },
        'full-editor': { audienceScene: 'Full Editor', slots: [{ source: 'Editor', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'owned', config);

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'owned',
      installSignalHandlers: false,
      preflightEnumerateWindowsFn: () => [],
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-owned', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
      createBrowserSessionFn() {
        return {
          async start() {}, async stop() {}, async openWindow() {}, async openAuxWindow() { return { key: 'mock', targetId: 'TARGET_MOCK', cdpWindowId: 999, macWindowId: null, title: 'Mock', url: '' }; },
          async measureMinimumWindowSize() { return null; },
          getStatus() { return { connected: true, chromePid: 47213, sources: {} }; },
          getRegistry() { return { sources: { Slide: { title: 'Deckhand Deck' } } }; },
          async activateTab() {}, async navigateTab() {},
        };
      },
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return {
          async start() {}, async stop() {}, getCurrentPresentationState() { return null; },
        };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async ({ windowBindings }) => {
        reconcileCalls.push({ ...windowBindings });
      },
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({
        Terminal: { macWindowId: 555, pid: 4321 },
        Editor: { macWindowId: 888 },
      }),
    });

    assert.equal(exitCode, 0);

    const bindings = capturedGetManagedWindowBindings();

    assert.deepEqual(bindings.Terminal, { app: 'iTerm2', macWindowId: 555, pid: 4321 });
    assert.deepEqual(bindings.Editor, { app: 'Visual Studio Code', macWindowId: 888 });
    assert.equal(bindings.Slide.app, 'Google Chrome');
    assert.equal(bindings.Slide.titleIncludes, 'Deckhand Deck');
    assert.equal(bindings.Slide.pid, 47213);
    assert.equal(bindings.Slide.macWindowId, 11111);

    const ownedReconcile = reconcileCalls.find((call) => call.Terminal !== undefined);
    assert.ok(ownedReconcile, 'expected an OBS reconcile call covering owned sources');
    assert.deepEqual(ownedReconcile.Terminal, {
      app: 'iTerm', macWindowId: 555, pid: 4321, strict: true,
    });
    assert.deepEqual(ownedReconcile.Editor, {
      app: 'Code', macWindowId: 888, strict: true,
    });
    assert.deepEqual(ownedReconcile.Slide, {
      app: 'Google Chrome', macWindowId: 11111, pid: 47213, strict: true,
    },
    'browser source bindings must survive the owned-source reconcile');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run requests stability confirmation for owned app-window binding resolution', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-owned-stability-'));
  const capturedEntries = [];

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Editor: { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'] },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-editor': { audienceScene: 'Full Editor', slots: [{ source: 'Editor', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'owned-stability', config);

    const capturedAppSnapshots = [];

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'owned-stability',
      installSignalHandlers: false,
      preflightEnumerateWindowsFn: () => [],
      consoleLike: createSilentConsole(),
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-owned-stability', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async ({ config }) => {
        for (const [sourceId, source] of Object.entries(config.sources)) {
          if (source?.kind === 'app') {
            capturedEntries.push(sourceId);
            capturedAppSnapshots.push(source.app);
          }
        }
        return {};
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(capturedEntries, ['Editor']);
    assert.deepEqual(capturedAppSnapshots, ['Visual Studio Code']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run closes owned app windows on shutdown via closeOwnedWindowsFn', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-owned-'));
  const closedBindings = [];
  const originalExit = process.exit;
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Terminal: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-terminal': { audienceScene: 'Full Terminal', slots: [{ source: 'Terminal', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown',
      installSignalHandlers: true,
      consoleLike: createSilentConsole(),
      closeOwnedWindowsFn: ({ bindings }) => {
        closedBindings.push(...bindings);
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
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

test('run requests discardUnsavedChanges when shutting down owned app windows', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-owned-discard-'));
  const closedBindings = [];
  const originalExit = process.exit;
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Editor: { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'] },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-editor': { audienceScene: 'Full Editor', slots: [{ source: 'Editor', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-discard', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-discard',
      installSignalHandlers: true,
      preflightEnumerateWindowsFn: () => [],
      consoleLike: createSilentConsole(),
      closeOwnedWindowsFn: ({ bindings }) => {
        closedBindings.push(...bindings);
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-discard', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
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

test('run does not terminate the owned app process when tracked window close does not confirm', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-app-no-kill-'));
  const originalExit = process.exit;
  const terminated = [];
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Editor: { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'] },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-editor': { audienceScene: 'Full Editor', slots: [{ source: 'Editor', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-app-no-kill', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-app-no-kill',
      installSignalHandlers: true,
      preflightEnumerateWindowsFn: () => [],
      consoleLike: createSilentConsole(),
      closeMacWindowFn: () => false,
      terminateProcessGroupFn: async (pid, logger, sourceId) => {
        terminated.push({ pid, sourceId });
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-app-no-kill', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.deepEqual(terminated, []);
});

test('run app shutdown closes only tracked macWindowId and never invokes process-group fallback', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-app-tracked-only-'));
  const originalExit = process.exit;
  const closeCalls = [];
  const terminated = [];
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Editor: { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'] },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-editor': { audienceScene: 'Full Editor', slots: [{ source: 'Editor', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-app-tracked-only', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-app-tracked-only',
      installSignalHandlers: true,
      preflightEnumerateWindowsFn: () => [],
      consoleLike: createSilentConsole(),
      closeMacWindowFn: (macWindowId, pid, options) => {
        closeCalls.push({ macWindowId, pid, options });
        return true;
      },
      terminateProcessGroupFn: async (pid, logger, sourceId) => {
        terminated.push({ pid, sourceId });
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-app-tracked-only', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(closeCalls.length, 1);
  assert.deepEqual(closeCalls[0], {
    macWindowId: 888,
    pid: 9999,
    options: { discardUnsavedChanges: true },
  });
  assert.deepEqual(terminated, []);
});

test('run shutdown closes app window whose binding was cleared mid-run', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-shutdown-cleared-binding-'));
  const closedBindings = [];
  const originalExit = process.exit;
  let hubInstance = null;
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Terminal: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-terminal': { audienceScene: 'Full Terminal', slots: [{ source: 'Terminal', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-cleared-binding', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-cleared-binding',
      installSignalHandlers: true,
      consoleLike: createSilentConsole(),
      closeOwnedWindowsFn: ({ bindings }) => {
        closedBindings.push(...bindings);
      },
      createHubFn() {
        const handlers = new Map();
        hubInstance = {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
        return hubInstance;
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-cleared-binding', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
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
  const originalExit = process.exit;
  let hubInstance = null;
  let exitCalled = false;
  let relaunchSource = null;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Terminal: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-terminal': { audienceScene: 'Full Terminal', slots: [{ source: 'Terminal', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-relaunch-fail', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-relaunch-fail',
      installSignalHandlers: true,
      consoleLike: createSilentConsole(),
      relaunchAppSourceFn: async () => ({ macWindowId: undefined }),
      closeOwnedWindowsFn: ({ bindings }) => {
        closedBindings.push(...bindings);
      },
      createHubFn() {
        const handlers = new Map();
        hubInstance = {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
        return hubInstance;
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-relaunch-fail', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
      createBrowserSessionFn() {
        return {
          async start() {}, async stop() {}, async openWindow() {}, async openAuxWindow() { return { key: 'mock', targetId: 'TARGET_MOCK', cdpWindowId: 999, macWindowId: null, title: 'Mock', url: '' }; },
          async measureMinimumWindowSize() { return null; },
          getStatus() { return { connected: true, chromePid: 47213, sources: {} }; },
          getRegistry() { return { sources: { Slide: { title: 'Deckhand Deck' } } }; },
          async activateTab() {}, async navigateTab() {},
        };
      },
      createCoordinatorFn(options) {
        relaunchSource = options.relaunchSource;
        return {
          async start() {}, async stop() {}, getCurrentPresentationState() { return null; },
          async reapplyCurrentSlide() {},
        };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
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
  const originalExit = process.exit;
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Terminal: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
        Editor: { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'] },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-terminal': { audienceScene: 'Full Terminal', slots: [{ source: 'Terminal', position: 'full' }] },
        'full-editor': { audienceScene: 'Full Editor', slots: [{ source: 'Editor', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-unbound', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-unbound',
      installSignalHandlers: true,
      preflightEnumerateWindowsFn: () => [],
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn(message) { warnings.push(message); },
      },
      closeOwnedWindowsFn: ({ bindings }) => {
        for (const binding of bindings) {
          closedSourceIds.push(binding.sourceId);
        }
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-unbound', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
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
  const originalExit = process.exit;
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Alpha: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
        Beta: { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'] },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-alpha': { audienceScene: 'Full Alpha', slots: [{ source: 'Alpha', position: 'full' }] },
        'full-beta': { audienceScene: 'Full Beta', slots: [{ source: 'Beta', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-hang', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-hang',
      installSignalHandlers: true,
      preflightEnumerateWindowsFn: () => [],
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn(message) { warnings.push(message); },
      },
      shutdownCloseTimeoutMs: 50,
      closeOwnedWindowsFn: ({ bindings }) => {
        const sourceId = bindings[0]?.sourceId;

        if (sourceId === 'Alpha') {
          return new Promise(() => {});
        }

        closedSourceIds.push(sourceId);
        return undefined;
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-hang', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
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
  const originalExit = process.exit;
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-stop-hang', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-stop-hang',
      installSignalHandlers: true,
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn(message) { warnings.push(message); },
      },
      shutdownStopTimeoutMs: 50,
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-stop-hang', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
          async start() {},
          // Wedged OBS websocket: coordinator stop never settles.
          stop() { return new Promise(() => {}); },
          getCurrentPresentationState() { return null; },
        };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
    });

    assert.equal(exitCode, 0);

    try {
      process.emit('SIGTERM');
    } catch {
      // process.exit inside the handler throws — expected
    }

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
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
  const originalExit = process.exit;
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Terminal: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-terminal': { audienceScene: 'Full Terminal', slots: [{ source: 'Terminal', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-order', config);

    process.exit = () => {
      exitCalled = true;
      teardownEvents.push('exit');
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-order',
      installSignalHandlers: true,
      consoleLike: createSilentConsole(),
      closeOwnedWindowsFn: () => {
        teardownEvents.push('closeOwnedWindows');
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-order', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
          async start() {}, async stop() { teardownEvents.push('coordinator.stop'); }, getCurrentPresentationState() { return null; },
        };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
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
  const originalExit = process.exit;
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Terminal: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-terminal': { audienceScene: 'Full Terminal', slots: [{ source: 'Terminal', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-sighup', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-sighup',
      installSignalHandlers: true,
      consoleLike: createSilentConsole(),
      closeOwnedWindowsFn: ({ bindings }) => {
        closedBindings.push(...bindings);
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-sighup', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);

    // `run()` also bound SIGTERM for this presentation; consume that
    // once-listener so it cannot fire during a later test's emit.
    try {
      process.emit('SIGTERM');
    } catch {
      // no-op — teardown already ran
    }
  } finally {
    process.exit = originalExit;
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
  const originalExit = process.exit;
  let exitCalled = false;

  try {
    const config = JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
        Terminal: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
      },
      layouts: {
        'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
        'full-terminal': { audienceScene: 'Full Terminal', slots: [{ source: 'Terminal', position: 'full' }] },
      },
      slides: { intro: { layout: 'full-slide' } },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        },
      },
    }, null, 2);
    await writePresentationConfig(tempDir, 'shutdown-reentry', config);

    process.exit = () => {
      exitCalled = true;
      throw new Error('EXIT_CALLED');
    };

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'shutdown-reentry',
      installSignalHandlers: true,
      consoleLike: createSilentConsole(),
      closeOwnedWindowsFn: async () => {
        closeCalls += 1;
        // Keep the first teardown in flight when the second signal lands.
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {},
          async applyInputSettings() {}, getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-shutdown-reentry', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
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
          async start() {}, async stop() { stopCalls += 1; }, getCurrentPresentationState() { return null; },
        };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
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

    await waitForCondition(() => exitCalled);
  } finally {
    process.exit = originalExit;
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(closeCalls, 1);
  assert.equal(stopCalls, 1);
});

function createVscodeAppConfig({ sourceArgs } = {}) {
  // Minimal presenter-less config whose only source is a VS Code app window:
  // the Electron adapter gates on an already-running instance. `sourceArgs`
  // optionally names a workspace (e.g. `['--new-window', '/path/to/repo']`),
  // which scopes the preflight gate to windows of THAT project.
  return JSON.stringify({
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { port: 8765 },
    sources: {
      Editor: sourceArgs === undefined
        ? { kind: 'app', app: 'Visual Studio Code' }
        : { kind: 'app', app: 'Visual Studio Code', args: sourceArgs },
    },
    layouts: {
      'full-slide': {
        audienceScene: 'Full Slide',
        slots: [{ source: 'Editor', position: 'full' }],
      },
    },
    slides: {
      intro: { layout: 'full-slide' },
    },
  }, null, 2);
}

/**
 * Create a temp bin dir containing a fake `code` CLI so the preflight
 * workspace probe (`code --status` on the real vscode adapter) is
 * deterministic: without it the operator's installed CLI would decide which
 * preflight path (probe vs enumeration fallback) the run takes.
 */
async function createCodeStubBin(tempDir, statusScriptBody) {
  const binDir = path.join(tempDir, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, 'code'),
    `#!/bin/sh\n${statusScriptBody}`,
    { encoding: 'utf8', mode: 0o755 },
  );
  return binDir;
}

/** Point PATH exclusively at `binDir` so only the stubbed `code` is resolvable. */
async function runWithPath(binDir, runFn) {
  const originalPath = process.env.PATH;
  process.env.PATH = binDir;

  try {
    return await runFn();
  } finally {
    process.env.PATH = originalPath;
  }
}

test('run refuses to start before any side effects when a gated owned app already has windows open', { skip: process.platform !== 'darwin' }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-preflight-conflict-'));
  const errors = [];
  const factoryCalls = [];

  try {
    await writePresentationConfig(tempDir, 'vscode-open', createVscodeAppConfig());

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'vscode-open',
      installSignalHandlers: false,
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
      preflightEnumerateWindowsFn: (ownerName) => (
        ownerName === 'Code'
          ? [
            { windowId: 1, title: 'run.js — deckhand' },
            { windowId: 2, title: 'README.md — deckhand' },
          ]
          : []
      ),
      createHubFn() {
        factoryCalls.push('hub');
        return {};
      },
      createObsClientFn() {
        factoryCalls.push('obs');
        return {};
      },
      createCoordinatorFn() {
        factoryCalls.push('coordinator');
        return {};
      },
      createPresenterHttpFn() {
        factoryCalls.push('presenterHttp');
        return {};
      },
      createPresentationServerFn() {
        factoryCalls.push('presentationServer');
        return {};
      },
      launchChromeSessionFn: async () => {
        factoryCalls.push('chrome');
        return { async stop() {} };
      },
      reconcileObsFn: async () => {
        factoryCalls.push('reconcileObs');
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(factoryCalls, [], 'no startup side effect may run before the preflight gate');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Refusing to start: owned app already running/);
    assert.match(errors[0], /- Editor: "Visual Studio Code" already has 2 window\(s\) open/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run refuses to start when the gated owned app already has the configured workspace open (enumeration fallback)', { skip: process.platform !== 'darwin' }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-preflight-workspace-'));
  const errors = [];
  const factoryCalls = [];

  try {
    await writePresentationConfig(tempDir, 'vscode-open', createVscodeAppConfig({
      sourceArgs: ['--new-window', '/Users/me/repos/dc-enclave'],
    }));

    // A failing `code` CLI forces the probe to report failure (null), so this
    // pins the enumeration-fallback message variant: the probe's success path
    // has its own test below.
    const binDir = await createCodeStubBin(tempDir, 'echo "code: status failed" >&2\nexit 1\n');

    const exitCode = await runWithPath(binDir, () => run({
      cwd: tempDir,
      presentationName: 'vscode-open',
      installSignalHandlers: false,
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
      // One window of the configured workspace plus one unrelated project:
      // the gate must name the workspace and count only its window.
      preflightEnumerateWindowsFn: (ownerName) => (
        ownerName === 'Code'
          ? [
            { windowId: 1, title: 'postinstall.js — dc-enclave' },
            { windowId: 2, title: 'readme — unrelated' },
          ]
          : []
      ),
      createHubFn() {
        factoryCalls.push('hub');
        return {};
      },
      createObsClientFn() {
        factoryCalls.push('obs');
        return {};
      },
      createCoordinatorFn() {
        factoryCalls.push('coordinator');
        return {};
      },
      createPresenterHttpFn() {
        factoryCalls.push('presenterHttp');
        return {};
      },
      createPresentationServerFn() {
        factoryCalls.push('presentationServer');
        return {};
      },
      launchChromeSessionFn: async () => {
        factoryCalls.push('chrome');
        return { async stop() {} };
      },
      reconcileObsFn: async () => {
        factoryCalls.push('reconcileObs');
      },
    }));

    assert.equal(exitCode, 1);
    assert.deepEqual(factoryCalls, [], 'no startup side effect may run before the preflight gate');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Refusing to start: owned app already running/);
    assert.match(errors[0], /- Editor: "Visual Studio Code" already has "dc-enclave" open \(1 window\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run refuses to start when the workspace probe reports the configured workspace open', { skip: process.platform !== 'darwin' }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-preflight-probe-'));
  const errors = [];
  const factoryCalls = [];

  try {
    await writePresentationConfig(tempDir, 'vscode-open', createVscodeAppConfig({
      sourceArgs: ['--new-window', '/Users/me/repos/dc-enclave'],
    }));

    // A working `code` CLI answers authoritatively, so the conflict message
    // carries no window count — the probe knows about workspaces, not windows
    // (it even sees multi-root folders that titles never show). The script
    // only uses shell builtins: with PATH pointing solely at the stub bin
    // dir, external binaries like `touch` would not resolve.
    const probeSentinel = path.join(tempDir, 'probe-invoked');
    const binDir = await createCodeStubBin(tempDir, [
      `echo invoked > ${probeSentinel}`,
      "echo 'Workspace Stats:'",
      "echo '|  Window (README.md — deckhand)'",
      "echo '|    Folder (dc-enclave): 1768 files'",
      'exit 0',
    ].join('\n'));

    const exitCode = await runWithPath(binDir, () => run({
      cwd: tempDir,
      presentationName: 'vscode-open',
      installSignalHandlers: false,
      consoleLike: {
        error(message) {
          errors.push(message);
        },
        info() {},
        log() {},
        warn() {},
      },
      preflightEnumerateWindowsFn: () => {
        throw new Error('enumeration must not run when the probe answers');
      },
      createHubFn() {
        factoryCalls.push('hub');
        return {};
      },
      createObsClientFn() {
        factoryCalls.push('obs');
        return {};
      },
      createCoordinatorFn() {
        factoryCalls.push('coordinator');
        return {};
      },
      createPresenterHttpFn() {
        factoryCalls.push('presenterHttp');
        return {};
      },
      createPresentationServerFn() {
        factoryCalls.push('presentationServer');
        return {};
      },
      launchChromeSessionFn: async () => {
        factoryCalls.push('chrome');
        return { async stop() {} };
      },
      reconcileObsFn: async () => {
        factoryCalls.push('reconcileObs');
      },
    }));

    assert.equal(exitCode, 1);
    assert.deepEqual(factoryCalls, [], 'no startup side effect may run before the preflight gate');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Refusing to start: owned app already running/);
    assert.match(errors[0], /- Editor: "Visual Studio Code" already has "dc-enclave" open$/m);
    assert.doesNotMatch(errors[0], /\(\d+ windows?\)/);
    // The Window row is a display title, not an open-workspace signal: only
    // the Folder row may drive the conflict.
    assert.doesNotMatch(errors[0], /README\.md — deckhand/);
    assert.equal(await readFile(probeSentinel, 'utf8'), 'invoked\n', 'the probe must have run');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run proceeds normally when the preflight finds no gated app windows open', { skip: process.platform !== 'darwin' }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-preflight-clear-'));
  const lifecycle = [];

  try {
    await writePresentationConfig(tempDir, 'vscode-open', createVscodeAppConfig());

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'vscode-open',
      installSignalHandlers: false,
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn() {},
      },
      preflightEnumerateWindowsFn: () => [],
      createHubFn() {
        return {
          on() {},
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() { return { activeDriver: null, observers: [], sticky: {} }; },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
          async setScene() {},
          async applyInputSettings() {},
          getClient() { return this; },
          isConnected() { return false; },
        };
      },
      createCoordinatorFn() {
        return {
          async start() {
            lifecycle.push('coordinator.start');
          },
          async stop() {},
          getCurrentPresentationState() { return null; },
        };
      },
      createPresentationServerFn() {
        return {
          async start() {
            lifecycle.push('presentationServer.start');
          },
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 3000 }; },
        };
      },
      reconcileObsFn: async () => {
        lifecycle.push('reconcileObs');
      },
      waitForDriverPositionFn: async () => {
        lifecycle.push('waitForDriverPosition');
      },
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(lifecycle, [
      'presentationServer.start',
      'coordinator.start',
      'reconcileObs',
      'waitForDriverPosition',
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function buildBelowMinimumOverlayConfig() {
  return JSON.stringify({
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { port: 8765 },
    sources: {
      Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
    },
    layouts: {
      'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
    },
    slides: { intro: { layout: 'full-slide' } },
    presenter: {
      platform: 'macos',
      stage: { x: 0, y: 0, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
      },
      overlays: [
        { source: 'Presenter', rect: { x: 0, y: 0, w: 300, h: 400 } },
        { source: 'Console', rect: { x: 0, y: 0, w: 965, h: 710 } },
      ],
      teleprompter: {
        window: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
      },
    },
  }, null, 2);
}

function createMinimumProbeBrowserSessionFn(probeMinimum) {
  return () => ({
    async start() {},
    async stop() {},
    on() {},
    async openWindow() { return { windowId: 999 }; },
    async openAuxWindow({ key }) {
      if (key === 'presenter-console') {
        return { key, targetId: 'TARGET_CONSOLE', cdpWindowId: 888, macWindowId: 33333, title: 'Deckhand Console', url: 'http://127.0.0.1:3001/presenter/' };
      }
      return { key: 'presenter-teleprompter', targetId: 'TARGET_1', cdpWindowId: 777, macWindowId: 22222, title: 'Deckhand Presenter', url: 'http://127.0.0.1:3001/presenter/teleprompter.html' };
    },
    async measureMinimumWindowSize() { return probeMinimum; },
    getStatus() { return { connected: true, chromePid: 47213, sources: {} }; },
    getRegistry() {
      return { sources: { Slide: { title: 'Deckhand Deck' } }, auxWindows: {} };
    },
    async activateTab() {},
    async navigateTab() {},
  });
}

test('run warns once per overlay rect below the measured Chrome minimum window size', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-below-minimum-warn-'));
  const warnings = [];

  try {
    await writePresentationConfig(tempDir, 'demo', buildBelowMinimumOverlayConfig());

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn(message) { warnings.push(message); },
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-below-minimum-warn',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
      createBrowserSessionFn: createMinimumProbeBrowserSessionFn({ width: 500, height: 272 }),
      createCoordinatorFn() {
        return {
          async start() {},
          async stop() {},
          getCurrentPresentationState() { return null; },
        };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolvePresenterTeleprompterBindingFn: async () => null,
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);

    const minimumWarns = warnings.filter((message) => message.includes('Configured overlay rect is below Chrome minimum window size'));
    // Only the Presenter rect (300x400) is below the 500x272 minimum; the
    // Console rect (965x710) must not produce a warn.
    assert.equal(minimumWarns.length, 1, `expected exactly one below-minimum warn, got: ${JSON.stringify(warnings)}`);
    assert.ok(minimumWarns[0].includes('"Presenter"'), `the warn must identify the source, got: ${minimumWarns[0]}`);
    assert.ok(minimumWarns[0].includes('presenter.overlays'), `the warn must identify the origin, got: ${minimumWarns[0]}`);
    assert.ok(minimumWarns[0].includes('"minimum":{"width":500,"height":272}'), `the warn must carry the measured minimum, got: ${minimumWarns[0]}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run skips the below-minimum warn when the Chrome minimum probe returns null', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-below-minimum-null-'));
  const warnings = [];

  try {
    await writePresentationConfig(tempDir, 'demo', buildBelowMinimumOverlayConfig());

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: {
        error() {},
        info() {},
        log() {},
        warn(message) { warnings.push(message); },
      },
      createHubFn() {
        const handlers = new Map();
        return {
          on(eventName, handler) { handlers.set(eventName, handler); },
          async start() {},
          async stop() {},
          getAddress() { return { host: '127.0.0.1', port: 8765 }; },
          getSnapshot() {
            return { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] };
          },
          emit(eventName, payload) { return handlers.get(eventName)?.(payload); },
        };
      },
      createObsClientFn() {
        return {
          async connect() {}, async disconnect() {}, async setScene() {}, async applyInputSettings() {},
          getClient() { return this; }, isConnected() { return false; },
        };
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213,
        debugPort: 9222,
        profileDir: '/tmp/deckhand-below-minimum-null',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientMock(47213); },
      createBrowserSessionFn: createMinimumProbeBrowserSessionFn(null),
      createCoordinatorFn() {
        return {
          async start() {},
          async stop() {},
          getCurrentPresentationState() { return null; },
        };
      },
      createPresenterHttpFn() { return { async start() {}, async stop() {} }; },
      createPresentationServerFn() {
        return { async start() {}, async stop() {}, getAddress() { return { host: '127.0.0.1', port: 3000 }; } };
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolvePresenterTeleprompterBindingFn: async () => null,
      resolveMacWindowBindingsFn: async () => ({
        Slide: { macWindowId: 11111, pid: 47213 },
      }),
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    assert.equal(
      warnings.some((message) => message.includes('Configured overlay rect is below Chrome minimum window size')),
      false,
      `no below-minimum warn may appear when the probe fails, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
