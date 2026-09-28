import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampToSpokenLine,
  findFirstSpokenLine,
  findParagraphJumpTarget,
  moveBySpokenLines,
} from '../../../src/presenter/navigation.js';

const lines = [
  { spokenText: 'One', paragraphIndex: 0 },
  { spokenText: 'Two', paragraphIndex: 0 },
  { spokenText: 'Three', paragraphIndex: 1 },
  { spokenText: 'Four', paragraphIndex: 1 },
  { spokenText: '', paragraphIndex: 2 },
  { spokenText: 'Five', paragraphIndex: 3 },
];

test('findFirstSpokenLine lands on the first line with spoken text', () => {
  assert.equal(findFirstSpokenLine(lines), 0);
  assert.equal(
    findFirstSpokenLine([{ spokenText: '' }, { spokenText: '  ' }, { spokenText: 'Later' }]),
    2,
  );
  assert.equal(findFirstSpokenLine([]), 0);
});

test('clampToSpokenLine snaps non-spoken lines back to the nearest spoken line', () => {
  assert.equal(clampToSpokenLine(lines, 3), 3);
  // Non-spoken line falls back to the previous spoken line.
  assert.equal(clampToSpokenLine(lines, 4), 3);
  // Nothing spoken before the index, so search forward.
  assert.equal(clampToSpokenLine([{ spokenText: '' }, { spokenText: 'Next' }], 0), 1);
  // Empty scripts clamp to the first line.
  assert.equal(clampToSpokenLine([], 2), 0);
});

test('moveBySpokenLines skips non-spoken lines and clamps at both ends', () => {
  assert.equal(moveBySpokenLines(lines, 0, 1), 1);
  // Steps over the non-spoken line at index 4.
  assert.equal(moveBySpokenLines(lines, 3, 1), 5);
  assert.equal(moveBySpokenLines(lines, 5, -1), 3);
  assert.equal(moveBySpokenLines(lines, 5, 1), 5);
  assert.equal(moveBySpokenLines([{ spokenText: '' }], 0, 1), 0);
});

test('findParagraphJumpTarget skips non-spoken lines and moves by paragraph groups', () => {
  assert.equal(findParagraphJumpTarget(lines, 1, 1), 2);
  assert.equal(findParagraphJumpTarget(lines, 2, -1), 0);
  assert.equal(findParagraphJumpTarget(lines, 2, 2), 5);
});
