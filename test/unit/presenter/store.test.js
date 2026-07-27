import assert from 'node:assert/strict';
import test from 'node:test';

import { createPresenterStore } from '../../../presenter-web/lib/store.js';

function createState(seq, script = 'Walk through the init flow.\nEmphasize line 42.') {
  return {
    type: 'presentationState',
    seq,
    slideId: 'code-walkthrough',
    layoutId: 'left-terminal-right-slide',
    audienceScene: 'Left Terminal Right Slide',
    slots: [],
    focus: 'Terminal',
    script,
  };
}

function createTranscript(text, capturedAtMs = 1720000000000) {
  return {
    type: 'transcript',
    source: 'whisper',
    text,
    capturedAtMs,
  };
}

test('sticky presentationState bootstraps the teleprompter state', () => {
  const store = createPresenterStore({ followEnabledByDefault: true });

  store.beginConnection(1);
  store.applyPresentationState(createState(3), 1);

  assert.equal(store.getState().presentation.slideId, 'code-walkthrough');
  assert.deepEqual(store.getState().presentation.lines, [
    'Walk through the init flow.',
    'Emphasize line 42.',
  ]);
});

test('scriptless slides clear stale script and transcript state', () => {
  const store = createPresenterStore({ followEnabledByDefault: true });

  store.beginConnection(1);
  store.applyPresentationState(createState(3), 1);
  store.applyTranscript(createTranscript('walk through'), 1);
  store.applyPresentationState(createState(4, null), 1);

  assert.deepEqual(store.getState().presentation.lines, []);
  assert.deepEqual(store.getState().transcript.items, []);
});

test('stale seq is ignored within one websocket session', () => {
  const store = createPresenterStore({ followEnabledByDefault: true });

  store.beginConnection(1);
  store.applyPresentationState(createState(5), 1);
  store.applyPresentationState(createState(4, 'Older script'), 1);

  assert.equal(store.getState().presentation.seq, 5);
  assert.deepEqual(store.getState().presentation.lines, [
    'Walk through the init flow.',
    'Emphasize line 42.',
  ]);
});

test('lower seq is accepted after reconnect', () => {
  const store = createPresenterStore({ followEnabledByDefault: true });

  store.beginConnection(1);
  store.applyPresentationState(createState(9), 1);
  store.beginConnection(2);
  store.applyPresentationState(createState(1, 'Fresh runtime. New script.'), 2);

  assert.equal(store.getState().presentation.seq, 1);
  assert.deepEqual(store.getState().presentation.lines, ['Fresh runtime.', 'New script.']);
});

test('transcripts append a bounded tail and suppress exact duplicates', () => {
  const store = createPresenterStore({ followEnabledByDefault: true, transcriptLimit: 2 });

  store.beginConnection(1);
  store.applyPresentationState(createState(1), 1);
  store.applyTranscript(createTranscript('first', 1), 1);
  store.applyTranscript(createTranscript('first', 1), 1);
  store.applyTranscript(createTranscript('second', 2), 1);
  store.applyTranscript(createTranscript('third', 3), 1);

  assert.deepEqual(store.getState().transcript.items, [
    createTranscript('second', 2),
    createTranscript('third', 3),
  ]);
});
