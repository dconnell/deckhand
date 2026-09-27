import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignLineTiers,
  buildProgramPreviewUrl,
  buildProgressPercent,
  buildTeleprompterFrame,
  computeTeleprompterOffset,
  buildTokenRenderParts,
  buildTrackingStatusView,
  createWheelNudgeAccumulator,
  normalizeWheelDelta,
  reconcileLineNodes,
  shouldRenderImmediately,
} from '../../../presenter-web/teleprompterView.js';

function createPresenterState(overrides = {}) {
  return {
    current: {
      hidden: false,
      lines: [
        { tokens: [{ kind: 'text', text: 'One' }], spokenText: 'One', paragraphIndex: 0 },
        { tokens: [{ kind: 'gap' }], spokenText: '', paragraphIndex: 1 },
        { tokens: [{ kind: 'text', text: 'Two' }], spokenText: 'Two', paragraphIndex: 1 },
        { tokens: [{ kind: 'text', text: 'Three' }], spokenText: 'Three', paragraphIndex: 2 },
      ],
    },
    teleprompter: {
      activeLineIndex: 2,
      trackingState: 'listening',
    },
    ...overrides,
  };
}

function createLineMetric(top, height) {
  return {
    top,
    height,
    bottom: top + height,
  };
}

test('buildTrackingStatusView auto-hides listening after the grace window and shows on hover', () => {
  assert.deepEqual(buildTrackingStatusView({
    hidden: false,
    hovered: false,
    lastStateChangeAtMs: 1_000,
    nowMs: 2_000,
    trackingState: 'listening',
  }), {
    label: 'listening',
    tone: 'green',
    visible: true,
  });

  assert.deepEqual(buildTrackingStatusView({
    hidden: false,
    hovered: false,
    lastStateChangeAtMs: 1_000,
    nowMs: 6_000,
    trackingState: 'listening',
  }), {
    label: 'listening',
    tone: 'green',
    visible: false,
  });

  assert.equal(buildTrackingStatusView({
    hidden: false,
    hovered: true,
    lastStateChangeAtMs: 1_000,
    nowMs: 6_000,
    trackingState: 'listening',
  }).visible, true);
});

test('buildTeleprompterFrame returns a hidden frame for hidden slides', () => {
  assert.deepEqual(buildTeleprompterFrame(createPresenterState({
    current: { hidden: true, lines: [] },
  }), {
    hovered: false,
    lastStateChangeAtMs: 1_000,
    lineHeight: 58,
    lineGap: 16,
    nowMs: 2_000,
    viewportHeight: 900,
  }), {
    hidden: true,
    offsetPx: 0,
    progressPercent: 0,
    status: { label: 'Hidden', tone: 'muted', visible: true },
    tiers: [],
  });
});

test('computeTeleprompterOffset keeps the recently read line in the top band', () => {
  assert.equal(computeTeleprompterOffset({
    activeLineIndex: 2,
    lineHeight: 58,
    lineGap: 16,
    lines: createPresenterState().current.lines,
    viewportHeight: 900,
  }), 108);
});

test('computeTeleprompterOffset clamps the top band to keep the next line visible on short viewports', () => {
  assert.equal(computeTeleprompterOffset({
    activeLineIndex: 2,
    lineHeight: 58,
    lineGap: 16,
    lines: createPresenterState().current.lines,
    viewportHeight: 250,
  }), -30);
});

test('computeTeleprompterOffset compresses the top band to keep two lookahead lines visible when they fit', () => {
  assert.equal(computeTeleprompterOffset({
    activeLineIndex: 2,
    lineHeight: 58,
    lineGap: 16,
    lines: createPresenterState().current.lines,
    viewportHeight: 300,
  }), 20);
});

test('computeTeleprompterOffset moves earlier lines above the viewport to keep the current and next spoken lines visible on tight viewports', () => {
  assert.equal(computeTeleprompterOffset({
    activeLineIndex: 2,
    lineHeight: 58,
    lineGap: 16,
    lines: createPresenterState().current.lines,
    viewportHeight: 205,
  }), -75);
});

test('computeTeleprompterOffset uses measured line heights when wrapping pushes upcoming spoken lines down', () => {
  assert.equal(computeTeleprompterOffset({
    activeLineIndex: 1,
    lineHeight: 58,
    lineGap: 16,
    lineMetrics: [
      createLineMetric(0, 58),
      createLineMetric(74, 140),
      createLineMetric(230, 58),
      createLineMetric(304, 58),
    ],
    lines: [
      { spokenText: 'One' },
      { spokenText: 'Two' },
      { spokenText: 'Three' },
      { spokenText: 'Four' },
    ],
    viewportHeight: 380,
  }), 18);
});

test('buildTeleprompterFrame resets a new slide to the top band', () => {
  assert.equal(buildTeleprompterFrame(createPresenterState({
    teleprompter: {
      activeLineIndex: 0,
      trackingState: 'idle',
    },
  }), {
    hovered: false,
    lastStateChangeAtMs: 1_000,
    lineHeight: 58,
    lineGap: 16,
    nowMs: 2_000,
    viewportHeight: 900,
  }).offsetPx, 108);
});

test('buildTeleprompterFrame keeps the same top band when a new slide starts after a meta line', () => {
  assert.equal(buildTeleprompterFrame(createPresenterState({
    current: {
      hidden: false,
      lines: [
        { tokens: [{ kind: 'mode', text: 'DEMO' }], spokenText: '', paragraphIndex: 0 },
        { tokens: [{ kind: 'text', text: 'Intro' }], spokenText: 'Intro', paragraphIndex: 0 },
        { tokens: [{ kind: 'text', text: 'Next' }], spokenText: 'Next', paragraphIndex: 0 },
        { tokens: [{ kind: 'text', text: 'Later' }], spokenText: 'Later', paragraphIndex: 0 },
      ],
    },
    teleprompter: {
      activeLineIndex: 1,
      trackingState: 'idle',
    },
  }), {
    hovered: false,
    lastStateChangeAtMs: 1_000,
    lineHeight: 58,
    lineGap: 16,
    nowMs: 2_000,
    viewportHeight: 900,
  }).offsetPx, 34);
});

test('buildTeleprompterFrame treats gap and mode rows as metadata instead of consuming spoken lookahead', () => {
  const frame = buildTeleprompterFrame(createPresenterState({
    current: {
      hidden: false,
      lines: [
        { tokens: [{ kind: 'text', text: 'One' }], spokenText: 'One', paragraphIndex: 0 },
        { tokens: [{ kind: 'gap' }], spokenText: '', paragraphIndex: 1 },
        { tokens: [{ kind: 'text', text: 'Two' }], spokenText: 'Two', paragraphIndex: 1 },
        { tokens: [{ kind: 'mode', text: 'DEMO' }], spokenText: '', paragraphIndex: 1 },
        { tokens: [{ kind: 'text', text: 'Three' }], spokenText: 'Three', paragraphIndex: 1 },
      ],
    },
    teleprompter: {
      activeLineIndex: 2,
      trackingState: 'listening',
    },
  }), {
    hovered: false,
    lastStateChangeAtMs: 1_000,
    lineHeight: 58,
    lineGap: 16,
    nowMs: 2_000,
    viewportHeight: 250,
  });

  assert.equal(frame.offsetPx, -104);
  assert.deepEqual(frame.tiers, ['past', 'past', 'future', 'future', 'future']);
});

test('assignLineTiers marks lines before the active index as past and the rest as future', () => {
  assert.deepEqual(assignLineTiers([
    { spokenText: 'One' },
    { spokenText: '' },
    { spokenText: 'Two' },
    { spokenText: '' },
    { spokenText: 'Three' },
    { spokenText: 'Four' },
  ], 2), ['past', 'past', 'future', 'future', 'future', 'future']);
});

test('buildProgressPercent counts only spoken lines', () => {
  assert.equal(buildProgressPercent(createPresenterState().current.lines, 0), 0);
  assert.equal(buildProgressPercent(createPresenterState().current.lines, 2), 0.5);
  assert.equal(buildProgressPercent(createPresenterState().current.lines, 3), 1);
});

test('buildTokenRenderParts maps renderer token classes', () => {
  assert.deepEqual(buildTokenRenderParts([
    { kind: 'stage', text: 'look left' },
    { kind: 'emphasis', text: 'important' },
    { kind: 'pause' },
    { kind: 'mode', text: 'DEMO' },
    { kind: 'gap' },
    { kind: 'command', text: 'dce status' },
  ]), [
    { className: 'token token-stage', text: 'look left' },
    { className: 'token token-emphasis', text: 'important' },
    { className: 'token token-pause', text: '...' },
    { className: 'token token-mode', text: 'DEMO' },
    { className: 'token token-gap', text: '' },
    { className: 'token token-command', text: 'dce status' },
  ]);
});

test('reconcileLineNodes reuses existing node objects instead of resetting the whole list', () => {
  const attached = [];
  const removed = [];
  const rendered = [];
  const firstNodes = reconcileLineNodes({
    nodes: [],
    lines: ['one', 'two'],
    createNode() {
      return { id: attached.length + 1 };
    },
    appendNode(node) {
      attached.push(node);
    },
    removeNode(node) {
      removed.push(node);
    },
    renderNode(node, line, index) {
      rendered.push({ node, line, index });
    },
  });

  rendered.length = 0;
  const secondNodes = reconcileLineNodes({
    nodes: firstNodes,
    lines: ['one', 'two'],
    createNode() {
      throw new Error('should not create a new node');
    },
    appendNode() {},
    removeNode() {},
    renderNode(node, line, index) {
      rendered.push({ node, line, index });
    },
  });

  assert.equal(secondNodes[0], firstNodes[0]);
  assert.equal(secondNodes[1], firstNodes[1]);
  assert.equal(attached.length, 2);
  assert.deepEqual(removed, []);
  assert.equal(rendered.length, 2);
});

test('buildProgramPreviewUrl appends the preview revision for cache busting', () => {
  assert.equal(buildProgramPreviewUrl('/presenter/program.jpg', 7), '/presenter/program.jpg?rev=7');
  assert.equal(buildProgramPreviewUrl('/presenter/program.jpg', null), '/presenter/program.jpg');
});

test('shouldRenderImmediately snaps when the slide seq changes so deep scrolls do not animate into the top band', () => {
  assert.equal(shouldRenderImmediately({
    prevSeq: 5, nextSeq: 6, prevVisible: true, nextVisible: true,
  }), true);
});

test('shouldRenderImmediately animates ordinary line tracking on the same slide', () => {
  assert.equal(shouldRenderImmediately({
    prevSeq: 5, nextSeq: 5, prevVisible: true, nextVisible: true,
  }), false);
});

test('shouldRenderImmediately snaps the first time a slide becomes visible and when a hidden slide reappears', () => {
  assert.equal(shouldRenderImmediately({
    prevSeq: null, nextSeq: 5, prevVisible: false, nextVisible: true,
  }), true);
  assert.equal(shouldRenderImmediately({
    prevSeq: 5, nextSeq: 5, prevVisible: false, nextVisible: true,
  }), true);
});

test('shouldRenderImmediately does not request an immediate render when hiding', () => {
  assert.equal(shouldRenderImmediately({
    prevSeq: 5, nextSeq: 5, prevVisible: true, nextVisible: false,
  }), false);
});

test('computeTeleprompterOffset keeps the current and next spoken line visible when upcoming lines wrap tall (measured heights)', () => {
  const metrics = [
    createLineMetric(0, 36),
    createLineMetric(44, 73),
    createLineMetric(125, 36),
    createLineMetric(169, 73),
    createLineMetric(250, 36),
  ];

  const offset = computeTeleprompterOffset({
    activeLineIndex: 1,
    lineHeight: 36,
    lineGap: 8,
    lineMetrics: metrics,
    lines: metrics.map(() => ({ spokenText: 'line' })),
    viewportHeight: 220,
  });

  const currentTop = metrics[1].top + offset;
  const nextSpokenBottom = metrics[2].bottom + offset;
  const lookaheadBottom = metrics[3].bottom + offset;

  assert.ok(currentTop >= 0, `current line top stays on screen (got ${currentTop})`);
  assert.ok(currentTop < 220, `current line is within the viewport (got ${currentTop})`);
  assert.ok(nextSpokenBottom <= 220, `next spoken line bottom stays visible (got ${nextSpokenBottom})`);
  assert.ok(lookaheadBottom <= 220, `preferred second lookahead line bottom stays visible when it fits (got ${lookaheadBottom})`);
});

test('computeTeleprompterOffset scrolls down to reveal the next spoken line while keeping the current line on screen on tight viewports', () => {
  const metrics = [
    createLineMetric(0, 36),
    createLineMetric(44, 73),
    createLineMetric(125, 73),
    createLineMetric(206, 36),
  ];

  const offset = computeTeleprompterOffset({
    activeLineIndex: 1,
    lineHeight: 36,
    lineGap: 8,
    lineMetrics: metrics,
    lines: metrics.map(() => ({ spokenText: 'line' })),
    viewportHeight: 160,
  });

  const currentTop = metrics[1].top + offset;
  const currentBottom = metrics[1].bottom + offset;
  const nextBottom = metrics[2].bottom + offset;

  assert.ok(currentTop >= 0, `current line stays on screen (got top ${currentTop})`);
  assert.ok(currentBottom <= 160, `current line remains fully visible (got bottom ${currentBottom})`);
  assert.ok(nextBottom <= 160, `next spoken line is scrolled into view (got bottom ${nextBottom})`);
});

// Wheel nudges: one rendered line step is 36px min-height + 8px margin = 44px,
// so the accumulator threshold mirrors that value.
test('createWheelNudgeAccumulator accumulates sub-threshold deltas without emitting a nudge', () => {
  const accumulator = createWheelNudgeAccumulator();

  assert.equal(accumulator.push({ deltaY: 20, nowMs: 0 }), 0);
  assert.equal(accumulator.push({ deltaY: 20, nowMs: 50 }), 0);
});

test('createWheelNudgeAccumulator emits one nudge and carries the remainder when the threshold is crossed', () => {
  const accumulator = createWheelNudgeAccumulator();

  assert.equal(accumulator.push({ deltaY: 60, nowMs: 0 }), 1);
  assert.equal(accumulator.push({ deltaY: 30, nowMs: 50 }), 1);
});

test('createWheelNudgeAccumulator maps downward scroll to positive and upward scroll to negative nudges', () => {
  const accumulator = createWheelNudgeAccumulator();

  assert.equal(accumulator.push({ deltaY: 60, nowMs: 0 }), 1);
  assert.equal(accumulator.push({ deltaY: -120, nowMs: 50 }), -2);
});

test('createWheelNudgeAccumulator drops the accumulated remainder once no wheel delta arrived within the idle window', () => {
  const accumulator = createWheelNudgeAccumulator();

  assert.equal(accumulator.push({ deltaY: 40, nowMs: 0 }), 0);
  assert.equal(accumulator.push({ deltaY: 40, nowMs: 1_000 }), 0);
  assert.equal(accumulator.push({ deltaY: 40, nowMs: 1_050 }), 1);
});

test('createWheelNudgeAccumulator emits multiple nudges when one gesture crosses several thresholds', () => {
  const accumulator = createWheelNudgeAccumulator();

  assert.equal(accumulator.push({ deltaY: 132, nowMs: 0 }), 3);
  assert.equal(accumulator.push({ deltaY: 100, nowMs: 50 }), 2);
});

test('createWheelNudgeAccumulator reset clears a pending remainder', () => {
  const accumulator = createWheelNudgeAccumulator();

  assert.equal(accumulator.push({ deltaY: 40, nowMs: 0 }), 0);
  accumulator.reset();
  assert.equal(accumulator.push({ deltaY: 10, nowMs: 50 }), 0);
});

test('normalizeWheelDelta passes pixel-mode deltas through unchanged', () => {
  assert.equal(normalizeWheelDelta({ deltaY: 60, deltaMode: 0 }), 60);
});

test('normalizeWheelDelta scales line-mode deltas by the rendered line step', () => {
  assert.equal(normalizeWheelDelta({ deltaY: 3, deltaMode: 1 }), 132);
});

test('normalizeWheelDelta scales page-mode deltas by the viewport height and treats non-finite deltas as zero', () => {
  assert.equal(normalizeWheelDelta({ deltaY: 1, deltaMode: 2, viewportHeightPx: 900 }), 900);
  assert.equal(normalizeWheelDelta({ deltaY: Number.NaN }), 0);
});
