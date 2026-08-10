import assert from 'node:assert/strict';
import test from 'node:test';

import { matchLine } from '../../../src/presenter/matchLine.js';

test('matchLine advances on partial forward matches', () => {
  assert.equal(
    matchLine('walk through the init flow emphasize line', [
      'Welcome to the talk.',
      'Walk through the init flow.',
      'Emphasize line 42.',
    ], 1),
    1,
  );
});

test('matchLine stays put below threshold', () => {
  assert.equal(matchLine('unrelated phrase', ['One line', 'Two line'], 1), 1);
});

test('matchLine ignores earlier lines and never moves backward', () => {
  assert.equal(matchLine('welcome to the talk', ['Welcome to the talk.', 'Current line'], 1), 1);
});

test('matchLine uses structured spokenText and ignores non-spoken annotations', () => {
  assert.equal(matchLine('answer questions now', [
    { spokenText: '' },
    { spokenText: 'Show the important bit now.' },
    { spokenText: '' },
    { spokenText: 'Answer questions now.' },
  ], 1), 3);
});
