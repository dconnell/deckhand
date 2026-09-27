import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDriverAdapterContract,
  createCommandMessage,
  createErrorMessage,
  createPresentationStateMessage,
  createPresenterStateMessage,
  createRegisteredMessage,
  createTranscriptMessage,
  validateClientMessage,
} from '../../src/protocol.js';

test('createRegisteredMessage includes observer subscriptions', () => {
  assert.deepEqual(createRegisteredMessage({
    role: 'observer',
    sessionId: 'observer-1',
    subscriptions: ['presentationState', 'presenterState', 'transcript'],
  }), {
    type: 'registered',
    role: 'observer',
    sessionId: 'observer-1',
    subscriptions: ['presentationState', 'presenterState', 'transcript'],
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

test('createPresenterStateMessage wraps a resolved presenter state payload', () => {
  assert.deepEqual(createPresenterStateMessage({
    type: 'presenterState',
    seq: 9,
    presentationSeq: 7,
    current: {
      slideId: 'intro',
      layoutId: 'full-slide',
      focus: null,
      hidden: false,
      lines: [],
    },
    next: null,
    teleprompter: {
      followEnabled: true,
      activeLineIndex: 0,
      trackingState: 'idle',
      recentTranscript: [],
    },
    timer: {
      running: false,
      elapsedMs: 0,
      remainingMs: null,
      targetDurationMs: null,
    },
    obs: {
      preview: {
        available: false,
        path: '/presenter/program.jpg',
        revision: 0,
        capturedAtMs: null,
        stale: true,
      },
    },
    stream: {
      active: false,
      reconnecting: false,
      bitrateKbps: null,
      droppedFrames: 0,
      congestion: null,
      lastUpdateMs: null,
      warning: 'disconnected',
    },
    updatedAtMs: 1720000000000,
  }).type, 'presenterState');
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
      subscriptions: ['presentationState', 'presenterState', 'transcript', 'presentationState'],
    }),
    {
      type: 'register',
      role: 'observer',
      subscriptions: ['presentationState', 'presenterState', 'transcript'],
      capabilities: [],
    },
  );
});

test('validateClientMessage accepts observer presenterCommand messages', () => {
  assert.deepEqual(
    validateClientMessage({
      type: 'presenterCommand',
      op: 'nudge',
      source: 'teleprompter',
      delta: 1,
    }),
    {
      type: 'presenterCommand',
      op: 'nudge',
      source: 'teleprompter',
      delta: 1,
    },
  );
});

test('validateClientMessage preserves the sourceId on a relaunchSource presenter command', () => {
  assert.deepEqual(
    validateClientMessage({
      type: 'presenterCommand',
      op: 'relaunchSource',
      source: 'console',
      sourceId: 'Terminal',
    }),
    {
      type: 'presenterCommand',
      op: 'relaunchSource',
      source: 'console',
      sourceId: 'Terminal',
    },
  );
});

test('validateClientMessage rejects a relaunchSource command with an empty sourceId', () => {
  assert.throws(
    () => validateClientMessage({
      type: 'presenterCommand',
      op: 'relaunchSource',
      source: 'console',
      sourceId: '  ',
    }),
    /sourceId/i,
  );
});

test('validateClientMessage accepts driver slideManifest messages', () => {
  assert.deepEqual(
    validateClientMessage({
      type: 'slideManifest',
      slides: [
        {
          id: 'intro',
          index: { h: 0, v: 0 },
          heading: 'Intro',
        },
      ],
    }),
    {
      type: 'slideManifest',
      slides: [
        {
          id: 'intro',
          index: { h: 0, v: 0 },
          heading: 'Intro',
        },
      ],
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

test('validateClientMessage accepts observer window-settled acks with frame mismatches', () => {
  const frameMismatches = [
    {
      source: 'Presenter',
      requested: { x: 0, y: 1120, w: 1800, h: 560 },
      observed: { x: 0, y: 900, w: 1800, h: 611 },
    },
  ];

  assert.deepEqual(
    validateClientMessage({ type: 'windowSettled', seq: 7, frameMismatches }),
    { type: 'windowSettled', seq: 7, frameMismatches },
  );
});

test('validateClientMessage rejects malformed window-settled frame mismatches', () => {
  const requested = { x: 0, y: 1120, w: 1800, h: 560 };
  const observed = { x: 0, y: 900, w: 1800, h: 611 };

  assert.throws(
    () => validateClientMessage({
      type: 'windowSettled',
      seq: 7,
      frameMismatches: [{ source: 'Presenter', requested: { x: 0, y: 1120, w: 1800 }, observed }],
    }),
    /requested\.h/i,
  );
  assert.throws(
    () => validateClientMessage({
      type: 'windowSettled',
      seq: 7,
      frameMismatches: [{ source: 'Presenter', requested, observed: { x: '0', y: 900, w: 1800, h: 611 } }],
    }),
    /observed\.x/i,
  );
  assert.throws(
    () => validateClientMessage({
      type: 'windowSettled',
      seq: 7,
      frameMismatches: [{ source: '  ', requested, observed }],
    }),
    /source/i,
  );
  assert.throws(
    () => validateClientMessage({ type: 'windowSettled', seq: 7, frameMismatches: 'nope' }),
    /frameMismatches/i,
  );
  assert.throws(
    () => validateClientMessage({ type: 'windowSettled', seq: 7, frameMismatches: [{}] }),
    /frameMismatches\[0\]/i,
  );
});

test('validateClientMessage accepts observer window-settled acks with a placement skip', () => {
  assert.deepEqual(
    validateClientMessage({
      type: 'windowSettled',
      seq: 7,
      placementSkipped: { reason: 'display-arrangement-mismatch' },
    }),
    { type: 'windowSettled', seq: 7, placementSkipped: { reason: 'display-arrangement-mismatch' } },
  );
});

test('validateClientMessage omits placementSkipped when the ack does not carry one', () => {
  const normalized = validateClientMessage({ type: 'windowSettled', seq: 7 });

  assert.equal(normalized.placementSkipped, undefined, 'absent placementSkipped stays undefined');
});

test('validateClientMessage rejects malformed window-settled placement skips', () => {
  assert.throws(
    () => validateClientMessage({ type: 'windowSettled', seq: 7, placementSkipped: {} }),
    /placementSkipped\.reason/i,
  );
  assert.throws(
    () => validateClientMessage({ type: 'windowSettled', seq: 7, placementSkipped: { reason: '  ' } }),
    /placementSkipped\.reason/i,
  );
  assert.throws(
    () => validateClientMessage({ type: 'windowSettled', seq: 7, placementSkipped: { reason: 42 } }),
    /placementSkipped\.reason/i,
  );
  assert.throws(
    () => validateClientMessage({ type: 'windowSettled', seq: 7, placementSkipped: 'nope' }),
    /placementSkipped must be an object/i,
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
