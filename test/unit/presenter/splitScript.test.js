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

test('splitScript preserves [cmd:] markers verbatim as command meta lines with no spoken text', () => {
  assert.deepEqual(splitScript([
    '[mode:DEMO]',
    'Intro line.',
    '',
    '[cmd:dce new live  nodejs 3200:3000]',
    '[CMD:cat ~/.is-even-cache]',
    '',
    'Outro line.',
  ].join('\n')), [
    {
      tokens: [{ kind: 'mode', text: 'DEMO' }],
      spokenText: '',
      paragraphIndex: 0,
      mode: 'DEMO',
    },
    {
      tokens: [{ kind: 'text', text: 'Intro line.' }],
      spokenText: 'Intro line.',
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
      tokens: [{ kind: 'command', text: 'dce new live  nodejs 3200:3000' }],
      spokenText: '',
      paragraphIndex: 1,
      mode: 'DEMO',
    },
    {
      tokens: [{ kind: 'command', text: 'cat ~/.is-even-cache' }],
      spokenText: '',
      paragraphIndex: 1,
      mode: 'DEMO',
    },
    {
      tokens: [{ kind: 'gap' }],
      spokenText: '',
      paragraphIndex: 1,
      mode: 'DEMO',
    },
    {
      tokens: [{ kind: 'text', text: 'Outro line.' }],
      spokenText: 'Outro line.',
      paragraphIndex: 1,
      mode: 'DEMO',
    },
  ]);
});

test('splitScript keeps command text on one line with punctuation and whitespace intact', () => {
  assert.deepEqual(splitScript('[cmd:npm install --foreground-scripts ./pkg.tgz]'), [
    {
      tokens: [{ kind: 'command', text: 'npm install --foreground-scripts ./pkg.tgz' }],
      spokenText: '',
      paragraphIndex: 0,
    },
  ]);
});

test('splitScript treats whitespace-only meta markers as bare tokens and never emits empty text or mode', () => {
  const lines = splitScript([
    '[mode: ]',
    '[stage:  ]',
    'Spoken intro.',
    '[cmd: ]',
    'More spoken.',
  ].join('\n'));

  assert.deepEqual(lines[0].tokens, [{ kind: 'mode' }]);
  assert.deepEqual(lines[1].tokens, [{ kind: 'stage' }]);
  assert.deepEqual(lines[3].tokens, [{ kind: 'command' }]);
  assert.equal(lines[0].spokenText, '');
  assert.equal(lines[1].spokenText, '');
  assert.equal(lines[3].spokenText, '');

  // Protocol invariant: no token carries text: '' and no line carries mode: ''.
  for (const line of lines) {
    for (const token of line.tokens) {
      assert.notEqual(token.text, '');
    }
    assert.notEqual(line.mode, '');
  }

  // The empty mode marker must not set a mode on any line.
  for (const line of lines) {
    assert.equal(line.mode, undefined);
  }
});

test('splitScript keeps the previous mode when an empty [mode: ] marker follows one', () => {
  const lines = splitScript([
    '[mode:DEMO]',
    '[mode: ]',
    'Still presenting.',
  ].join('\n'));

  assert.deepEqual(lines[0].tokens, [{ kind: 'mode', text: 'DEMO' }]);
  assert.deepEqual(lines[1].tokens, [{ kind: 'mode' }]);
  assert.deepEqual(lines[2], {
    tokens: [{ kind: 'text', text: 'Still presenting.' }],
    spokenText: 'Still presenting.',
    paragraphIndex: 0,
    mode: 'DEMO',
  });
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
