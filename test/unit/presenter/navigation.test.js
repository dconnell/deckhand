import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignLineTiers,
  computeTeleprompterOffset,
  findParagraphJumpTarget,
} from '../../../src/presenter/navigation.js';

const lines = [
  { spokenText: 'One', paragraphIndex: 0 },
  { spokenText: 'Two', paragraphIndex: 0 },
  { spokenText: 'Three', paragraphIndex: 1 },
  { spokenText: 'Four', paragraphIndex: 1 },
  { spokenText: '', paragraphIndex: 2 },
  { spokenText: 'Five', paragraphIndex: 3 },
];

test('assignLineTiers marks past, current, near-future, and distant-future lines', () => {
  assert.deepEqual(assignLineTiers(lines, 2), [
    'past',
    'past',
    'current',
    'near',
    'future',
    'future',
  ]);
});

test('computeTeleprompterOffset anchors the active line 30 percent from the top', () => {
  assert.equal(computeTeleprompterOffset({
    activeLineTop: 360,
    activeLineHeight: 58,
    viewportHeight: 900,
    anchorRatio: 0.3,
  }), -119);
});

test('findParagraphJumpTarget skips non-spoken lines and moves by paragraph groups', () => {
  assert.equal(findParagraphJumpTarget(lines, 1, 1), 2);
  assert.equal(findParagraphJumpTarget(lines, 2, -1), 0);
  assert.equal(findParagraphJumpTarget(lines, 2, 2), 5);
});
