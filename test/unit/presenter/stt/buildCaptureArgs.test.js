import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCaptureArgs } from '../../../../src/presenter/stt/buildCaptureArgs.js';

test('buildCaptureArgs creates ffmpeg avfoundation capture arguments', () => {
  assert.deepEqual(buildCaptureArgs({
    chunkSeconds: 2.5,
    inputDevice: ':0',
    outputPath: '/tmp/chunk.wav',
  }), [
    '-f', 'avfoundation',
    '-i', ':0',
    '-t', '2.5',
    '-y',
    '/tmp/chunk.wav',
  ]);
});
