import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWhisperOutput } from '../../../../src/presenter/stt/parseWhisperOutput.js';

test('parseWhisperOutput extracts transcript text from whisper stdout', () => {
  assert.equal(parseWhisperOutput('[00:00:00.000 --> 00:00:02.500]  Walk through the init flow.\n'), 'Walk through the init flow.');
});

test('parseWhisperOutput joins multiple transcript lines and trims empties', () => {
  assert.equal(
    parseWhisperOutput('[00:00:00.000 --> 00:00:02.500]  Walk through the init flow.\n[00:00:02.500 --> 00:00:04.000]  Emphasize line 42.\n'),
    'Walk through the init flow. Emphasize line 42.',
  );
});

test('parseWhisperOutput returns an empty string for blank output', () => {
  assert.equal(parseWhisperOutput('\n  \n'), '');
});
