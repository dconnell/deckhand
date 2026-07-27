import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldPublishTranscript } from '../../../../src/presenter/stt/dedupeTranscript.js';

test('shouldPublishTranscript suppresses exact duplicate transcript text', () => {
  assert.equal(shouldPublishTranscript('Walk through the init flow.', 'Walk through the init flow.'), false);
});

test('shouldPublishTranscript allows new transcript text', () => {
  assert.equal(shouldPublishTranscript('Walk through the init flow.', 'Emphasize line 42.'), true);
});

test('shouldPublishTranscript suppresses blank parsed output', () => {
  assert.equal(shouldPublishTranscript('Previous', ''), false);
});
