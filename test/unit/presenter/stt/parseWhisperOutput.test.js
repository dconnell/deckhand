import assert from 'node:assert/strict';
import test from 'node:test';

import { createWhisperOutputParser } from '../../../../src/presenter/stt/parseWhisperOutput.js';

function createNowFn(values) {
  const queue = [...values];

  return () => queue.shift() ?? values.at(-1) ?? 0;
}

test('stepped parser ignores startup noise and emits normalized transcripts from CR updates', () => {
  const parser = createWhisperOutputParser({
    mode: 'step',
    nowFn: createNowFn([100, 200]),
  });

  assert.deepEqual(parser.push('whisper_init_state: loading model\n[Start speaking]\n'), []);
  assert.deepEqual(parser.push('\u001b[2K\r hello'), []);
  assert.deepEqual(parser.push(' world\u001b[2K\rhello world!'), [
    { kind: 'partial', observedAtMs: 100, text: 'hello world' },
  ]);
  assert.deepEqual(parser.flush(), [
    { kind: 'partial', observedAtMs: 200, text: 'hello world!' },
  ]);
});

test('stepped parser suppresses exact and whitespace-only churn', () => {
  const parser = createWhisperOutputParser({
    mode: 'step',
    nowFn: createNowFn([300]),
  });

  assert.deepEqual(parser.push('\u001b[2K\rstatus report\rstatus report\rstatus   report  '), [
    { kind: 'partial', observedAtMs: 300, text: 'status report' },
  ]);
  assert.deepEqual(parser.flush(), []);
});

test('stepped parser preserves transcripts that contain diagnostic-looking words', () => {
  const parser = createWhisperOutputParser({
    mode: 'step',
    nowFn: createNowFn([400]),
  });

  assert.deepEqual(parser.push('\u001b[2K\rWarning: check the samples for threads.\n'), [
    { kind: 'partial', observedAtMs: 400, text: 'Warning: check the samples for threads.' },
  ]);
});

test('vad parser emits one transcript per completed transcription block', () => {
  const parser = createWhisperOutputParser({
    mode: 'vad',
    nowFn: createNowFn([500]),
  });

  assert.deepEqual(parser.push('### Transcription 0 START | t0 = 0 ms | t1 = 2000 ms\n\n'), []);
  assert.deepEqual(parser.push('[00:00:00.000 --> 00:00:01.000]  Walk through\n'), []);
  assert.deepEqual(parser.push('[00:00:01.000 --> 00:00:02.000]  the init flow.\n\n'), []);
  assert.deepEqual(parser.push('### Transcription 0 END\n'), [
    { kind: 'segment', observedAtMs: 500, text: 'Walk through the init flow.' },
  ]);
});

test('vad parser ignores banners and dedupes repeated completed blocks', () => {
  const parser = createWhisperOutputParser({
    mode: 'vad',
    nowFn: createNowFn([600]),
  });

  assert.deepEqual(parser.push('[Start speaking]\n'), []);
  assert.deepEqual(parser.push('### Transcription 0 START | t0 = 0 ms | t1 = 2000 ms\n'), []);
  assert.deepEqual(parser.push('[00:00:00.000 --> 00:00:02.000]  Retry worked.\n'), []);
  assert.deepEqual(parser.push('### Transcription 0 END\n'), [
    { kind: 'segment', observedAtMs: 600, text: 'Retry worked.' },
  ]);
  assert.deepEqual(parser.push('### Transcription 1 START | t0 = 0 ms | t1 = 2000 ms\n'), []);
  assert.deepEqual(parser.push('[00:00:00.000 --> 00:00:02.000]  Retry worked.\n'), []);
  assert.deepEqual(parser.push('### Transcription 1 END\n'), []);
});

test('vad parser does not confuse transcript text containing START or END with block banners', () => {
  const parser = createWhisperOutputParser({
    mode: 'vad',
    nowFn: createNowFn([700]),
  });

  assert.deepEqual(parser.push('### Transcription 0 START | t0 = 0 ms | t1 = 2000 ms\n'), []);
  assert.deepEqual(parser.push('[00:00:00.000 --> 00:00:02.000]  Do not END the talk; START the demo.\n'), []);
  assert.deepEqual(parser.push('### Transcription 0 END\n'), [
    { kind: 'segment', observedAtMs: 700, text: 'Do not END the talk; START the demo.' },
  ]);
});
