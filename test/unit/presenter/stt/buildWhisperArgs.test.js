import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWhisperArgs } from '../../../../src/presenter/stt/buildWhisperArgs.js';

test('buildWhisperArgs maps normalized stepped config to whisper-stream arguments', () => {
  assert.deepEqual(buildWhisperArgs({
    audioCtx: 768,
    beamSize: 3,
    captureId: ':0',
    flashAttn: false,
    keepContext: true,
    keepMs: 250,
    language: 'en',
    lengthMs: 5000,
    model: '/models/ggml-base.en.bin',
    noFallback: true,
    stepMs: 500,
    threads: 6,
    useGpu: false,
  }), [
    '-m', '/models/ggml-base.en.bin',
    '--capture', '0',
    '--step', '500',
    '--length', '5000',
    '--keep', '250',
    '-l', 'en',
    '-t', '6',
    '--audio-ctx', '768',
    '--beam-size', '3',
    '--keep-context',
    '--no-fallback',
    '--no-gpu',
    '--no-flash-attn',
  ]);
});

test('buildWhisperArgs creates VAD whisper-stream arguments when configured', () => {
  assert.deepEqual(buildWhisperArgs({
    audioCtx: 512,
    beamSize: 5,
    captureId: 2,
    freqThreshold: 120,
    lengthMs: 30000,
    mode: 'vad',
    model: '/models/ggml-base.en.bin',
    vadThreshold: 0.6,
  }), [
    '-m', '/models/ggml-base.en.bin',
    '--capture', '2',
    '--step', '0',
    '--length', '30000',
    '-vth', '0.6',
    '-fth', '120',
    '--audio-ctx', '512',
    '--beam-size', '5',
  ]);
});
