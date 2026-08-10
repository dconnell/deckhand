import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeStatus } from '../../src/runtimeStatus.js';

test('buildRuntimeStatus returns a compact operator-facing snapshot with browser-session health', () => {
  assert.deepEqual(buildRuntimeStatus({
    phase: 'ready',
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
    currentPresenterState: {
      type: 'presenterState',
      seq: 20,
      presentationSeq: 12,
      current: {
        slideId: 'code-walkthrough',
        layoutId: 'left-terminal-right-slide',
        focus: 'Terminal',
        hidden: false,
        lines: [{}, {}, {}],
      },
      next: { slideId: 'next', title: 'Next', heading: null, index: { h: 2, v: 0 } },
      teleprompter: {
        followEnabled: true,
        activeLineIndex: 1,
        trackingState: 'listening',
        recentTranscript: [{ text: 'hello' }],
      },
      timer: { running: true, elapsedMs: 1200, remainingMs: null, targetDurationMs: null },
      obs: { preview: { available: true, path: '/presenter/program.jpg', revision: 2, capturedAtMs: 1720000000000, stale: false } },
      stream: { active: true, reconnecting: false, bitrateKbps: 3400, droppedFrames: 2, congestion: 12, lastUpdateMs: 1720000000000, warning: null },
    },
  }), {
    service: 'deckhand',
    phase: 'ready',
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
    presenter: {
      seq: 20,
      presentationSeq: 12,
      current: {
        slideId: 'code-walkthrough',
        layoutId: 'left-terminal-right-slide',
        focus: 'Terminal',
        hidden: false,
        lineCount: 3,
      },
      next: { slideId: 'next', title: 'Next', heading: null, index: { h: 2, v: 0 } },
      teleprompter: {
        followEnabled: true,
        activeLineIndex: 1,
        trackingState: 'listening',
        recentTranscriptCount: 1,
      },
      timer: { running: true, elapsedMs: 1200, remainingMs: null, targetDurationMs: null },
      obs: {
        preview: { available: true, path: '/presenter/program.jpg', revision: 2, capturedAtMs: 1720000000000, stale: false },
      },
      stream: { active: true, reconnecting: false, bitrateKbps: 3400, droppedFrames: 2, congestion: 12, lastUpdateMs: 1720000000000, warning: null },
    },
  });
});

test('buildRuntimeStatus reports degraded browser-session state before the session is ready', () => {
  assert.deepEqual(buildRuntimeStatus({
    phase: 'starting',
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
    currentPresenterState: null,
  }), {
    service: 'deckhand',
    phase: 'starting',
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
    presenter: null,
  });
});

test('buildRuntimeStatus surfaces not-ready sources without dropping them', () => {
  assert.deepEqual(buildRuntimeStatus({
    phase: 'starting',
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
    currentPresenterState: null,
  }), {
    service: 'deckhand',
    phase: 'starting',
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
    presenter: null,
  });
});
