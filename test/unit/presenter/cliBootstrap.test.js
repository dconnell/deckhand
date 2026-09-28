import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { loadPresenterCliContext } from '../../../src/presenter/cliBootstrap.js';

function createConsoleLike() {
  return {
    errors: [],
    error(message) {
      this.errors.push(message);
    },
  };
}

async function writePresentationConfig(tempDir, presentationName, configText) {
  const presentationDir = path.join(tempDir, 'presentation', presentationName);
  await mkdir(presentationDir, { recursive: true });
  await writeFile(path.join(presentationDir, 'config.json'), configText, 'utf8');
}

const validConfig = {
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
};

test('loadPresenterCliContext parses args and loads the presentation config', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-cli-bootstrap-'));
  const consoleLike = createConsoleLike();

  try {
    await writePresentationConfig(tempDir, 'demo', JSON.stringify(validConfig, null, 2));

    const result = await loadPresenterCliContext({
      args: ['--wait-ms', '10', 'demo'],
      consoleLike,
      cwd: tempDir,
      options: { 'wait-ms': { type: 'string' } },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(consoleLike.errors, []);
    if (result.ok) {
      assert.equal(result.parsed.presentationName, 'demo');
      assert.equal(result.parsed.values['wait-ms'], '10');
      assert.equal(result.config.hub.port, 8765);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadPresenterCliContext reports argument parse failures', async () => {
  const consoleLike = createConsoleLike();

  const result = await loadPresenterCliContext({
    args: [],
    consoleLike,
    cwd: os.tmpdir(),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(consoleLike.errors, ['Expected exactly one presentation name positional argument']);
});

test('loadPresenterCliContext reports invalid configuration through ConfigError formatting', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-cli-bootstrap-'));
  const consoleLike = createConsoleLike();

  try {
    await writePresentationConfig(tempDir, 'broken', '{not json');

    const result = await loadPresenterCliContext({
      args: ['broken'],
      consoleLike,
      cwd: tempDir,
    });

    assert.equal(result.ok, false);
    assert.equal(consoleLike.errors.length, 1);
    assert.match(consoleLike.errors[0], /^Invalid configuration at /);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadPresenterCliContext reports missing configuration as a load failure', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-cli-bootstrap-'));
  const consoleLike = createConsoleLike();

  try {
    const result = await loadPresenterCliContext({
      args: ['missing'],
      consoleLike,
      cwd: tempDir,
    });

    assert.equal(result.ok, false);
    assert.equal(consoleLike.errors.length, 1);
    assert.match(consoleLike.errors[0], /^Failed to load configuration: ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
