import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { loadPresentationConfig, parsePresentationCliArgs, resolvePresentationPaths } from '../../src/presentations.js';

test('resolvePresentationPaths maps a presentation name to its self-contained directory', () => {
  assert.deepEqual(resolvePresentationPaths({
    cwd: '/repo',
    presentationName: 'random-presentation',
  }), {
    configPath: path.join('/repo', 'presentation', 'random-presentation', 'config.json'),
    deckEntryPath: path.join('/repo', 'presentation', 'random-presentation', 'deck', 'index.html'),
    deckRoot: path.join('/repo', 'presentation', 'random-presentation', 'deck'),
    localConfigPath: path.join('/repo', 'presentation', 'random-presentation', 'config.local.json'),
    name: 'random-presentation',
    root: path.join('/repo', 'presentation', 'random-presentation'),
    statePath: path.join('/repo', 'presentation', 'random-presentation', '.deckhand-state.json'),
  });
});

test('resolvePresentationPaths rejects traversal and nested path inputs', () => {
  assert.throws(
    () => resolvePresentationPaths({ cwd: '/repo', presentationName: '../secret' }),
    /presentation name/i,
  );
  assert.throws(
    () => resolvePresentationPaths({ cwd: '/repo', presentationName: 'nested/name' }),
    /presentation name/i,
  );
});

test('parsePresentationCliArgs accepts one presentation name plus command flags', () => {
  assert.deepEqual(parsePresentationCliArgs({
    args: ['--check', 'example'],
    options: {
      check: { type: 'boolean', default: false },
    },
  }), {
    presentationName: 'example',
    values: {
      check: true,
    },
  });
});

test('parsePresentationCliArgs requires exactly one presentation name', () => {
  assert.throws(
    () => parsePresentationCliArgs({ args: [], options: {} }),
    /exactly one presentation name/i,
  );
  assert.throws(
    () => parsePresentationCliArgs({ args: ['one', 'two'], options: {} }),
    /exactly one presentation name/i,
  );
});

test('loadPresentationConfig deep-merges config.local.json over config.json when present', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-presentation-config-'));
  const presentationDir = path.join(tempDir, 'presentation', 'demo');

  try {
    await mkdir(presentationDir, { recursive: true });
    await writeFile(path.join(presentationDir, 'config.json'), JSON.stringify({
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
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Safari' },
        },
      },
    }, null, 2), 'utf8');
    await writeFile(path.join(presentationDir, 'config.local.json'), JSON.stringify({
      obs: { password: 'secret' },
      presenter: {
        http: {
          port: 3999,
        },
      },
    }, null, 2), 'utf8');

    const { config, filePath } = await loadPresentationConfig({
      cwd: tempDir,
      presentationName: 'demo',
    });

    assert.equal(filePath, path.join(presentationDir, 'config.local.json'));
    assert.equal(config.obs.url, 'ws://127.0.0.1:4455');
    assert.equal(config.obs.password, 'secret');
    assert.equal(config.presenter.http.port, 3999);
    assert.equal(config.presenter.windows.Slide.app, 'Safari');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
