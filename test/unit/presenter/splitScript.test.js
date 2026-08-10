import assert from 'node:assert/strict';
import test from 'node:test';

import { splitScript } from '../../../src/presenter/splitScript.js';

test('splitScript returns an empty list for nullish or blank scripts', () => {
  assert.deepEqual(splitScript(null), []);
  assert.deepEqual(splitScript(undefined), []);
  assert.deepEqual(splitScript('   \n  '), []);
});

test('splitScript splits on newlines first and trims empties', () => {
  assert.deepEqual(splitScript(' One line \n\n Two line ').map((line) => line.spokenText), [
    'One line',
    '',
    'Two line',
  ]);
});

test('splitScript splits long segments on sentence boundaries', () => {
  assert.deepEqual(splitScript('First sentence. Second sentence? Third sentence!').map((line) => line.spokenText), [
    'First sentence.',
    'Second sentence?',
    'Third sentence!',
  ]);
});

test('splitScript preserves explicit stage, mode, pause, and emphasis markers as structured tokens', () => {
  assert.deepEqual(splitScript([
    '[mode:DEMO]',
    '[stage: look left]',
    'Show the *important* bit ... now.',
    '',
    '[mode:QA]',
    'Answer questions.',
  ].join('\n')), [
    {
      tokens: [{ kind: 'mode', text: 'DEMO' }],
      spokenText: '',
      paragraphIndex: 0,
      mode: 'DEMO',
    },
    {
      tokens: [{ kind: 'stage', text: 'look left' }],
      spokenText: '',
      paragraphIndex: 0,
      mode: 'DEMO',
    },
    {
      tokens: [
        { kind: 'text', text: 'Show the' },
        { kind: 'emphasis', text: 'important' },
        { kind: 'text', text: 'bit' },
        { kind: 'pause', text: '...' },
      ],
      spokenText: 'Show the important bit',
      paragraphIndex: 0,
      mode: 'DEMO',
    },
    {
      tokens: [
        { kind: 'text', text: 'now.' },
      ],
      spokenText: 'now.',
      paragraphIndex: 0,
      mode: 'DEMO',
    },
    {
      tokens: [{ kind: 'gap' }],
      spokenText: '',
      paragraphIndex: 1,
      mode: 'DEMO',
    },
    {
      tokens: [{ kind: 'mode', text: 'QA' }],
      spokenText: '',
      paragraphIndex: 1,
      mode: 'QA',
    },
    {
      tokens: [{ kind: 'text', text: 'Answer questions.' }],
      spokenText: 'Answer questions.',
      paragraphIndex: 1,
      mode: 'QA',
    },
  ]);
});
