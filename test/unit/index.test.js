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
        return {};
      },
      createObsClientFn() {
        return {};
      },
      createHotkeysFn() {
        throw new Error('uiohook load failed');
      },
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0], /Failed to build application dependencies: uiohook load failed/);
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
      createHotkeysFn() {
        return {};
      },
      createHubFn() {
        return {
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [], sticky: {}, targets: [] };
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
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
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(lifecycle, ['coordinator.start', 'presenterHttp.start']);
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
      hotkeys: { next: 'F13', prev: 'F14' },
      sources: {
        Slide: { kind: 'browser' },
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
      createHotkeysFn() {
        return {};
      },
      createHubFn() {
        return {
          getAddress() {
            return { host: '127.0.0.1', port: 8765 };
          },
          getSnapshot() {
            return { activeDriver: null, observers: [], sticky: {}, targets: [] };
          },
        };
      },
      createObsClientFn() {
        return {
          async connect() {},
          async disconnect() {},
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
    });

    assert.equal(exitCode, 0);
    assert.equal(presenterHttpCreated, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
