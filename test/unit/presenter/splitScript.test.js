import assert from 'node:assert/strict';
import test from 'node:test';

import { splitScript } from '../../../presenter-web/lib/splitScript.js';

test('splitScript returns an empty list for nullish or blank scripts', () => {
  assert.deepEqual(splitScript(null), []);
  assert.deepEqual(splitScript(undefined), []);
  assert.deepEqual(splitScript('   \n  '), []);
});

test('splitScript splits on newlines first and trims empties', () => {
  assert.deepEqual(splitScript(' One line \n\n Two line '), [
    'One line',
    'Two line',
  ]);
});

test('splitScript splits long segments on sentence boundaries', () => {
  assert.deepEqual(splitScript('First sentence. Second sentence? Third sentence!'), [
    'First sentence.',
    'Second sentence?',
    'Third sentence!',
  ]);
});
