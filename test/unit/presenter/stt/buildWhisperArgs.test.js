import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWhisperArgs } from '../../../../src/presenter/stt/buildWhisperArgs.js';

test('buildWhisperArgs creates whisper CLI arguments from config', () => {
  assert.deepEqual(buildWhisperArgs({
    audioPath: '/tmp/chunk.wav',
    language: 'en',
    model: '/models/ggml-base.en.bin',
  }), [
    '-m', '/models/ggml-base.en.bin',
    '-f', '/tmp/chunk.wav',
    '-l', 'en',
    '-nt',
    '-np',
  ]);
});

test('buildWhisperArgs omits language when not configured', () => {
  assert.deepEqual(buildWhisperArgs({
    audioPath: '/tmp/chunk.wav',
    language: undefined,
    model: '/models/ggml-base.en.bin',
  }), [
    '-m', '/models/ggml-base.en.bin',
    '-f', '/tmp/chunk.wav',
    '-nt',
    '-np',
  ]);
});
