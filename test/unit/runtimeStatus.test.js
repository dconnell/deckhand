import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeStatus } from '../../src/runtimeStatus.js';

test('buildRuntimeStatus returns a compact operator-facing snapshot', () => {
  assert.deepEqual(buildRuntimeStatus({
    currentPresentationState: {
      type: 'presentationState',
      seq: 12,
      slideId: 'code-walkthrough',
      layoutId: 'left-terminal-right-slide',
      audienceScene: 'Left Terminal Right Slide',
      slots: [
        { source: 'Terminal', position: 'left', rect: { x: 0, y: 0, w: 900, h: 1168 } },
      ],
      windowBindings: { Terminal: { app: 'iTerm2' } },
      focus: 'Terminal',
      script: 'secret script text',
      commands: [{ type: 'navigate', url: 'https://example.com' }],
    },
    hubAddress: { host: '127.0.0.1', port: 8765 },
    hubSnapshot: {
      activeDriver: { role: 'driver', sessionId: 'driver-1' },
      observers: [{ role: 'observer', sessionId: 'observer-1' }, { role: 'observer', sessionId: 'observer-2' }],
      sticky: {},
      targets: [{ role: 'target', sessionId: 'target-1' }],
    },
    obsConnected: true,
    presenterEnabled: true,
  }), {
    service: 'deckhand',
    presenterEnabled: true,
    obs: { connected: true },
    hub: {
      host: '127.0.0.1',
      port: 8765,
      driverConnected: true,
      observerCount: 2,
      targetCount: 1,
    },
    current: {
      seq: 12,
      slideId: 'code-walkthrough',
      layoutId: 'left-terminal-right-slide',
      audienceScene: 'Left Terminal Right Slide',
      focus: 'Terminal',
      slots: [
        { source: 'Terminal', position: 'left', rect: { x: 0, y: 0, w: 900, h: 1168 } },
      ],
    },
  });
});

test('buildRuntimeStatus returns null current state before the first slide', () => {
  assert.deepEqual(buildRuntimeStatus({
    currentPresentationState: null,
    hubAddress: { host: '127.0.0.1', port: 8765 },
    hubSnapshot: {
      activeDriver: null,
      observers: [],
      sticky: {},
      targets: [],
    },
    obsConnected: false,
    presenterEnabled: false,
  }), {
    service: 'deckhand',
    presenterEnabled: false,
    obs: { connected: false },
    hub: {
      host: '127.0.0.1',
      port: 8765,
      driverConnected: false,
      observerCount: 0,
      targetCount: 0,
    },
    current: null,
  });
});
