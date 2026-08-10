import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProgramPreviewUrl,
  buildProgressPercent,
  buildTeleprompterFrame,
  buildTokenRenderParts,
  buildTrackingStatusView,
  reconcileLineNodes,
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
  ]), [
    { className: 'token token-stage', text: 'look left' },
    { className: 'token token-emphasis', text: 'important' },
    { className: 'token token-pause', text: '...' },
    { className: 'token token-mode', text: 'DEMO' },
    { className: 'token token-gap', text: '' },
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
