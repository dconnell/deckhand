import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOUNDS_TYPE,
  buildPresentationState,
  findBelowMinimumOverlayRects,
  listAudienceScenes,
  listLayoutSources,
  regionTransform,
  screenRect,
  shouldSkipAudienceTransition,
} from '../../src/scenes.js';

function createConfig() {
  return {
    layouts: {
      'full-slide': {
        id: 'full-slide',
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full' }],
        sources: ['Slide'],
        overlays: [{ source: 'Presenter', rect: { x: 1600, y: 50, w: 250, h: 400 } }],
      },
      'left-terminal-right-slide': {
        id: 'left-terminal-right-slide',
        audienceScene: 'Left Terminal Right Slide',
        slots: [
          { source: 'Terminal', position: 'left' },
          { source: 'Slide', position: 'right' },
        ],
        sources: ['Terminal', 'Slide'],
        overlays: [],
      },
      'dual-browser': {
        id: 'dual-browser',
        audienceScene: 'Dual Browser',
        slots: [
          { source: 'BrowserA', position: 'left' },
          { source: 'BrowserB', position: 'right' },
        ],
        sources: ['BrowserA', 'BrowserB'],
        overlays: [],
      },
    },
    slides: {
      welcome: {
        layoutId: 'full-slide',
        focus: null,
        script: null,
        commands: [],
        overlays: [],
      },
      'code-walkthrough': {
        layoutId: 'left-terminal-right-slide',
        focus: 'Terminal',
        script: 'Walk through the init flow.\nEmphasize line 42.',
        commands: [],
        overlays: [{ source: 'Presenter', hidden: true }],
      },
      'dual-demo': {
        layoutId: 'dual-browser',
        focus: 'BrowserB',
        script: null,
        commands: [],
        overlays: [{ source: 'Presenter', rect: { x: 0, y: 1120, w: 1800, h: 48 } }],
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
      teleprompter: {
        followEnabledByDefault: true,
        window: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
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
      Presenter: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
    },
    managedWindowBindings: {
      Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' },
      Terminal: { app: 'iTerm2' },
      BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
      BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
      Presenter: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
    },
    focus: 'Terminal',
    script: 'Walk through the init flow.\nEmphasize line 42.',
    commands: [],
    overlays: [{ source: 'Presenter', hidden: true }],
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
      Presenter: {
        app: 'Google Chrome',
        titleIncludes: 'Deckhand Presenter',
      },
    },
  );
});

test('buildPresentationState merges layout and slide overlays by source and includes Presenter binding when needed', () => {
  assert.deepEqual(buildPresentationState('dual-demo', createConfig(), 19), {
    type: 'presentationState',
    seq: 19,
    slideId: 'dual-demo',
    layoutId: 'dual-browser',
    audienceScene: 'Dual Browser',
    slots: [
      {
        source: 'BrowserA',
        position: 'left',
        rect: { x: 100, y: 50, w: 900, h: 1168 },
      },
      {
        source: 'BrowserB',
        position: 'right',
        rect: { x: 1000, y: 50, w: 900, h: 1168 },
      },
    ],
    windowBindings: {
      BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
      BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
      Presenter: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
    },
    managedWindowBindings: {
      Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' },
      Terminal: { app: 'iTerm2' },
      BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
      BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
      Presenter: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
    },
    focus: 'BrowserB',
    script: null,
    commands: [],
    overlays: [{ source: 'Presenter', rect: { x: 0, y: 1120, w: 1800, h: 48 } }],
  });
});

test('buildPresentationState leaves overlays absent when neither layout nor slide config declares them', () => {
  const config = createConfig();
  config.layouts['full-slide'].overlays = [];
  config.slides.welcome.overlays = [];

  const state = buildPresentationState('welcome', config, 20);

  assert.equal(Object.prototype.hasOwnProperty.call(state, 'overlays'), false);
  assert.deepEqual(state.windowBindings, {
    Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' },
  });
});

test('buildPresentationState includes presenter-level default overlays when layout and slides declare none', () => {
  const config = createConfig();
  config.presenter.overlays = [{ source: 'Console', rect: { x: 10, y: 20, w: 300, h: 200 } }];
  config.layouts['full-slide'].overlays = [];
  config.slides.welcome.overlays = [];

  const state = buildPresentationState('welcome', config, 21);

  assert.deepEqual(state.overlays, [{ source: 'Console', rect: { x: 10, y: 20, w: 300, h: 200 } }]);
});

test('buildPresentationState applies overlay precedence presenter defaults < layout < slide', () => {
  const config = createConfig();
  config.presenter.overlays = [
    { source: 'Presenter', rect: { x: 0, y: 0, w: 100, h: 100 } },
    { source: 'Obs', rect: { x: 1, y: 1, w: 200, h: 200 } },
    { source: 'Console', rect: { x: 4, y: 4, w: 500, h: 500 } },
  ];
  config.layouts['dual-browser'].overlays = [
    { source: 'Presenter', rect: { x: 2, y: 2, w: 300, h: 300 } },
    { source: 'Obs', hidden: true },
  ];
  config.slides['dual-demo'].overlays = [
    { source: 'Presenter', rect: { x: 3, y: 3, w: 400, h: 400 } },
  ];

  const state = buildPresentationState('dual-demo', config, 22);

  assert.deepEqual(state.overlays, [
    { source: 'Presenter', rect: { x: 3, y: 3, w: 400, h: 400 } },
    { source: 'Obs', hidden: true },
    { source: 'Console', rect: { x: 4, y: 4, w: 500, h: 500 } },
  ]);

  // Rects must be per-state clones, not aliases of the config objects they
  // were merged from — the deepEqual above cannot distinguish shared references.
  const configRects = [
    ...config.presenter.overlays,
    ...config.layouts['dual-browser'].overlays,
    ...config.slides['dual-demo'].overlays,
  ]
    .map((overlay) => overlay.rect)
    .filter((rect) => rect !== undefined);

  for (const overlay of state.overlays) {
    if (overlay.rect !== undefined) {
      for (const rect of configRects) {
        assert.notEqual(overlay.rect, rect);
      }
    }
  }
});

test('buildPresentationState surfaces externalWindows selectors as managed bindings and window bindings when overlaid', () => {
  const config = createConfig();
  config.presenter.externalWindows = { Obs: { app: 'OBS', titleIncludes: 'OBS Studio' } };
  config.layouts['full-slide'].overlays = [{ source: 'Obs', rect: { x: 1400, y: 900, w: 400, h: 225 } }];

  const state = buildPresentationState('welcome', config, 23);

  assert.deepEqual(state.managedWindowBindings.Obs, { app: 'OBS', titleIncludes: 'OBS Studio' });
  assert.deepEqual(state.windowBindings, {
    Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' },
    Obs: { app: 'OBS', titleIncludes: 'OBS Studio' },
  });
  assert.deepEqual(state.overlays, [{ source: 'Obs', rect: { x: 1400, y: 900, w: 400, h: 225 } }]);
});

test('buildPresentationState surfaces runtime Console bindings in managedWindowBindings without a presenter.windows entry', () => {
  const config = createConfig();

  const state = buildPresentationState('dual-demo', config, 24, {
    windowBindings: { Console: { pid: 123, macWindowId: 456 } },
  });

  assert.deepEqual(state.managedWindowBindings.Console, { pid: 123, macWindowId: 456 });
});

test('shouldSkipAudienceTransition only skips advances that cannot change the audience frame', () => {
  const dualBrowserState = {
    audienceScene: 'Dual Browser',
    slots: [
      { source: 'BrowserA', position: 'left' },
      { source: 'BrowserB', position: 'right' },
    ],
  };
  const fullSlideState = {
    audienceScene: 'Full Slide',
    slots: [{ source: 'Slide', position: 'full' }],
  };

  const cases = [
    {
      name: 'null previous state never skips',
      previousState: null,
      nextState: dualBrowserState,
      slideConfig: { commands: [] },
      expected: false,
    },
    {
      name: 'undefined previous state never skips',
      previousState: undefined,
      nextState: dualBrowserState,
      slideConfig: { commands: [] },
      expected: false,
    },
    {
      name: 'different audience scene never skips',
      previousState: fullSlideState,
      nextState: dualBrowserState,
      slideConfig: { commands: [] },
      expected: false,
    },
    {
      name: 'non-empty commands never skip',
      previousState: dualBrowserState,
      nextState: dualBrowserState,
      slideConfig: { commands: [{ type: 'activateTab', source: 'BrowserA', tab: 'checkout' }] },
      expected: false,
    },
    {
      name: 'same scene, same slots, and empty commands skip',
      previousState: dualBrowserState,
      nextState: dualBrowserState,
      slideConfig: { commands: [] },
      expected: true,
    },
    {
      name: 'different slot count never skips',
      previousState: dualBrowserState,
      nextState: {
        audienceScene: 'Dual Browser',
        slots: [{ source: 'BrowserA', position: 'left' }],
      },
      slideConfig: { commands: [] },
      expected: false,
    },
    {
      name: 'same-length slots with a different source never skip',
      previousState: dualBrowserState,
      nextState: {
        audienceScene: 'Dual Browser',
        slots: [
          { source: 'BrowserB', position: 'left' },
          { source: 'BrowserA', position: 'right' },
        ],
      },
      slideConfig: { commands: [] },
      expected: false,
    },
    {
      name: 'same-length slots with a different position never skip',
      previousState: dualBrowserState,
      nextState: {
        audienceScene: 'Dual Browser',
        slots: [
          { source: 'BrowserA', position: 'right' },
          { source: 'BrowserB', position: 'left' },
        ],
      },
      slideConfig: { commands: [] },
      expected: false,
    },
    {
      name: 'rect-only slot differences still skip',
      previousState: {
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full', rect: { x: 0, y: 0, w: 1800, h: 1168 } }],
      },
      nextState: {
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full', rect: { x: 10, y: 20, w: 900, h: 500 } }],
      },
      slideConfig: { commands: [] },
      expected: true,
    },
    {
      name: 'deck slide changes are audience-visible',
      previousState: {
        slideId: 'a',
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full' }],
      },
      nextState: {
        slideId: 'b',
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full' }],
      },
      slideConfig: { commands: [] },
      expected: false,
    },
    {
      name: 'terminal slides with different ids still skip',
      previousState: {
        slideId: 'a',
        audienceScene: 'Dual Browser',
        slots: [
          { source: 'BrowserA', position: 'left' },
          { source: 'BrowserB', position: 'right' },
        ],
      },
      nextState: {
        slideId: 'b',
        audienceScene: 'Dual Browser',
        slots: [
          { source: 'BrowserA', position: 'left' },
          { source: 'BrowserB', position: 'right' },
        ],
      },
      slideConfig: { commands: [] },
      expected: true,
    },
    {
      name: 'undefined slide config is treated as no commands',
      previousState: dualBrowserState,
      nextState: dualBrowserState,
      slideConfig: undefined,
      expected: true,
    },
  ];

  for (const testCase of cases) {
    assert.equal(
      shouldSkipAudienceTransition(testCase.previousState, testCase.nextState, testCase.slideConfig),
      testCase.expected,
      testCase.name,
    );
  }
});

/**
 * Minimal normalized-config shape for `findBelowMinimumOverlayRects` tests:
 * one layout and one slide with empty overlays, plus an empty presenter block.
 */
function createOverlayScanConfig() {
  return {
    layouts: {
      'dual-browser': {
        id: 'dual-browser',
        audienceScene: 'Dual Browser',
        slots: [
          { source: 'BrowserA', position: 'left' },
          { source: 'BrowserB', position: 'right' },
        ],
        overlays: [],
      },
    },
    slides: {
      'dual-demo': {
        layoutId: 'dual-browser',
        focus: null,
        script: null,
        commands: [],
        overlays: [],
      },
    },
    presenter: {
      overlays: [],
    },
  };
}

test('findBelowMinimumOverlayRects returns no findings when presenter mode is disabled', () => {
  const config = createOverlayScanConfig();
  config.presenter = null;

  assert.deepEqual(findBelowMinimumOverlayRects(config, { width: 500, height: 272 }), []);
});

test('findBelowMinimumOverlayRects finds a below-minimum Presenter rect at presenter level', () => {
  const config = createOverlayScanConfig();
  config.presenter.overlays = [{ source: 'Presenter', rect: { x: 10, y: 20, w: 300, h: 400 } }];

  assert.deepEqual(findBelowMinimumOverlayRects(config, { width: 500, height: 272 }), [
    { source: 'Presenter', origin: 'presenter.overlays', rect: { x: 10, y: 20, w: 300, h: 400 } },
  ]);
});

test('findBelowMinimumOverlayRects finds a below-minimum Console rect at layout level', () => {
  const config = createOverlayScanConfig();
  config.layouts['dual-browser'].overlays = [{ source: 'Console', rect: { x: 1, y: 2, w: 600, h: 200 } }];

  assert.deepEqual(findBelowMinimumOverlayRects(config, { width: 500, height: 272 }), [
    { source: 'Console', origin: 'layout:dual-browser', rect: { x: 1, y: 2, w: 600, h: 200 } },
  ]);
});

test('findBelowMinimumOverlayRects finds a below-minimum rect at slide level', () => {
  const config = createOverlayScanConfig();
  config.slides['dual-demo'].overlays = [{ source: 'Presenter', rect: { x: 3, y: 4, w: 200, h: 500 } }];

  assert.deepEqual(findBelowMinimumOverlayRects(config, { width: 500, height: 272 }), [
    { source: 'Presenter', origin: 'slide:dual-demo', rect: { x: 3, y: 4, w: 200, h: 500 } },
  ]);
});

test('findBelowMinimumOverlayRects excludes foreign sources even when below minimum', () => {
  const config = createOverlayScanConfig();
  config.presenter.overlays = [{ source: 'Obs', rect: { x: 0, y: 0, w: 10, h: 10 } }];
  config.layouts['dual-browser'].overlays = [{ source: 'Obs', rect: { x: 0, y: 0, w: 10, h: 10 } }];
  config.slides['dual-demo'].overlays = [{ source: 'Obs', rect: { x: 0, y: 0, w: 10, h: 10 } }];

  assert.deepEqual(findBelowMinimumOverlayRects(config, { width: 500, height: 272 }), []);
});

test('findBelowMinimumOverlayRects excludes hidden overlays without a rect', () => {
  const config = createOverlayScanConfig();
  config.presenter.overlays = [{ source: 'Presenter', hidden: true }];
  config.slides['dual-demo'].overlays = [{ source: 'Console', hidden: true }];

  assert.deepEqual(findBelowMinimumOverlayRects(config, { width: 500, height: 272 }), []);
});

test('findBelowMinimumOverlayRects excludes rects exactly at the minimum', () => {
  const config = createOverlayScanConfig();
  config.presenter.overlays = [{ source: 'Presenter', rect: { x: 0, y: 0, w: 500, h: 272 } }];

  assert.deepEqual(findBelowMinimumOverlayRects(config, { width: 500, height: 272 }), []);
});

test('findBelowMinimumOverlayRects includes rects below the minimum in only one dimension', () => {
  const config = createOverlayScanConfig();
  config.presenter.overlays = [
    { source: 'Presenter', rect: { x: 0, y: 0, w: 499, h: 1000 } },
    { source: 'Console', rect: { x: 0, y: 0, w: 1000, h: 271 } },
  ];

  assert.deepEqual(findBelowMinimumOverlayRects(config, { width: 500, height: 272 }), [
    { source: 'Presenter', origin: 'presenter.overlays', rect: { x: 0, y: 0, w: 499, h: 1000 } },
    { source: 'Console', origin: 'presenter.overlays', rect: { x: 0, y: 0, w: 1000, h: 271 } },
  ]);
});

test('findBelowMinimumOverlayRects scans presenter overlays before layouts before slides', () => {
  const config = createOverlayScanConfig();
  config.presenter.overlays = [{ source: 'Console', rect: { x: 0, y: 0, w: 100, h: 100 } }];
  config.layouts['dual-browser'].overlays = [{ source: 'Presenter', rect: { x: 1, y: 1, w: 100, h: 100 } }];
  config.slides['dual-demo'].overlays = [{ source: 'Presenter', rect: { x: 2, y: 2, w: 100, h: 100 } }];

  assert.deepEqual(
    findBelowMinimumOverlayRects(config, { width: 500, height: 272 }).map((finding) => finding.origin),
    ['presenter.overlays', 'layout:dual-browser', 'slide:dual-demo'],
  );
});
