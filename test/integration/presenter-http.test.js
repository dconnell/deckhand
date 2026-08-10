import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPresenterHttpServer } from '../../src/presenterHttp.js';

function createLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

test('presenter HTTP server serves presenter assets and status without exposing repo files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presenter-http-'));
  const presenterRoot = path.join(tempDir, 'presenter-web');
  await mkdir(path.join(presenterRoot, 'nested'), { recursive: true });
  await writeFile(path.join(presenterRoot, 'index.html'), '<!doctype html><title>Presenter</title>', 'utf8');
  await writeFile(path.join(presenterRoot, 'teleprompter.html'), '<!doctype html><title>Teleprompter</title>', 'utf8');
  await writeFile(path.join(presenterRoot, 'app.js'), 'console.log("presenter")', 'utf8');

  const server = createPresenterHttpServer({
    assetsRoot: presenterRoot,
    getStatus() {
      return {
        service: 'deckhand',
        phase: 'ready',
        presenterEnabled: true,
        obs: { connected: true },
        hub: { host: '127.0.0.1', port: 8765, driverConnected: true, observerCount: 1 },
        browserSession: { connected: true, chromePid: 47213, sources: { BrowserA: { ready: true, activeTab: 'home', tabs: ['home', 'checkout'] } } },
        current: null,
      };
    },
    host: '127.0.0.1',
    logger: createLogger(),
    presenterBootstrap: {
      followEnabledByDefault: true,
      hubUrl: 'ws://127.0.0.1:8765',
    },
    port: 0,
  });

  try {
    await server.start();
    const { port } = server.getAddress();

    const presenter = await fetch(`http://127.0.0.1:${port}/presenter/`);
    assert.equal(presenter.status, 200);
    assert.match(await presenter.text(), /Presenter/);

    const teleprompter = await fetch(`http://127.0.0.1:${port}/presenter/teleprompter.html`);
    assert.equal(teleprompter.status, 200);
    assert.match(await teleprompter.text(), /Teleprompter/);

    const bootstrap = await fetch(`http://127.0.0.1:${port}/presenter/bootstrap.json`);
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(await bootstrap.json(), {
      followEnabledByDefault: true,
      hubUrl: 'ws://127.0.0.1:8765',
    });

    const status = await fetch(`http://127.0.0.1:${port}/status.json`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await status.json(), {
      service: 'deckhand',
      phase: 'ready',
      presenterEnabled: true,
      obs: { connected: true },
      hub: { host: '127.0.0.1', port: 8765, driverConnected: true, observerCount: 1 },
      browserSession: { connected: true, chromePid: 47213, sources: { BrowserA: { ready: true, activeTab: 'home', tabs: ['home', 'checkout'] } } },
      current: null,
    });

    const traversal = await fetch(`http://127.0.0.1:${port}/presenter/../config.json`);
    assert.equal(traversal.status, 404);

    const missing = await fetch(`http://127.0.0.1:${port}/presenter/missing.js`);
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
