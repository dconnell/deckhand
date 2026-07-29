import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOUNDS_TYPE,
  buildPresentationState,
  listAudienceScenes,
  listLayoutSources,
  regionTransform,
  screenRect,
} from '../../src/scenes.js';

function createConfig() {
  return {
    layouts: {
      'full-slide': {
        id: 'full-slide',
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full' }],
        sources: ['Slide'],
      },
      'left-terminal-right-slide': {
        id: 'left-terminal-right-slide',
        audienceScene: 'Left Terminal Right Slide',
        slots: [
          { source: 'Terminal', position: 'left' },
          { source: 'Slide', position: 'right' },
        ],
        sources: ['Terminal', 'Slide'],
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
    slides: {
      welcome: {
        layoutId: 'full-slide',
        focus: null,
        script: null,
        commands: [],
      },
      'code-walkthrough': {
        layoutId: 'left-terminal-right-slide',
        focus: 'Terminal',
        script: 'Walk through the init flow.\nEmphasize line 42.',
        commands: [],
      },
      'dual-demo': {
        layoutId: 'dual-browser',
        focus: 'BrowserB',
        script: null,
        commands: [],
      },
    },
    presenter: {
      stage: { x: 100, y: 50, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' },
        Terminal: { app: 'iTerm2' },
        BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
        BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
      },
    },
  };
}

test('regionTransform preserves aspect ratio (SCALE_INNER), never stretches', () => {
  assert.equal(BOUNDS_TYPE, 'OBS_BOUNDS_SCALE_INNER');
  assert.deepEqual(regionTransform('full', 1920, 1080), {
    positionX: 0,
    positionY: 0,
    boundsType: 'OBS_BOUNDS_SCALE_INNER',
    boundsWidth: 1920,
    boundsHeight: 1080,
  });

  assert.deepEqual(regionTransform('left', 1920, 1080), {
    positionX: 0,
    positionY: 0,
    boundsType: 'OBS_BOUNDS_SCALE_INNER',
    boundsWidth: 960,
    boundsHeight: 1080,
  });

  assert.deepEqual(regionTransform('right', 1920, 1080), {
    positionX: 960,
    positionY: 0,
    boundsType: 'OBS_BOUNDS_SCALE_INNER',
    boundsWidth: 960,
    boundsHeight: 1080,
  });
});

test('screenRect returns exact presenter-stage rectangles', () => {
  const stage = { x: 100, y: 50, width: 1800, height: 1168 };

  assert.deepEqual(screenRect('full', stage), { x: 100, y: 50, w: 1800, h: 1168 });
  assert.deepEqual(screenRect('left', stage), { x: 100, y: 50, w: 900, h: 1168 });
  assert.deepEqual(screenRect('right', stage), { x: 1000, y: 50, w: 900, h: 1168 });
});

test('listAudienceScenes returns unique audience scenes from the layout catalog', () => {
  assert.deepEqual(listAudienceScenes(createConfig()), [
    'Full Slide',
    'Left Terminal Right Slide',
    'Dual Browser',
  ]);
});

test('listLayoutSources returns unique logical sources from the layout catalog', () => {
  assert.deepEqual(listLayoutSources(createConfig()), [
    'Slide',
    'Terminal',
    'BrowserA',
    'BrowserB',
  ]);
});

test('buildPresentationState resolves a slide into the full sticky presenter state', () => {
  assert.deepEqual(buildPresentationState('code-walkthrough', createConfig(), 17), {
    type: 'presentationState',
    seq: 17,
    slideId: 'code-walkthrough',
    layoutId: 'left-terminal-right-slide',
    audienceScene: 'Left Terminal Right Slide',
    slots: [
      {
        source: 'Terminal',
        position: 'left',
        rect: { x: 100, y: 50, w: 900, h: 1168 },
      },
      {
        source: 'Slide',
        position: 'right',
        rect: { x: 1000, y: 50, w: 900, h: 1168 },
      },
    ],
    windowBindings: {
      Terminal: { app: 'iTerm2' },
      Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' },
    },
    focus: 'Terminal',
    script: 'Walk through the init flow.\nEmphasize line 42.',
    commands: [],
  });
});

test('buildPresentationState omits presenter-only fields when presenter mode is disabled', () => {
  const config = createConfig();
  config.presenter = null;

  assert.deepEqual(buildPresentationState('welcome', config, 3), {
    type: 'presentationState',
    seq: 3,
    slideId: 'welcome',
    layoutId: 'full-slide',
    audienceScene: 'Full Slide',
    slots: [
      {
        source: 'Slide',
        position: 'full',
      },
    ],
    focus: null,
    script: null,
    commands: [],
  });
});

test('buildPresentationState overlays runtime exact window bindings onto bootstrap selectors', () => {
  assert.deepEqual(
    buildPresentationState('dual-demo', createConfig(), 18, {
      windowBindings: {
        BrowserA: {
          app: 'Google Chrome',
          pid: 47213,
          macWindowId: 12345,
          strict: true,
        },
      },
    }).windowBindings,
    {
      BrowserA: {
        app: 'Google Chrome',
        titleIncludes: 'Primary',
        pid: 47213,
        macWindowId: 12345,
        strict: true,
      },
      BrowserB: {
        app: 'Google Chrome',
        titleIncludes: 'Secondary',
      },
    },
  );
});
