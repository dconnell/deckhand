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
  writePresentationConfig,
} from './helpers.js';

/**
 * Presenter-mode config with two overlay rects: Presenter (below Chrome's
 * minimum window size) and Console (above it).
 * @returns {string} serialized config
 */
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

/**
 * Browser-session factory whose minimum-window probe answers `probeMinimum`.
 * @param {{ width: number, height: number } | null} probeMinimum
 * @returns {() => object} factory for `createBrowserSessionFn`
 */
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
        profileDir: '/tmp/deckhand-below-minimum-warn',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientStub(47213); },
      createBrowserSessionFn: createMinimumProbeBrowserSessionFn({ width: 500, height: 272 }),
      createCoordinatorFn() {
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
        profileDir: '/tmp/deckhand-below-minimum-null',
        async stop() {},
      }),
      discoverCdpEndpointFn: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        chromePid: null,
      }),
      createCdpClientFn() { return createCdpClientStub(47213); },
      createBrowserSessionFn: createMinimumProbeBrowserSessionFn(null),
      createCoordinatorFn() {
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
