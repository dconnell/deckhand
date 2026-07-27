import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRevealPositionChangedMessage,
  deriveRevealSlideId,
  findDuplicateDeckhandIds,
  resolveRevealGoTo,
  validateRevealCommand,
} from '../../src/drivers/revealjs.js';

test('deriveRevealSlideId uses data-deckhand-id when present', () => {
  assert.deepEqual(
    deriveRevealSlideId({
      currentSlide: { dataset: { deckhandId: 'demo-step-1' } },
      indexh: 2,
      indexv: 1,
    }),
    {
      id: 'demo-step-1',
      idSource: 'data-deckhand-id',
      indexh: 2,
      indexv: 1,
    },
  );
});

test('deriveRevealSlideId falls back to indexh.indexv when no explicit id exists', () => {
  assert.deepEqual(
    deriveRevealSlideId({ currentSlide: { dataset: {} }, indexh: 4 }),
    {
      id: '4.0',
      idSource: 'index',
      indexh: 4,
      indexv: 0,
    },
  );
});

test('buildRevealPositionChangedMessage includes raw indices in meta', () => {
  assert.deepEqual(
    buildRevealPositionChangedMessage({
      currentSlide: { dataset: { deckhandId: 'intro' } },
      indexh: 0,
      indexv: 0,
    }),
    {
      type: 'positionChanged',
      position: {
        id: 'intro',
        index: { h: 0, v: 0 },
        meta: { idSource: 'data-deckhand-id', indexh: 0, indexv: 0 },
      },
    },
  );
});

test('findDuplicateDeckhandIds reports ambiguous slide ids', () => {
  assert.deepEqual(
    findDuplicateDeckhandIds([
      { dataset: { deckhandId: 'intro' } },
      { dataset: { deckhandId: 'intro' } },
      { dataset: { deckhandId: 'demo' } },
    ]),
    ['intro'],
  );
});

test('resolveRevealGoTo finds explicit deckhand ids first', () => {
  assert.deepEqual(
    resolveRevealGoTo('demo-step-2', [
      { dataset: { deckhandId: 'intro' }, indexh: 0, indexv: 0 },
      { dataset: { deckhandId: 'demo-step-2' }, indexh: 5, indexv: 2 },
    ]),
    { indexh: 5, indexv: 2 },
  );
});

test('resolveRevealGoTo accepts h.v fallback ids', () => {
  assert.deepEqual(resolveRevealGoTo('3.1', []), { indexh: 3, indexv: 1 });
});

test('validateRevealCommand requires goTo ids', () => {
  assert.throws(() => validateRevealCommand({ type: 'goTo' }), /id/i);
});

test('validateRevealCommand accepts next prev and goTo commands', () => {
  assert.deepEqual(validateRevealCommand({ type: 'next' }), { type: 'next' });
  assert.deepEqual(validateRevealCommand({ type: 'prev' }), { type: 'prev' });
  assert.deepEqual(validateRevealCommand({ type: 'goTo', id: 'intro' }), { type: 'goTo', id: 'intro' });
});
