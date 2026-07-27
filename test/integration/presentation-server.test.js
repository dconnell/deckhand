import assert from 'node:assert/strict';
import test from 'node:test';

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

    const traversal = await fetch(`http://127.0.0.1:${port}/presentation/demo/../config.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
