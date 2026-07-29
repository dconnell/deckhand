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

test('run stops the launched Chrome session when startup fails after browser launch', async () => {
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
      createHotkeysFn() {
        return {};
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
          async publishSticky() {},
          async sendCommand() {
            return [];
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
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0], /Coordinator failed to start: startup exploded/);
    assert.deepEqual(lifecycle, [
      'coordinator.start',
      'browserSession.start',
      'cdp.connect',
      'coordinator.stop',
      'browserSession.stop',
      'cdp.disconnect',
      'chrome.stop',
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
