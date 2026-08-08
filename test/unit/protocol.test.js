import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDriverAdapterContract,
  createCommandMessage,
  createErrorMessage,
  createPresentationStateMessage,
  createRegisteredMessage,
  createTranscriptMessage,
  validateClientMessage,
} from '../../src/protocol.js';

test('createRegisteredMessage includes observer subscriptions', () => {
  assert.deepEqual(createRegisteredMessage({
    role: 'observer',
    sessionId: 'observer-1',
    subscriptions: ['presentationState', 'transcript'],
  }), {
    type: 'registered',
    role: 'observer',
    sessionId: 'observer-1',
    subscriptions: ['presentationState', 'transcript'],
  });
});

test('createCommandMessage wraps the command payload generically', () => {
  assert.deepEqual(createCommandMessage({ type: 'navigate', url: 'https://example.com' }), {
    type: 'command',
    command: { type: 'navigate', url: 'https://example.com' },
  });
});

test('createPresentationStateMessage wraps a resolved state payload', () => {
  assert.deepEqual(createPresentationStateMessage({
    type: 'presentationState',
    seq: 17,
    slideId: 'intro',
    layoutId: 'full-slide',
    audienceScene: 'Full Slide',
    slots: [],
    managedWindowBindings: {
      Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Example Deck' },
    },
    overlays: [{ source: 'Presenter', hidden: true }],
    focus: null,
    script: null,
    commands: [],
  }), {
    type: 'presentationState',
    seq: 17,
    slideId: 'intro',
    layoutId: 'full-slide',
    audienceScene: 'Full Slide',
    slots: [],
    managedWindowBindings: {
      Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Example Deck' },
    },
    overlays: [{ source: 'Presenter', hidden: true }],
    focus: null,
    script: null,
  });
});

test('createTranscriptMessage normalizes transcript payloads', () => {
  assert.deepEqual(createTranscriptMessage({
    source: 'whisper',
    text: 'hello world',
    capturedAtMs: 1720000000000,
  }), {
    type: 'transcript',
    source: 'whisper',
    text: 'hello world',
    capturedAtMs: 1720000000000,
  });
});

test('createErrorMessage includes the protocol error code', () => {
  assert.deepEqual(createErrorMessage('invalid_message', 'Bad message'), {
    type: 'error',
    code: 'invalid_message',
    message: 'Bad message',
  });
});

test('validateClientMessage accepts driver registration messages', () => {
  assert.deepEqual(
    validateClientMessage({ type: 'register', role: 'driver', capabilities: ['next', 'prev'] }),
    { type: 'register', role: 'driver', capabilities: ['next', 'prev'] },
  );
});

test('validateClientMessage accepts observer registrations with subscriptions', () => {
  assert.deepEqual(
    validateClientMessage({
      type: 'register',
      role: 'observer',
      subscriptions: ['presentationState', 'transcript', 'presentationState'],
    }),
    {
      type: 'register',
      role: 'observer',
      subscriptions: ['presentationState', 'transcript'],
      capabilities: [],
    },
  );
});

test('validateClientMessage accepts position events with normalized shape', () => {
  assert.deepEqual(
    validateClientMessage({
      type: 'positionChanged',
      position: {
        id: 'intro',
        index: { h: 0, v: 0 },
        meta: { indexh: 0, indexv: 0 },
      },
    }),
    {
      type: 'positionChanged',
      position: {
        id: 'intro',
        index: { h: 0, v: 0 },
        meta: { indexh: 0, indexv: 0 },
      },
    },
  );
});

test('validateClientMessage accepts transcript events from observers', () => {
  assert.deepEqual(
    validateClientMessage({
      type: 'transcript',
      source: 'whisper',
      text: 'hello world',
      capturedAtMs: 1720000000000,
    }),
    {
      type: 'transcript',
      source: 'whisper',
      text: 'hello world',
      capturedAtMs: 1720000000000,
    },
  );
});

test('validateClientMessage accepts observer driverCommand messages', () => {
  assert.deepEqual(
    validateClientMessage({
      type: 'driverCommand',
      command: { type: 'next' },
    }),
    {
      type: 'driverCommand',
      command: { type: 'next' },
    },
  );
});

test('validateClientMessage accepts observer window binding updates', () => {
  assert.deepEqual(
    validateClientMessage({
      type: 'windowBindings',
      bindings: {
        BrowserA: {
          app: 'Google Chrome',
          pid: 47213,
          macWindowId: 12345,
          strict: true,
        },
      },
      cleared: ['BrowserB'],
    }),
    {
      type: 'windowBindings',
      bindings: {
        BrowserA: {
          app: 'Google Chrome',
          pid: 47213,
          macWindowId: 12345,
          strict: true,
        },
      },
      cleared: ['BrowserB'],
    },
  );
});

test('validateClientMessage accepts observer window-settled acks', () => {
  assert.deepEqual(
    validateClientMessage({ type: 'windowSettled', seq: 7 }),
    { type: 'windowSettled', seq: 7 },
  );
});

test('validateClientMessage accepts driver position-settled acks', () => {
  assert.deepEqual(
    validateClientMessage({ type: 'positionSettled', eventId: 7 }),
    { type: 'positionSettled', eventId: 7 },
  );
});

test('validateClientMessage rejects window-settled acks without a positive seq', () => {
  assert.throws(() => validateClientMessage({ type: 'windowSettled' }), /seq/i);
  assert.throws(() => validateClientMessage({ type: 'windowSettled', seq: 0 }), /seq/i);
});

test('validateClientMessage rejects position-settled acks without a positive eventId', () => {
  assert.throws(() => validateClientMessage({ type: 'positionSettled' }), /eventId/i);
  assert.throws(() => validateClientMessage({ type: 'positionSettled', eventId: 0 }), /eventId/i);
});

test('validateClientMessage rejects observer subscriptions with unknown message types', () => {
  assert.throws(
    () => validateClientMessage({ type: 'register', role: 'observer', subscriptions: ['unknown'] }),
    /subscriptions/i,
  );
});

test('validateClientMessage rejects target registrations now that the role is removed', () => {
  assert.throws(
    () => validateClientMessage({ type: 'register', role: 'target', controllerId: 'demo1' }),
    /role must be either "driver" or "observer"/i,
  );
});

test('assertDriverAdapterContract rejects malformed descriptors', () => {
  assert.throws(() => assertDriverAdapterContract({ name: 'broken', kind: 'driver' }), /capabilities/i);
});
