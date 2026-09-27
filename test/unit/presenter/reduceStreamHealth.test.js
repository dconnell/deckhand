import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceStreamHealth } from '../../../src/presenter/reduceStreamHealth.js';

function createSummary(overrides = {}) {
  return {
    active: false,
    reconnecting: false,
    bitrateKbps: null,
    droppedFrames: 0,
    congestion: null,
    lastUpdateMs: null,
    warning: null,
    ...overrides,
  };
}

test('reduceStreamHealth flags explicitly inactive streams as disconnected', () => {
  assert.deepEqual(reduceStreamHealth({ outputActive: false }, { nowMs: 1_720_000_000_000 }), {
    active: false,
    reconnecting: false,
    bitrateKbps: null,
    droppedFrames: 0,
    congestion: null,
    lastUpdateMs: 1_720_000_000_000,
    warning: 'disconnected',
  });
});

test('reduceStreamHealth computes lifetime bitrate and normalizes congestion when needed', () => {
  assert.deepEqual(reduceStreamHealth({
    outputActive: true,
    outputBytes: 4_250_000,
    outputDuration: 10_000,
    outputCongestion: 0.12,
    outputSkippedFrames: 2,
  }, { nowMs: 1_720_000_000_000 }), {
    active: true,
    reconnecting: false,
    bitrateKbps: 3400,
    droppedFrames: 2,
    congestion: 12,
    lastUpdateMs: 1_720_000_000_000,
    warning: null,
  });
});

test('reduceStreamHealth prefers reconnecting over other warnings', () => {
  assert.deepEqual(reduceStreamHealth({
    outputActive: true,
    outputReconnecting: true,
    outputBytes: 850_000,
    outputDuration: 2_000,
    outputSkippedFrames: 12,
    outputTotalFrames: 120,
  }, { nowMs: 1_720_000_000_000 }), {
    active: true,
    reconnecting: true,
    bitrateKbps: 3400,
    droppedFrames: 12,
    congestion: null,
    lastUpdateMs: 1_720_000_000_000,
    warning: 'reconnecting',
  });
});

test('reduceStreamHealth picks the conservative minimum of interval and lifetime bitrates and warns on sustained dropped frames', () => {
  // Interval bitrate = (4_250_000 - 4_000_000) * 8 / 1_000 = 2000 kbps, while
  // the lifetime bitrate = 4_250_000 * 8 / 10_000 = 3400 kbps. The conservative
  // minimum (2000) must win so a mid-stream slowdown is not masked by the
  // healthier lifetime average.
  const previousStatus = {
    outputActive: true,
    outputBytes: 4_000_000,
    outputDuration: 9_000,
    outputSkippedFrames: 3,
    outputTotalFrames: 300,
  };

  assert.deepEqual(reduceStreamHealth({
    outputActive: true,
    outputBytes: 4_250_000,
    outputDuration: 10_000,
    outputSkippedFrames: 18,
    outputTotalFrames: 600,
  }, {
    previousStatus,
    nowMs: 1_720_000_000_000,
  }), {
    active: true,
    reconnecting: false,
    bitrateKbps: 2000,
    droppedFrames: 18,
    congestion: null,
    lastUpdateMs: 1_720_000_000_000,
    warning: 'droppedFrames',
  });
});

test('reduceStreamHealth warns on severe bitrate collapse only with a prior baseline', () => {
  const previousStatus = {
    outputActive: true,
    outputBytes: 4_250_000,
    outputDuration: 10_000,
    outputSkippedFrames: 0,
    outputTotalFrames: 300,
  };
  const previousSummary = reduceStreamHealth(previousStatus, { nowMs: 1_720_000_000_000 });

  assert.deepEqual(reduceStreamHealth({
    outputActive: true,
    outputBytes: 4_400_000,
    outputDuration: 15_000,
    outputSkippedFrames: 0,
    outputTotalFrames: 450,
  }, {
    previousStatus,
    previousSummary,
    nowMs: 1_720_000_005_000,
  }), {
    active: true,
    reconnecting: false,
    bitrateKbps: 240,
    droppedFrames: 0,
    congestion: null,
    lastUpdateMs: 1_720_000_005_000,
    warning: 'bitrateCollapse',
  });
});

test('reduceStreamHealth does not warn about bitrate collapse on a single low-bitrate sample', () => {
  assert.deepEqual(reduceStreamHealth({
    outputActive: true,
    outputBytes: 150_000,
    outputDuration: 5_000,
  }, { nowMs: 1_720_000_000_000 }), {
    active: true,
    reconnecting: false,
    bitrateKbps: 240,
    droppedFrames: 0,
    congestion: null,
    lastUpdateMs: 1_720_000_000_000,
    warning: null,
  });
});

test('reduceStreamHealth carries forward the prior summary when a sample omits optional fields', () => {
  const previousSummary = createSummary({
    active: true,
    bitrateKbps: 3400,
    droppedFrames: 7,
    congestion: 12,
    lastUpdateMs: 1_720_000_000_000,
  });

  assert.deepEqual(reduceStreamHealth({}, { previousSummary }), previousSummary);
});
