import assert from 'node:assert/strict';
import test from 'node:test';

import { matchLine, matchLineDetailed } from '../../../src/presenter/matchLine.js';

test('matchLine stays on the current line when it partially matches and no next-line evidence exists', () => {
  assert.equal(
    matchLine('walk through the init flow', [
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

test('matchLine steps over command-only meta lines and can never land on them', () => {
  assert.equal(matchLine('outro line', [
    { tokens: [{ kind: 'text', text: 'Intro line.' }], spokenText: 'Intro line.', paragraphIndex: 0 },
    { tokens: [{ kind: 'command', text: 'dce status' }], spokenText: '', paragraphIndex: 1 },
    { tokens: [{ kind: 'text', text: 'Outro line.' }], spokenText: 'Outro line.', paragraphIndex: 1 },
  ], 0), 2);
});

test('matchLine keeps the nearest exact tie instead of jumping to a later duplicate line', () => {
  assert.equal(matchLine('repeat this exactly', [
    'Repeat this exactly.',
    'Bridge line.',
    'Repeat this exactly.',
  ], 0), 0);
});

test('matchLine can advance one line early when a long current line is mostly consumed and the next short line has real prefix evidence', () => {
  assert.equal(matchLine('this section walks slowly through the coordinator state initialization before the handoff happens then demo', [
    'Intro line.',
    'This section walks slowly through the coordinator state initialization before the handoff happens.',
    'Then demo the app.',
  ], 1), 2);
});

test('matchLine still holds position when only one next-line word appears after a long current line', () => {
  assert.equal(matchLine('this section walks slowly through the coordinator state initialization before the handoff happens then', [
    'Intro line.',
    'This section walks slowly through the coordinator state initialization before the handoff happens.',
    'Then demo the app.',
  ], 1), 1);
});

test('matchLine can advance when next-line evidence is slightly imperfect but still distinct', () => {
  assert.equal(matchLine('today we will talk through the live demo setup before handoff demo starts now', [
    'Intro line.',
    'Today we will talk through the live demo setup before the handoff to the short call to action.',
    'Demo starts now.',
  ], 1), 2);
});

test('matchLine can hand off after two distinct next-line words when the next line is five words long', () => {
  assert.equal(matchLine('we need to carefully describe the initialization details before the transition into the operator handoff and final checklist for the live demo now please', [
    'Intro line.',
    'We need to carefully describe the initialization details before the transition into the operator handoff and final checklist for the live demo.',
    'Now please open dashboard view.',
  ], 1), 2);
});

test('matchLine does not early-advance when the next line text is already embedded in the current line', () => {
  assert.equal(matchLine('this section is long and then we will carefully go now', [
    'Intro.',
    'This section is long and then we will carefully go now.',
    'We will go now.',
  ], 1), 1);
});

test('matchLine still requires more prefix evidence once the next line grows beyond the short-line band', () => {
  assert.equal(matchLine('we need to carefully describe the initialization details before the transition into the operator handoff and final checklist for the live demo now please', [
    'Intro line.',
    'We need to carefully describe the initialization details before the transition into the operator handoff and final checklist for the live demo.',
    'Now please open the dashboard view today.',
  ], 1), 1);
});

test('matchLine advances when the current line is well-covered and two distinct next-line words appear at the tail', () => {
  assert.equal(matchLine('the quick brown fox jumps over the lazy dog now is the', [
    'The quick brown fox jumps over the lazy dog.',
    'Now is the time for all good men.',
  ], 0), 1);
});

test('matchLine does not advance when the current line is well-covered but no next-line words have appeared', () => {
  assert.equal(matchLine('the quick brown fox jumps over the lazy dog', [
    'The quick brown fox jumps over the lazy dog.',
    'Now is the time for all good men.',
  ], 0), 0);
});

test('matchLine anchors on distinctive words instead of ubiquitous filler that inflates earlier lines', () => {
  // 'the' and 'and' appear in the first two lines only, so they get discounted.
  // The speaker has moved on to line 2, but the rolling window still holds the
  // previous line's common words. Bag-of-words F1 keeps score-anchored on line 1
  // ('the database and the cache server' minus 'server'); TF-IDF weighting lets the
  // distinctive line-2 words dominate and the tail tie-break resolves to line 2.
  assert.equal(matchLine('the database and the cache quantum entanglement fields', [
    'The system and the network.',
    'The database and the cache server.',
    'Quantum entanglement fields.',
  ], 0), 2);
});

test('matchLineDetailed weights unmatched distinctive words so common-word-only matches stay below threshold', () => {
  const result = matchLineDetailed('the', [
    'Quantum the.',
    'Classical the.',
  ], 0);

  assert.equal(result.index, 0);
  assert.ok(result.confidence < 0.35, `expected confidence below 0.35, got ${result.confidence}`);
});
