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
