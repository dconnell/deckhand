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
    async openWindow() {},
    getStatus() {
      return { connected: true, chromePid, sources: {} };
    },
    getRegistry() {
      return {
        sources: {
          Slide: { title: 'Deckhand Deck' },
          BrowserA: { title: 'Deckhand Demo Primary' },
          BrowserB: { title: 'Deckhand Demo Secondary' },
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
        Terminal: { kind: 'iterm2', command: 'npm run dev', cwd: '/repos/demo' },
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
          async start() {}, async stop() {}, async openWindow() {},
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

    assert.deepEqual(bindings.Terminal, { app: 'iTerm', macWindowId: 555, pid: 4321 });
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
      app: 'Visual Studio Code', macWindowId: 888, strict: true,
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
          async start() {}, async stop() {}, async openWindow() {},
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
        Terminal: { kind: 'iterm2', command: 'npm run dev', cwd: '/repos/demo' },
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
          async start() {}, async stop() {}, async openWindow() {},
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
    kind: 'iterm2',
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
          async start() {}, async stop() {}, async openWindow() {},
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
    ownerName: 'Visual Studio Code',
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
          async start() {}, async stop() {}, async openWindow() {},
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
          async start() {}, async stop() {}, async openWindow() {},
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
