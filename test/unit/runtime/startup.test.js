import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { run } from '../../../src/index.js';
import {
  createEmittingHubStub,
  createHubStub,
  createPresentationServerStub,
  createPresenterHttpStub,
  createSilentConsole,
  writeExamplePresentationConfig,
} from './helpers.js';

test('run exits clearly when config is missing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-missing-config-'));
  const errors = [];

  try {
    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'missing-presentation',
      consoleLike: createSilentConsole({ onError: (message) => errors.push(message) }),
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
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onError: (message) => errors.push(message) }),
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

test('run fails startup when the first driver position never arrives', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-driver-timeout-'));
  const errors = [];

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
          async start() {},
          async stop() {},
          getCurrentPresentationState() {
            return null;
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
      waitForDriverPositionFn: async () => {
        throw new Error('Timed out waiting for the first driver position');
      },
      resolveMacWindowBindingsFn: async () => {},
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0], /Timed out waiting for the first driver position/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run fails startup in presenter mode when no presentation observer connects', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presenter-timeout-'));
  const errors = [];

  try {
    await writeExamplePresentationConfig(tempDir, 'demo');

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'demo',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onError: (message) => errors.push(message) }),
      createHubFn() {
        return createEmittingHubStub();
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
          async start() {},
          async stop() {},
          getCurrentPresentationState() {
            return null;
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
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
