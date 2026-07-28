import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeStatus } from '../../src/runtimeStatus.js';

test('buildRuntimeStatus returns a compact operator-facing snapshot with browser-session health', () => {
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
    },
    browserSessionStatus: {
      connected: true,
      chromePid: 47213,
      sources: {
        Slide: { ready: true, activeTab: 'deck', tabs: ['deck'] },
        BrowserA: { ready: true, activeTab: 'checkout', tabs: ['home', 'checkout'] },
      },
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
    },
    browserSession: {
      connected: true,
      chromePid: 47213,
      sources: {
        Slide: { ready: true, activeTab: 'deck', tabs: ['deck'] },
        BrowserA: { ready: true, activeTab: 'checkout', tabs: ['home', 'checkout'] },
      },
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

test('buildRuntimeStatus reports degraded browser-session state before the session is ready', () => {
  assert.deepEqual(buildRuntimeStatus({
    currentPresentationState: null,
    hubAddress: { host: '127.0.0.1', port: 8765 },
    hubSnapshot: {
      activeDriver: null,
      observers: [],
      sticky: {},
    },
    browserSessionStatus: {
      connected: false,
      chromePid: null,
      sources: {},
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
    },
    browserSession: {
      connected: false,
      chromePid: null,
      sources: {},
    },
    current: null,
  });
});

test('buildRuntimeStatus surfaces not-ready sources without dropping them', () => {
  assert.deepEqual(buildRuntimeStatus({
    currentPresentationState: null,
    hubAddress: { host: '127.0.0.1', port: 8765 },
    hubSnapshot: { activeDriver: null, observers: [], sticky: {} },
    browserSessionStatus: {
      connected: false,
      chromePid: 47213,
      sources: {
        BrowserA: { ready: false, activeTab: 'home', tabs: ['home', 'checkout'] },
      },
    },
    obsConnected: true,
    presenterEnabled: true,
  }), {
    service: 'deckhand',
    presenterEnabled: true,
    obs: { connected: true },
    hub: { host: '127.0.0.1', port: 8765, driverConnected: false, observerCount: 0 },
    browserSession: {
      connected: false,
      chromePid: 47213,
      sources: {
        BrowserA: { ready: false, activeTab: 'home', tabs: ['home', 'checkout'] },
      },
    },
    current: null,
  });
});
