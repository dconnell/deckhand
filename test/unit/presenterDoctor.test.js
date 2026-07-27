import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { runPresenterDoctor } from '../../src/presenterDoctor.js';

function createConsoleLike() {
  return {
    errors: [],
    logs: [],
    error(message) {
      this.errors.push(message);
    },
    log(message) {
      this.logs.push(message);
    },
  };
}

async function writePresentationConfig(tempDir, presentationName, config) {
  const presentationDir = path.join(tempDir, 'presentation', presentationName);
  await mkdir(presentationDir, { recursive: true });
  await writeFile(path.join(presentationDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

test('runPresenterDoctor reports audience-only configs without failing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-doctor-audience-'));
  const consoleLike = createConsoleLike();

  try {
    await writePresentationConfig(tempDir, 'audience-only', {
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      hotkeys: { next: 'F13', prev: 'F14' },
      layouts: {
        'full-slide': {
          audienceScene: 'Full Slide',
          slots: [{ source: 'Slide', position: 'full' }],
        },
      },
      slides: {
        intro: { layout: 'full-slide' },
      },
    });

    const exitCode = await runPresenterDoctor({
      args: ['audience-only'],
      consoleLike,
      cwd: tempDir,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(consoleLike.errors, []);
    assert.deepEqual(consoleLike.logs, ['Presenter mode is not enabled in this config.']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runPresenterDoctor reports missing presenter dependencies clearly', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-doctor-presenter-'));
  const consoleLike = createConsoleLike();

  try {
    await writePresentationConfig(tempDir, 'demo', {
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      hotkeys: { next: 'F13', prev: 'F14' },
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
          Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' },
        },
        stt: {
          whisperBin: '/missing/whisper-cli',
          model: '/missing/model.bin',
          chunkSeconds: 2.5,
        },
      },
    });

    const exitCode = await runPresenterDoctor({
      accessFn: async () => {
        throw new Error('not found');
      },
      args: ['demo'],
      commandExistsFn: async () => false,
      consoleLike,
      cwd: tempDir,
      platform: 'darwin',
    });

    assert.equal(exitCode, 1);
    assert.ok(consoleLike.logs.some((line) => /Presenter mode enabled/i.test(line)));
    assert.ok(consoleLike.errors.some((line) => /ffmpeg was not found on PATH/i.test(line)));
    assert.ok(consoleLike.errors.some((line) => /whisperBin path is not accessible/i.test(line)));
    assert.ok(consoleLike.errors.some((line) => /model path is not accessible/i.test(line)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
