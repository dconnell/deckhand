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

test('presenter state starts with an explicit empty current state', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });

  const state = session.getState();
  assert.equal(state.current.script, null);
  assert.equal(state.current.slideId, null);
  assert.deepEqual(state.current.lines, []);
});

test('getState returns a detached snapshot that later mutations cannot leak into', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });

  session.applyPresentationState(createPresentationState(3), 1_000);
  const snapshot = session.getState();
  snapshot.current.lines.push({ spokenText: 'mutated', paragraphIndex: 9 });
  snapshot.teleprompter.recentTranscript.push({ source: 'whisper', text: 'mutated', capturedAtMs: 1 });
  snapshot.seq = 999;

  const next = session.getState();
  assert.equal(next.seq, 1);
  assert.deepEqual(next.current.lines.map((line) => line.spokenText), [
    'Walk through the init flow.',
    '',
    'Emphasize line 42.',
    'Then run the demo.',
  ]);
  assert.deepEqual(next.teleprompter.recentTranscript, []);
});

test('preview updates only commit when the merged preview state changes', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });
  const initialSeq = session.getState().seq;

  assert.equal(session.updateObsPreview({ stale: false }, 1_000), true);
  const afterChange = session.getState();
  assert.equal(afterChange.seq, initialSeq + 1);
  assert.equal(afterChange.updatedAtMs, 1_000);
  assert.equal(afterChange.obs.preview.stale, false);

  assert.equal(session.updateObsPreview({ stale: false }, 2_000), false);
  const afterNoOp = session.getState();
  assert.equal(afterNoOp.seq, initialSeq + 1);
  assert.equal(afterNoOp.updatedAtMs, 1_000);
});

test('stream updates only commit when the merged stream state changes', () => {
  const session = createPresenterSession({ followEnabledByDefault: true });
  const initialSeq = session.getState().seq;

  assert.equal(session.updateStream({ active: true, bitrateKbps: 4_000 }, 1_000), true);
  const afterChange = session.getState();
  assert.equal(afterChange.seq, initialSeq + 1);
  assert.equal(afterChange.updatedAtMs, 1_000);
  assert.equal(afterChange.stream.active, true);

  assert.equal(session.updateStream({ active: true, bitrateKbps: 4_000 }, 2_000), false);
  const afterNoOp = session.getState();
  assert.equal(afterNoOp.seq, initialSeq + 1);
  assert.equal(afterNoOp.updatedAtMs, 1_000);
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

test('delayed transcript matches refresh tracking from observation time rather than capture time', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    tracking: {
      offScriptMs: 2_000,
      lostMs: 5_000,
      minConfidence: 0.35,
    },
  });

  session.applyPresentationState(createPresentationState(1), 1_000);
  session.applyTranscript(createTranscript('walk through the init flow', 2_000), 10_000);
  assert.equal(session.getState().teleprompter.trackingState, 'listening');

  session.tick(11_500);
  assert.equal(session.getState().teleprompter.trackingState, 'listening');

  session.tick(12_500);
  assert.equal(session.getState().teleprompter.trackingState, 'offScript');

  session.tick(15_500);
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

test('tracking prefers nearby matches before evaluating far-future recovery jumps', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    tracking: {
      farJumpLines: 2,
      minConfidence: 0.35,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Welcome intro.\nThe coordinator creates state.\nNext line.\nLater line.\nAnother line.\nYet another line.\nExtra line.\nMore line.\nFinal setup line.\nIntro.',
  }), 1_000);
  session.applyTranscript(createTranscript('welcome intro', 2_000), 2_000);
  session.applyTranscript(createTranscript('welcome intro the coordinator creates', 3_000), 3_000);

  assert.equal(session.getState().teleprompter.activeLineIndex, 1);
});

test('revised partials on the same line do not teach a fake forward rate', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    predictionLeadMs: 5_000,
    tracking: {
      offScriptMs: 10_000,
      lostMs: 20_000,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Line one still talking here.\nLine two.\nLine three.',
  }), 1_000);
  session.applyTranscript(createTranscript('line one', 2_000), 2_000);
  session.applyTranscript(createTranscript('line one still', 3_000), 3_000);
  session.applyTranscript(createTranscript('line one still talking here', 4_000), 4_000);

  assert.equal(session.tick(9_000), false);
  assert.equal(session.getState().teleprompter.activeLineIndex, 0);
  assert.equal(session.getState().teleprompter.trackingState, 'listening');
});

test('same-line partial revisions after a forward anchor do not extend the prediction window', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    predictionLeadMs: 2_000,
    tracking: {
      offScriptMs: 10_000,
      lostMs: 20_000,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Alpha now.\nBravo next.\nCharlie later.\nDelta after.\nEcho end.',
  }), 500);
  session.applyTranscript(createTranscript('alpha now', 1_000), 1_000);
  session.applyTranscript(createTranscript('bravo next', 2_000), 2_000);
  session.applyTranscript(createTranscript('bravo next revised', 3_500), 3_500);

  assert.equal(session.tick(6_000), true);
  assert.equal(session.getState().teleprompter.activeLineIndex, 3);
});

test('transcript matches project forward using the current reduction time', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    predictionLeadMs: 3_000,
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Line one.\nLine two.\nLine three.\nLine four.',
  }), 1_000);
  session.applyTranscript(createTranscript('line one', 2_000), 2_000);
  session.applyTranscript(createTranscript('line two', 3_000), 5_500);

  assert.equal(session.getState().teleprompter.activeLineIndex, 3);
});

test('tick advances follow mode within the prediction window and then holds position', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    predictionLeadMs: 2_000,
    tracking: {
      offScriptMs: 10_000,
      lostMs: 20_000,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Line one.\nLine two.\nLine three.\nLine four.\nLine five.',
  }), 1_000);
  session.applyTranscript(createTranscript('line one', 2_000), 2_000);
  session.applyTranscript(createTranscript('line two', 3_000), 3_000);

  assert.equal(session.tick(4_500), true);
  assert.equal(session.getState().teleprompter.activeLineIndex, 2);

  assert.equal(session.tick(7_500), true);
  assert.equal(session.getState().teleprompter.activeLineIndex, 3);

  assert.equal(session.tick(8_000), false);
  assert.equal(session.getState().teleprompter.activeLineIndex, 3);
});

test('follow mode can advance one spoken line early on strong next-line evidence and slide changes clear that state', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    predictionLeadMs: 2_000,
    tracking: {
      offScriptMs: 10_000,
      lostMs: 20_000,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Intro line.\nThis section walks slowly through the coordinator state initialization before the handoff happens.\nThen demo the app.\nAfter that we continue.',
  }), 1_000);
  session.applyTranscript(createTranscript('this section walks slowly through the coordinator state initialization before the handoff happens', 2_000), 2_000);
  assert.equal(session.getState().teleprompter.activeLineIndex, 1);

  session.applyTranscript(createTranscript('this section walks slowly through the coordinator state initialization before the handoff happens then demo', 3_000), 3_000);
  assert.equal(session.getState().teleprompter.activeLineIndex, 2);
  assert.equal(session.tick(4_000), false);
  assert.equal(session.getState().teleprompter.activeLineIndex, 2);

  session.applyPresentationState(createPresentationState(2, {
    slideId: 'next-slide',
    layoutId: 'full-slide',
    focus: null,
    script: 'Fresh start line.\nSecond sentence.',
  }), 4_000);

  assert.equal(session.getState().teleprompter.activeLineIndex, 0);
  assert.deepEqual(session.getState().teleprompter.recentTranscript, []);
  assert.equal(session.getState().teleprompter.trackingState, 'idle');
  assert.equal(session.tick(7_000), false);
  assert.equal(session.getState().teleprompter.activeLineIndex, 0);

  session.applyTranscript(createTranscript('then demo the app', 3_500), 4_500);
  assert.equal(session.getState().teleprompter.activeLineIndex, 0);
});

test('follow mode can still hand off when the next short line evidence is slightly imperfect', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    predictionLeadMs: 2_000,
    tracking: {
      offScriptMs: 10_000,
      lostMs: 20_000,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Intro line.\nToday we will talk through the live demo setup before the handoff to the short call to action.\nDemo starts now.\nAfter that we continue.',
  }), 1_000);

  session.applyTranscript(createTranscript('today we will talk through the live demo setup before the handoff to the short call to action', 1_500), 1_500);
  assert.equal(session.getState().teleprompter.activeLineIndex, 1);

  session.applyTranscript(createTranscript('today we will talk through the live demo setup before handoff demo starts now', 2_000), 2_000);

  assert.equal(session.getState().teleprompter.activeLineIndex, 2);
  // Under TF-IDF the fully-heard short line ("Demo starts now.") wins directly
  // rather than via the early-handoff path. Early-handoff resets the predictor
  // and suppresses lead projection; a confident direct match anchors it, so the
  // existing lead projection resumes — matching the behavior asserted in
  // "transcript matches project forward using the current reduction time".
  assert.equal(session.tick(3_000), true);
  assert.equal(session.getState().teleprompter.activeLineIndex, 3);
});

test('follow mode can hand off after two words into a five-word next line', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    predictionLeadMs: 2_000,
    tracking: {
      offScriptMs: 10_000,
      lostMs: 20_000,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Intro line.\nWe need to carefully describe the initialization details before the transition into the operator handoff and final checklist for the live demo.\nNow please open dashboard view.\nAfter that we continue.',
  }), 1_000);

  session.applyTranscript(createTranscript('we need to carefully describe the initialization details before the transition into the operator handoff and final checklist for the live demo', 2_000), 2_000);
  assert.equal(session.getState().teleprompter.activeLineIndex, 1);

  session.applyTranscript(createTranscript('we need to carefully describe the initialization details before the transition into the operator handoff and final checklist for the live demo now please', 3_000), 3_000);

  assert.equal(session.getState().teleprompter.activeLineIndex, 2);
  assert.equal(session.tick(4_000), false);
  assert.equal(session.getState().teleprompter.activeLineIndex, 2);
});

test('off-script recovery widens the forward search window to farJumpLines times three', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    tracking: {
      offScriptMs: 2_000,
      lostMs: 10_000,
      minConfidence: 0.35,
      farJumpLines: 1,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'Alpha begins.\nBravo continues.\nCharlie delta.\nEcho foxtrot.\nGolf hotel.',
  }), 1_000);
  session.applyTranscript(createTranscript('alpha begins', 2_000), 2_000);
  assert.equal(session.getState().teleprompter.activeLineIndex, 0);

  session.tick(5_000);
  assert.equal(session.getState().teleprompter.trackingState, 'offScript');

  // Line 3 is three ahead: beyond the normal farJumpLines gate (1) but within the
  // widened off-script gate (farJumpLines * 3 === 3).
  session.applyTranscript(createTranscript('echo foxtrot', 5_500), 5_500);
  assert.equal(session.getState().teleprompter.activeLineIndex, 3);
  assert.equal(session.getState().teleprompter.trackingState, 'listening');
});

test('off-script recovery accepts distinctive partial matches below the default confidence threshold', () => {
  const session = createPresenterSession({
    followEnabledByDefault: true,
    tracking: {
      offScriptMs: 2_000,
      lostMs: 10_000,
      minConfidence: 0.35,
      farJumpLines: 2,
    },
  });

  session.applyPresentationState(createPresentationState(1, {
    script: 'The intro.\nThe sigma tau omega.',
  }), 1_000);
  session.applyTranscript(createTranscript('the intro', 2_000), 2_000);
  assert.equal(session.getState().teleprompter.activeLineIndex, 0);

  session.tick(5_000);
  assert.equal(session.getState().teleprompter.trackingState, 'offScript');

  // 'sigma' alone yields a weighted confidence of ~0.286: below the default 0.35
  // threshold, but accepted by the lowered 0.25 off-script threshold. This relies
  // on the shrunken item window isolating the latest transcript chunk.
  session.applyTranscript(createTranscript('sigma', 5_500), 5_500);
  assert.equal(session.getState().teleprompter.activeLineIndex, 1);
  assert.equal(session.getState().teleprompter.trackingState, 'listening');
});
