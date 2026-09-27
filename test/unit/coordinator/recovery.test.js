import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoordinator } from '../../../src/coordinator.js';
import {
  createConfig,
  createLogger,
  createTracingExecutor,
  createTracingHub,
  createTracingObs,
  createTransitionsConfig,
} from '../../helpers/coordinatorFixtures.js';

function createRecoveryAwareObs(trace) {
  const handlers = new Map();

  return {
    ...createTracingObs(trace),
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event) {
      const handler = handlers.get(event);
      if (handler) {
        handler();
      }
    },
  };
}

function createRecoveryAwareBrowserSession() {
  const handlers = new Map();

  return {
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event) {
      const handler = handlers.get(event);
      if (handler) {
        handler();
      }
    },
  };
}

function createRecoveryTestSetup({ trace, withBrowserSession = false } = {}) {
  const obs = createRecoveryAwareObs(trace);
  const browserSession = withBrowserSession ? createRecoveryAwareBrowserSession() : undefined;
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs,
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    getManagedBrowserPid: () => 47213,
    getManagedWindowBindings: () => ({
      BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary', macWindowId: 12345, pid: 47213, strict: true },
      BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary', macWindowId: 67890, pid: 47213, strict: true },
    }),
    ...(browserSession === undefined ? {} : { browserSession }),
    logger: createLogger(),
  });

  return { coordinator, obs, browserSession };
}

test('reapplyCurrentSlide clears the binding cache and re-applies OBS bindings plus browser commands', async () => {
  const trace = [];
  const { coordinator } = createRecoveryTestSetup({ trace });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  trace.length = 0;
  await coordinator.reapplyCurrentSlide('browserRecovered');

  assert.ok(trace.includes('applyInputSettings:Deckhand_BrowserA'), 're-applies the cached OBS window binding');
  assert.ok(trace.includes('execute:activateTab'), 're-dispatches the slide browser commands');
  assert.ok(trace.includes('execute:navigate'), 're-dispatches every browser command type');
});

test('reapplyCurrentSlide re-arms the freeze frame when rearmFreeze is set', async () => {
  const trace = [];
  const { coordinator } = createRecoveryTestSetup({ trace });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  trace.length = 0;
  await coordinator.reapplyCurrentSlide('obsReconnected', { rearmFreeze: true });

  assert.ok(trace.includes('captureProgramScreenshot'), 're-captures the freeze frame');
  assert.ok(trace.some((entry) => entry.startsWith('ensureFreezeAssets')), 're-ensures freeze assets');
});

test('an obs reconnect reapplies the current slide with a freeze re-arm through the slide queue', async () => {
  const trace = [];
  const { coordinator, obs } = createRecoveryTestSetup({ trace });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  trace.length = 0;
  obs.emit('reconnected');
  await coordinator.awaitSlideOperations();

  assert.ok(trace.includes('applyInputSettings:Deckhand_BrowserA'), 'reconnect re-applies OBS bindings');
  assert.ok(trace.includes('captureProgramScreenshot'), 'reconnect re-arms the freeze frame');
});

test('a browser session recovery reapplies the current slide without re-arming the freeze frame', async () => {
  const trace = [];
  const { coordinator, browserSession } = createRecoveryTestSetup({ trace, withBrowserSession: true });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  trace.length = 0;
  browserSession.emit('recovered');
  await coordinator.awaitSlideOperations();

  assert.ok(trace.includes('applyInputSettings:Deckhand_BrowserA'), 'browser recovery re-applies OBS bindings');
  assert.ok(!trace.includes('captureProgramScreenshot'), 'browser recovery leaves the freeze frame alone');
});

test('recovery reapply operations are serialized through the slide operation queue', async () => {
  const trace = [];
  const { coordinator, browserSession } = createRecoveryTestSetup({ trace, withBrowserSession: true });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  trace.length = 0;
  browserSession.emit('recovered');
  browserSession.emit('recovered');
  await coordinator.awaitSlideOperations();

  const reapplyCount = trace.filter((entry) => entry === 'applyInputSettings:Deckhand_BrowserA').length;
  assert.equal(reapplyCount, 2, 'each recovery event runs its own serialized reapply');
});

test('coordinator persists the active slide id on each driver position change when a persistSlideId is wired', async () => {
  const persisted = [];
  const coordinator = createCoordinator({
    config: createConfig(),
    obs: createTracingObs([]),
    hub: createTracingHub([]),
    executor: createTracingExecutor([]),
    persistSlideId: async (payload) => {
      persisted.push(payload);
    },
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(persisted, [
    { slideId: 'intro', index: { h: 0, v: 0 } },
    { slideId: 'demo', index: { h: 1, v: 0 } },
  ]);
});

test('coordinator keeps working without a persistSlideId callback', async () => {
  const coordinator = createCoordinator({
    config: createConfig(),
    obs: createTracingObs([]),
    hub: createTracingHub([]),
    executor: createTracingExecutor([]),
    logger: createLogger(),
  });

  await coordinator.start();
  await assert.doesNotReject(
    coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} }),
  );
});
