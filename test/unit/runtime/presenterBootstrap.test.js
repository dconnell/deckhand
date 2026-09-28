import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { run } from '../../../src/index.js';
import {
  createEmittingHubStub,
  createObsClientStub,
  createPresentationServerStub,
  createSilentConsole,
  writeExamplePresentationConfig,
  writePresentationConfig,
} from './helpers.js';

test('run starts the presenter HTTP server when presenter mode is enabled', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presenter-http-start-'));
  const errors = [];
  const lifecycle = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onError: (message) => errors.push(message) }),
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
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [{ role: 'observer', subscriptions: ['presentationState'] }], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      createPresenterHttpFn() {
        return {
          async start() {
            lifecycle.push('presenterHttp.start');
          },
          async stop() {},
        };
      },
      createPresentationServerFn() {
        return createPresentationServerStub();
      },
      reconcileObsFn: async () => {
        lifecycle.push('reconcileObs');
      },
      waitForDriverPositionFn: async ({ hub }) => {
        await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });
      },
      waitForPresentationObserverFn: async () => {},
      runSttObserverFn: async () => {},
      resolveMacWindowBindingsFn: async () => {},
      resolveOwnedWindowBindingsFn: async () => {
        lifecycle.push('resolveOwnedWindowBindings');
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(errors, []);
    assert.ok(lifecycle.includes('presenterHttp.start'));
    // Real sequencing invariant: owned-window resolution is the final startup
    // stage — the last OBS reconcile runs on browser-stage bindings BEFORE
    // the owned stage resolves (and this stub resolves nothing, so it never
    // triggers a follow-up reconcile).
    assert.ok(lifecycle.lastIndexOf('reconcileObs') < lifecycle.indexOf('resolveOwnedWindowBindings'));
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
      consoleLike: createSilentConsole(),
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
        return createEmittingHubStub({
          snapshot: { activeDriver: null, observers: [], sticky: {}, targets: [] },
        });
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      createPresenterHttpFn() {
        presenterHttpCreated = true;
        return {
          async start() {},
          async stop() {},
        };
      },
      createPresentationServerFn() {
        return createPresentationServerStub();
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async ({ hub }) => {
        await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });
      },
      resolveMacWindowBindingsFn: async () => {},
    });

    assert.equal(exitCode, 0);
    assert.equal(presenterHttpCreated, false, 'an audience-only config must never build the presenter HTTP server');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
