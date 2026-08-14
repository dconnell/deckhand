import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { loadResumableSlide, persistSlideId } from '../../../src/recovery/slideResume.js';

test('persistSlideId and loadResumableSlide round-trip the active slide id', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-slide-resume-'));
  const statePath = path.join(tempDir, '.deckhand-state.json');

  try {
    await persistSlideId({
      statePath,
      slideId: 'code-walkthrough',
      index: { h: 3, v: 0 },
      nowMs: 1700000000000,
    });

    assert.deepEqual(await loadResumableSlide({ statePath }), {
      slideId: 'code-walkthrough',
      index: { h: 3, v: 0 },
      savedAtMs: 1700000000000,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadResumableSlide returns null when no state file exists', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-slide-resume-missing-'));
  const statePath = path.join(tempDir, '.deckhand-state.json');

  try {
    assert.equal(await loadResumableSlide({ statePath }), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadResumableSlide returns null for a malformed state file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-slide-resume-malformed-'));
  const statePath = path.join(tempDir, '.deckhand-state.json');

  try {
    await writeFile(statePath, '{ not valid json', 'utf8');
    assert.equal(await loadResumableSlide({ statePath }), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadResumableSlide returns null when the payload lacks a slide id', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-slide-resume-no-id-'));
  const statePath = path.join(tempDir, '.deckhand-state.json');

  try {
    await writeFile(statePath, JSON.stringify({ index: { h: 1, v: 0 } }), 'utf8');
    assert.equal(await loadResumableSlide({ statePath }), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('persistSlideId writes atomically so no partial state file is left on a failing rename', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-slide-resume-atomic-'));
  const statePath = path.join(tempDir, 'nested', '.deckhand-state.json');

  try {
    await assert.rejects(
      persistSlideId({ statePath, slideId: 'intro', index: { h: 0, v: 0 }, nowMs: 1 }),
      /ENOENT|rename/i,
    );
    assert.equal(await loadResumableSlide({ statePath }), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
