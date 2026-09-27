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
  createObsClientStub,
  createPresentationServerStub,
  createPresenterHttpStub,
  createSilentConsole,
  writeExamplePresentationConfig,
  writePresentationConfig,
} from './helpers.js';

test('run caches startup window resolution and returns macWindowId from getManagedWindowBindings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-mac-window-id-cache-'));
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
        profileDir: '/tmp/deckhand-run',
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
        return createBrowserSessionStub(47213);
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
        return createPresenterHttpStub();
      },
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
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-registry-seed', async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc', chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientStub(47213); },
      createBrowserSessionFn() { return createBrowserSessionStub(47213); },
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

test('run invalidates cached macWindowId when Hammerspoon reports clearedBindings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-cache-invalidation-'));
  let capturedGetManagedWindowBindings = null;
  let capturedHub = null;

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      createHubFn() {
        capturedHub = createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
        return capturedHub;
      },
      createObsClientFn() {
        return createObsClientStub();
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
        return createCdpClientStub(47213);
      },
      createBrowserSessionFn() {
        return createBrowserSessionStub(47213);
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
        return createPresenterHttpStub();
      },
      createPresentationServerFn() {
        return createPresentationServerStub();
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
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      launchChromeSessionFn: async () => ({
        chromePid: 47213, debugPort: 9222, profileDir: '/tmp/deckhand-owned', async stop() {},
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
      createCoordinatorFn(options) {
        capturedGetManagedWindowBindings = options.getManagedWindowBindings;
        return {
          async start() {}, async stop() {}, getCurrentPresentationState() { return null; },
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
