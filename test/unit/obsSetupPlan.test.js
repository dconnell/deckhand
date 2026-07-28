import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildObsSceneDefinitions,
  evaluateCanvasPolicy,
  getExpectedPresenterCanvas,
  parseSetupObsOptions,
} from '../../src/obsSetupPlan.js';

function createConfig() {
  return {
    layouts: {
      'full-slide': {
        id: 'full-slide',
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full' }],
        sources: ['Slide'],
      },
      'dual-browser': {
        id: 'dual-browser',
        audienceScene: 'Dual Browser',
        slots: [
          { source: 'BrowserA', position: 'left' },
          { source: 'BrowserB', position: 'right' },
        ],
        sources: ['BrowserA', 'BrowserB'],
      },
    },
    presenter: {
      stage: { x: 0, y: 0, width: 1800, height: 1168 },
    },
  };
}

test('buildObsSceneDefinitions derives scenes and unique sources from layouts', () => {
  assert.deepEqual(buildObsSceneDefinitions(createConfig(), { width: 1800, height: 1168 }), {
    scenes: [
      {
        sceneName: 'Full Slide',
        items: [
          {
            sourceName: 'Slide',
            position: 'full',
            transform: {
              positionX: 0,
              positionY: 0,
              boundsType: 'OBS_BOUNDS_SCALE_INNER',
              boundsWidth: 1800,
              boundsHeight: 1168,
            },
          },
        ],
      },
      {
        sceneName: 'Dual Browser',
        items: [
          {
            sourceName: 'BrowserA',
            position: 'left',
            transform: {
              positionX: 0,
              positionY: 0,
              boundsType: 'OBS_BOUNDS_SCALE_INNER',
              boundsWidth: 900,
              boundsHeight: 1168,
            },
          },
          {
            sourceName: 'BrowserB',
            position: 'right',
            transform: {
              positionX: 900,
              positionY: 0,
              boundsType: 'OBS_BOUNDS_SCALE_INNER',
              boundsWidth: 900,
              boundsHeight: 1168,
            },
          },
        ],
      },
    ],
    sources: ['Slide', 'BrowserA', 'BrowserB'],
  });
});

test('getExpectedPresenterCanvas returns null when presenter mode is disabled', () => {
  const config = createConfig();
  config.presenter = null;

  assert.equal(getExpectedPresenterCanvas(config), null);
});

test('getExpectedPresenterCanvas returns the presenter stage dimensions', () => {
  assert.deepEqual(getExpectedPresenterCanvas(createConfig()), { width: 1800, height: 1168 });
});

test('evaluateCanvasPolicy warns by default on canvas mismatch without mutating', () => {
  assert.deepEqual(evaluateCanvasPolicy({
    actual: { width: 1920, height: 1080 },
    expected: { width: 1800, height: 1168 },
    options: { check: false, setCanvas: false },
  }), {
    action: 'warn',
    usesCanvas: { width: 1920, height: 1080 },
    warning: 'OBS canvas does not match presenter stage dimensions',
  });
});

test('evaluateCanvasPolicy requests mutation when --set-canvas is enabled', () => {
  assert.deepEqual(evaluateCanvasPolicy({
    actual: { width: 1920, height: 1080 },
    expected: { width: 1800, height: 1168 },
    options: { check: false, setCanvas: true },
  }), {
    action: 'set',
    usesCanvas: { width: 1800, height: 1168 },
  });
});

test('evaluateCanvasPolicy fails read-only checks on mismatch', () => {
  assert.deepEqual(evaluateCanvasPolicy({
    actual: { width: 1920, height: 1080 },
    expected: { width: 1800, height: 1168 },
    options: { check: true, setCanvas: false },
  }), {
    action: 'fail',
    usesCanvas: { width: 1920, height: 1080 },
    error: 'OBS canvas does not match presenter stage dimensions',
  });
});

test('parseSetupObsOptions supports --check, --set-canvas, and a presentation name', () => {
  assert.deepEqual(parseSetupObsOptions(['--check', 'example']), {
    check: true,
    presentationName: 'example',
    setCanvas: false,
  });

  assert.deepEqual(parseSetupObsOptions(['--set-canvas', 'demo']), {
    check: false,
    presentationName: 'demo',
    setCanvas: true,
  });
});

test('parseSetupObsOptions rejects mutually exclusive check and set-canvas flags', () => {
  assert.throws(() => parseSetupObsOptions(['--check', '--set-canvas', 'example']), /mutually exclusive/i);
});
