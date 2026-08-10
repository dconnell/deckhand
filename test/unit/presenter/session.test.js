import assert from 'node:assert/strict';
import test from 'node:test';

import { createPresenterSession } from '../../../src/presenter/session.js';

function createPresentationState(seq, {
  slideId = 'code-walkthrough',
  layoutId = 'left-terminal-right-slide',
  focus = 'Terminal',
  script = 'Walk through the init flow.\n\nEmphasize line 42.\nThen run the demo.',
  hidden = false,
} = {}) {
  return {
    type: 'presentationState',
    seq,
    slideId,
    layoutId,
    audienceScene: 'Left Terminal Right Slide',
    slots: [],
    focus,
    script,
    overlays: hidden ? [{ source: 'Presenter', hidden: true }] : [],
  };
}

function createTranscript(text, capturedAtMs) {
  return {
    type: 'transcript',
    source: 'whisper',
    text,
    capturedAtMs,
  };
}

test('sticky presentation state bootstraps structured presenter lines', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });

  session.applyPresentationState(createPresentationState(3), 1_000);

  const state = session.getState();
  assert.equal(state.presentationSeq, 3);
  assert.equal(state.current.slideId, 'code-walkthrough');
  assert.equal(state.current.hidden, false);
  assert.equal(state.teleprompter.followEnabled, true);
  assert.equal(state.teleprompter.activeLineIndex, 0);
  assert.deepEqual(state.current.lines.map((line) => ({
    spokenText: line.spokenText,
    paragraphIndex: line.paragraphIndex,
  })), [
    { spokenText: 'Walk through the init flow.', paragraphIndex: 0 },
    { spokenText: '', paragraphIndex: 1 },
    { spokenText: 'Emphasize line 42.', paragraphIndex: 1 },
    { spokenText: 'Then run the demo.', paragraphIndex: 1 },
  ]);
});

test('same-slide presentation republish preserves teleprompter follow state', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });

  session.applyPresentationState(createPresentationState(3), 1_000);
  session.applyTranscript(createTranscript('emphasize line 42', 2_000));
  session.applyPresentationState(createPresentationState(4), 3_000);

  const state = session.getState();
  assert.equal(state.presentationSeq, 4);
  assert.equal(state.teleprompter.activeLineIndex, 2);
  assert.deepEqual(state.teleprompter.recentTranscript.map((item) => item.text), ['emphasize line 42']);
});

test('hidden slides blank the presenter state and suspend transcript matching', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });

  session.applyPresentationState(createPresentationState(3, { hidden: true }), 1_000);
  session.applyTranscript(createTranscript('then run the demo', 2_000));

  const state = session.getState();
  assert.equal(state.current.hidden, true);
  assert.equal(state.teleprompter.activeLineIndex, 0);
  assert.equal(state.teleprompter.trackingState, 'idle');
});

test('manual teleprompter commands reanchor follow state and ignore stale transcript chunks', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });

  session.applyPresentationState(createPresentationState(3), 1_000);
  session.applyTranscript(createTranscript('then run the demo', 2_000));
  assert.equal(session.getState().teleprompter.activeLineIndex, 3);

  session.applyCommand({ op: 'reset', source: 'console' }, 3_000);
  assert.equal(session.getState().teleprompter.activeLineIndex, 0);

  session.applyTranscript(createTranscript('then run the demo', 2_500));
  assert.equal(session.getState().teleprompter.activeLineIndex, 0);
});

test('slide manifests drive next-slide preview without client-side guessing', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });

  session.applySlideManifest({
    type: 'slideManifest',
    slides: [
      { id: 'intro', index: { h: 0, v: 0 }, heading: 'Intro' },
      { id: 'demo', index: { h: 1, v: 0 }, title: 'Live Demo' },
      { id: 'outro', index: { h: 2, v: 0 }, heading: 'Outro' },
    ],
  }, 1_000);
  session.applyPresentationState(createPresentationState(1, { slideId: 'intro', layoutId: 'full-slide', focus: null, script: null }), 1_500);

  assert.deepEqual(session.getState().next, {
    slideId: 'demo',
    title: 'Live Demo',
    heading: null,
    index: { h: 1, v: 0 },
  });

  session.applyPresentationState(createPresentationState(2, { slideId: 'outro', layoutId: 'full-slide', focus: null, script: null }), 2_000);
  assert.equal(session.getState().next, null);
});

test('timer stays idle until started, then preserves elapsed time across pause and reset', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });

  assert.equal(session.getState().timer.running, false);
  assert.equal(session.getState().timer.elapsedMs, 0);

  session.applyCommand({ op: 'timerStart', source: 'console' }, 1_000);
  session.tick(2_500);
  assert.equal(session.getState().timer.running, true);
  assert.equal(session.getState().timer.elapsedMs, 1_500);

  session.applyCommand({ op: 'timerPause', source: 'console' }, 4_000);
  assert.equal(session.getState().timer.elapsedMs, 3_000);

  session.tick(8_000);
  assert.equal(session.getState().timer.elapsedMs, 3_000);

  session.applyCommand({ op: 'timerReset', source: 'console' }, 9_000);
  assert.equal(session.getState().timer.running, false);
  assert.equal(session.getState().timer.elapsedMs, 0);
});

test('tracking state moves from listening to offScript to lost based on silence thresholds', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    tracking: {
      offScriptMs: 2_000,
      lostMs: 5_000,
      minConfidence: 0.35,
    },
  });

  session.applyPresentationState(createPresentationState(1), 1_000);
  session.applyTranscript(createTranscript('walk through the init flow', 2_000));
  assert.equal(session.getState().teleprompter.trackingState, 'listening');

  session.tick(4_500);
  assert.equal(session.getState().teleprompter.trackingState, 'offScript');

  session.tick(8_000);
  assert.equal(session.getState().teleprompter.trackingState, 'lost');
});

test('far-jump gate holds the active line on low-context future transcript leaps', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    tracking: {
      farJumpLines: 1,
      minConfidence: 0.35,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Line one.\nLine two.\nLine three.\nLine four.\nLine five.',
  }), 1_000);
  session.applyTranscript(createTranscript('line one', 2_000));
  assert.equal(session.getState().teleprompter.activeLineIndex, 0);

  session.applyTranscript(createTranscript('line five', 3_000));
  assert.equal(session.getState().teleprompter.activeLineIndex, 0);
});
