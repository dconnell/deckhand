import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoordinator } from '../../../src/coordinator.js';
import { createConfig, createLogger, createTracingExecutor, createTracingHub, createTransitionsConfig } from '../../helpers/coordinatorFixtures.js';

test('coordinator starts obs then executor then hub', async () => {
  const calls = [];
  const logger = createLogger();
  const executor = {
    async start() {
      calls.push('executor.start');
    },
    async stop() {
      calls.push('executor.stop');
    },
    async execute() {},
  };
  const obs = {
    async connect() {
      calls.push('obs.connect');
    },
    async disconnect() {
      calls.push('obs.disconnect');
    },
    async setScene() {},
    isConnected() {
      return true;
    },
  };
  const hub = {
    on() {},
    async start() {
      calls.push('hub.start');
    },
    async stop() {
      calls.push('hub.stop');
    },
    async sendCommand() {},
    async publishSticky() {},
    getSnapshot() {
      return { activeDriver: null, observers: [], sticky: {} };
    },
  };

  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor, logger });

  await coordinator.start();

  assert.deepEqual(calls, ['obs.connect', 'executor.start', 'hub.start']);
  assert.match(logger.infos[0].message, /starting/i);
});

test('coordinator stops executor then hub then obs', async () => {
  const calls = [];
  const executor = {
    async start() {},
    async stop() {
      calls.push('executor.stop');
    },
    async execute() {},
  };
  const coordinator = createCoordinator({
    config: createConfig(),
    obs: {
      async connect() {},
      async disconnect() {
        calls.push('obs.disconnect');
      },
      async setScene() {},
      isConnected() {
        return true;
      },
    },
    hub: {
      on() {},
      async start() {},
      async stop() {
        calls.push('hub.stop');
      },
      async sendCommand() {},
      async publishSticky() {},
      getSnapshot() {
        return { activeDriver: null, observers: [], sticky: {} };
      },
    },
    executor,
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.stop();

  assert.deepEqual(calls, ['executor.stop', 'hub.stop', 'obs.disconnect']);
});

test('coordinator cleans up partial startup if a dependency fails to start', async () => {
  const calls = [];
  const coordinator = createCoordinator({
    config: createConfig(),
    obs: {
      async connect() {
        calls.push('obs.connect');
      },
      async disconnect() {
        calls.push('obs.disconnect');
      },
      async setScene() {},
      isConnected() {
        return true;
      },
    },
    hub: {
      on() {},
      async start() {
        calls.push('hub.start');
        throw new Error('hub start failed');
      },
      async stop() {
        calls.push('hub.stop');
      },
      async sendCommand() {},
      async publishSticky() {},
      getSnapshot() {
        return { activeDriver: null, observers: [], sticky: {} };
      },
    },
    executor: {
      async start() {
        calls.push('executor.start');
      },
      async stop() {
        calls.push('executor.stop');
      },
      async execute() {},
    },
    logger: createLogger(),
  });

  await assert.rejects(() => coordinator.start(), /hub start failed/i);
  assert.deepEqual(calls, [
    'obs.connect',
    'executor.start',
    'hub.start',
    'executor.stop',
    'obs.disconnect',
  ]);
});

test('coordinator enables OBS Studio Mode for the Deckhand session and restores it on stop', async () => {
  const trace = [];
  const obs = {
    async connect() {
      trace.push('connect');
    },
    async disconnect() {
      trace.push('disconnect');
    },
    isConnected() {
      return true;
    },
    async getCurrentTransitionName() {
      return 'Fade';
    },
    async captureProgramScreenshot() {},
    async applyInputSettings() {},
    async ensureFreezeAssets() {},
    async getStudioModeEnabled() {
      trace.push('getStudioModeEnabled');
      return false;
    },
    async setStudioModeEnabled(enabled) {
      trace.push(`setStudioModeEnabled:${enabled}`);
    },
    async setPreviewScene() {},
    async triggerStudioModeTransition() {},
  };

  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs,
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  assert.ok(trace.includes('getStudioModeEnabled'), 'checks the studio mode state at startup');
  assert.ok(trace.includes('setStudioModeEnabled:true'), 'enables studio mode for the Deckhand session');

  trace.length = 0;
  await coordinator.stop();
  assert.ok(trace.includes('setStudioModeEnabled:false'), 'restores studio mode to off on stop');
});

test('coordinator leaves OBS Studio Mode on if it was already on at startup', async () => {
  const trace = [];
  const obs = {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    async getCurrentTransitionName() {
      return 'Fade';
    },
    async captureProgramScreenshot() {},
    async applyInputSettings() {},
    async ensureFreezeAssets() {},
    async getStudioModeEnabled() {
      return true;
    },
    async setStudioModeEnabled(enabled) {
      trace.push(`setStudioModeEnabled:${enabled}`);
    },
    async setPreviewScene() {},
    async triggerStudioModeTransition() {},
  };

  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs,
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();

  trace.length = 0;
  await coordinator.stop();
  assert.ok(trace.includes('setStudioModeEnabled:true'), 'restores to the original on state');
});
