import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPresenterHttpServer } from '../../src/presenterHttp.js';
import { rawGet } from '../helpers/http.js';
import { createNoopLogger as createLogger } from '../helpers/logger.js';

test('presenter HTTP server serves presenter assets and status without exposing repo files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presenter-http-'));
  const presenterRoot = path.join(tempDir, 'presenter-web');
  await mkdir(path.join(presenterRoot, 'nested'), { recursive: true });
  await mkdir(path.join(tempDir, 'presenter-web-secret'), { recursive: true });
  await writeFile(path.join(presenterRoot, 'index.html'), '<!doctype html><title>Presenter</title>', 'utf8');
  await writeFile(path.join(presenterRoot, 'teleprompter.html'), '<!doctype html><title>Teleprompter</title>', 'utf8');
  await writeFile(path.join(presenterRoot, 'app.js'), 'console.log("presenter")', 'utf8');
  await writeFile(path.join(tempDir, 'presenter-web-secret', 'config.json'), '{"secret":true}', 'utf8');
  await writeFile(path.join(tempDir, 'config.json'), '{"secret":true}', 'utf8');

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

    const previewUnavailable = await fetch(`http://127.0.0.1:${port}/presenter/program.jpg`);
    assert.equal(previewUnavailable.status, 503);

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

    // The literal `..` path reaches the server unnormalized; the path guard
    // (resolvePathWithinRoot) rejects it with 404 instead of serving the secret
    // file that exists one level above the assets root.
    const traversal = await rawGet(port, '/presenter/../config.json');
    assert.equal(traversal.status, 404);
    assert.doesNotMatch(traversal.body, /secret/);

    // Sibling-prefix traversal: `presenter-web-secret` is a sibling of the
    // assets root whose name shares the root's prefix, so a
    // `startsWith(assetsRoot)` guard would serve it. Dot segments are resolved
    // during URL parsing, so this request never matches the `/presenter/`
    // prefix and is rejected with 404; the containment helper itself rejects
    // the sibling escape at the guard layer (see
    // test/unit/http/pathSafety.test.js).
    const siblingTraversal = await rawGet(port, '/presenter/../presenter-web-secret/config.json');
    assert.equal(siblingTraversal.status, 404);
    assert.doesNotMatch(siblingTraversal.body, /secret/);

    const missing = await fetch(`http://127.0.0.1:${port}/presenter/missing.js`);
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('presenter HTTP server serves the program preview with etag caching', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presenter-http-preview-'));
  const presenterRoot = path.join(tempDir, 'presenter-web');
  await mkdir(presenterRoot, { recursive: true });
  await writeFile(path.join(presenterRoot, 'index.html'), '<!doctype html><title>Presenter</title>', 'utf8');
  const preview = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

  const server = createPresenterHttpServer({
    assetsRoot: presenterRoot,
    getProgramPreview() {
      return {
        body: preview,
        etag: '"presenter-preview-1"',
        lastModified: new Date('2026-08-10T00:00:00.000Z').toUTCString(),
      };
    },
    getStatus() {
      return { service: 'deckhand', current: null, presenter: null };
    },
    host: '127.0.0.1',
    logger: createLogger(),
    presenterBootstrap: { followEnabledByDefault: true, hubUrl: 'ws://127.0.0.1:8765' },
    port: 0,
  });

  try {
    await server.start();
    const { port } = server.getAddress();

    const response = await fetch(`http://127.0.0.1:${port}/presenter/program.jpg`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), '"presenter-preview-1"');
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), preview);

    const notModified = await fetch(`http://127.0.0.1:${port}/presenter/program.jpg`, {
      headers: { 'If-None-Match': '"presenter-preview-1"' },
    });
    assert.equal(notModified.status, 304);
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
