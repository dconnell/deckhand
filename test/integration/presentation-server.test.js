import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPresentationServer } from '../../src/presentationServer.js';

function createLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

/**
 * Send a GET whose request target goes over the wire exactly as written.
 * `fetch` normalizes `/a/../b` dot segments before they leave the client, so
 * only a raw `node:http` request can probe the server's path guard with an
 * unnormalized traversal path.
 *
 * @param {number} port Server port.
 * @param {string} requestPath Literal request target, dot segments included.
 * @returns {Promise<{ status: number | undefined, body: string }>} Response status and body.
 */
function rawGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('presentation server serves one presentation deck and shared reveal assets without exposing repo files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presentation-server-'));
  const presentationDir = path.join(tempDir, 'presentation', 'demo');
  const revealDir = path.join(tempDir, 'reveal');
  await mkdir(path.join(presentationDir, 'deck'), { recursive: true });
  await mkdir(revealDir, { recursive: true });
  await writeFile(path.join(presentationDir, 'deck', 'index.html'), '<!doctype html><title>Demo Deck</title>', 'utf8');
  await writeFile(path.join(revealDir, 'deckhand-plugin.js'), 'window.DeckhandRevealPlugin = {}', 'utf8');
  await writeFile(path.join(tempDir, 'config.json'), '{"secret":true}', 'utf8');

  const server = createPresentationServer({
    cwd: tempDir,
    host: '127.0.0.1',
    logger: createLogger(),
    port: 0,
    presentationName: 'demo',
  });

  try {
    await server.start();
    const { port } = server.getAddress();

    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/presentation/demo/deck/index.html');

    const deck = await fetch(`http://127.0.0.1:${port}/presentation/demo/deck/index.html`);
    assert.equal(deck.status, 200);
    assert.match(await deck.text(), /Demo Deck/);

    const plugin = await fetch(`http://127.0.0.1:${port}/reveal/deckhand-plugin.js`);
    assert.equal(plugin.status, 200);
    assert.match(await plugin.text(), /DeckhandRevealPlugin/);

    // The literal `..` path reaches the server unnormalized; the path guard
    // (resolveSafePath) rejects it with 404 instead of serving the secret
    // file that exists one level above the deck root.
    const traversal = await rawGet(port, '/presentation/demo/../config.json');
    assert.equal(traversal.status, 404);
    assert.doesNotMatch(traversal.body, /secret/);
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
