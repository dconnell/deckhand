import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoordinator } from '../../src/coordinator.js';

function createLogger() {
  return {
    errors: [],
    infos: [],
    warns: [],
    error(message, context) {
      this.errors.push({ message, context });
    },
    info(message, context) {
      this.infos.push({ message, context });
    },
    warn(message, context) {
      this.warns.push({ message, context });
    },
  };
}

function createConfig() {
  return {
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { host: '127.0.0.1', port: 8765 },
    hotkeys: { next: 'F13', prev: 'F14' },
    sources: {
      Slide: { id: 'Slide', kind: 'browser', browser: { windowLabel: null, tabs: { deck: { url: 'http://deck/', preload: true } }, initialTab: 'deck' } },
      BrowserA: {
        id: 'BrowserA',
        kind: 'browser',
        browser: {
          windowLabel: 'browser-a',
          tabs: {
            home: { url: 'https://example.com/home', preload: true },
            checkout: { url: 'https://example.com/checkout', preload: true },
          },
          initialTab: 'home',
        },
      },
      BrowserB: { id: 'BrowserB', kind: 'browser', browser: { windowLabel: 'browser-b', tabs: { main: { url: 'https://example.com/other', preload: true } }, initialTab: 'main' } },
    },
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
    slides: {
      intro: {
        layoutId: 'full-slide',
        focus: null,
        script: null,
        commands: [],
      },
      demo: {
        layoutId: 'dual-browser',
        focus: 'BrowserB',
        script: 'Demo script',
        commands: [
          { type: 'activateTab', source: 'BrowserA', tab: 'checkout' },
          { type: 'navigate', source: 'BrowserB', tab: 'main', url: 'https://example.com/other-app' },
        ],
      },
    },
    presenter: {
      platform: 'macos',
      stage: { x: 0, y: 0, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Google Chrome' },
        BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
        BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
      },
      stt: null,
      teleprompter: { followEnabledByDefault: true },
      http: { host: '127.0.0.1', port: 3001 },
    },
  };
}

function createFakeHub() {
  const handlers = new Map();
  const state = {
    sentDriverCommands: [],
    stickyPublishes: [],
    started: false,
    stopped: false,
  };

  return {
    state,
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    emit(eventName, payload) {
      const handler = handlers.get(eventName);
      if (handler) {
        return handler(payload);
      }

      return undefined;
    },
    async start() {
      state.started = true;
    },
    async stop() {
      state.stopped = true;
    },
    async sendCommand(target, command) {
      state.sentDriverCommands.push({ target, command });
    },
    async publishSticky(channel, payload) {
      state.stickyPublishes.push({ channel, payload });
    },
    getSnapshot() {
      return { activeDriver: null, observers: [], sticky: {} };
    },
  };
}

function createFakeExecutor() {
  const state = { started: false, stopped: false, executedCommands: [], nextError: null };

  return {
    state,
    async start() {
      state.started = true;
    },
    async stop() {
      state.stopped = true;
    },
    async execute(command) {
      state.executedCommands.push(command);

      if (state.nextError !== null) {
        const error = state.nextError;
        state.nextError = null;
        throw error;
      }
    },
  };
}

function createFakeHotkeys() {
  const handlers = new Map();
  const state = { started: false, stopped: false };

  return {
    state,
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    emit(eventName, payload) {
      return handlers.get(eventName)?.(payload);
    },
    async start() {
      state.started = true;
    },
    async stop() {
      state.stopped = true;
    },
  };
}

function createFakeObs() {
  const state = { connected: false, disconnected: false, scenes: [] };

  return {
    state,
    async connect() {
      state.connected = true;
    },
    async disconnect() {
      state.disconnected = true;
    },
    async setScene(sceneName) {
      state.scenes.push(sceneName);
    },
    isConnected() {
      return state.connected;
    },
  };
}

test('coordinator starts obs then hub then executor then hotkeys', async () => {
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
  const hotkeys = {
    on() {},
    async start() {
      calls.push('hotkeys.start');
    },
    async stop() {
      calls.push('hotkeys.stop');
    },
  };

  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor, logger });

  await coordinator.start();

  assert.deepEqual(calls, ['obs.connect', 'hub.start', 'executor.start', 'hotkeys.start']);
  assert.match(logger.infos[0].message, /starting/i);
});

test('coordinator stops hotkeys then executor then hub then obs', async () => {
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
    hotkeys: {
      on() {},
      async start() {},
      async stop() {
        calls.push('hotkeys.stop');
      },
    },
    executor,
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.stop();

  assert.deepEqual(calls, ['hotkeys.stop', 'executor.stop', 'hub.stop', 'obs.disconnect']);
});

test('coordinator publishes sticky presentation state for scene-only slides', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Full Slide']);
  assert.equal(hub.state.stickyPublishes.length, 1);
  assert.deepEqual(hub.state.stickyPublishes[0], {
    channel: 'presentationState',
    payload: {
      type: 'presentationState',
      seq: 1,
      slideId: 'intro',
      layoutId: 'full-slide',
      audienceScene: 'Full Slide',
      slots: [
        {
          source: 'Slide',
          position: 'full',
          rect: { x: 0, y: 0, w: 1800, h: 1168 },
        },
      ],
      windowBindings: {
        Slide: { app: 'Google Chrome' },
      },
      focus: null,
      script: null,
      commands: [],
    },
  });
  assert.deepEqual(executor.state.executedCommands, []);
});

test('coordinator dispatches typed slide commands through the injected executor', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Dual Browser']);
  assert.equal(hub.state.stickyPublishes[0].payload.seq, 1);
  assert.deepEqual(executor.state.executedCommands, [
    { type: 'activateTab', source: 'BrowserA', tab: 'checkout' },
    { type: 'navigate', source: 'BrowserB', tab: 'main', url: 'https://example.com/other-app' },
  ]);
  assert.deepEqual(hub.state.sentDriverCommands, []);
});

test('coordinator warns on unknown slide ids without crashing', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'missing', index: { h: 9, v: 0 }, meta: {} });

  assert.equal(obs.state.scenes.length, 0);
  assert.equal(hub.state.stickyPublishes.length, 0);
  assert.match(logger.warns[0].message, /No slide actions configured/i);
});

test('coordinator continues after observer publish failure', async () => {
  const logger = createLogger();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const hub = {
    handlers: new Map(),
    on(eventName, handler) {
      this.handlers.set(eventName, handler);
    },
    async start() {},
    async stop() {},
    async sendCommand() {},
    async publishSticky() {
      throw new Error('observer offline');
    },
    async emitPosition(payload) {
      return this.handlers.get('driverPositionChanged')?.(payload);
    },
    getSnapshot() {
      return { activeDriver: null, observers: [], sticky: {} };
    },
  };
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor, logger });

  await coordinator.start();
  await hub.emitPosition({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Dual Browser']);
  assert.equal(executor.state.executedCommands.length, 2);
  assert.match(logger.errors[0].message, /Observer state publish failed/i);
});

test('coordinator republishes sticky presentation state when observer window bindings change', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  await hub.emit('observerWindowBindings', {
    bindings: {
      BrowserA: {
        app: 'Google Chrome',
        pid: 47213,
        macWindowId: 12345,
        strict: true,
      },
    },
    cleared: [],
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  assert.equal(hub.state.stickyPublishes.length, 2);
  assert.equal(hub.state.stickyPublishes[1].payload.seq, 2);
  assert.deepEqual(hub.state.stickyPublishes[1].payload.windowBindings, {
    BrowserA: {
      app: 'Google Chrome',
      titleIncludes: 'Primary',
      pid: 47213,
      macWindowId: 12345,
      strict: true,
    },
    BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
  });
  assert.deepEqual(obs.state.scenes, ['Dual Browser']);
});

test('coordinator clears runtime window binding overrides and republishes bootstrap selectors', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  await hub.emit('observerWindowBindings', {
    bindings: {
      BrowserA: {
        app: 'Google Chrome',
        pid: 47213,
        macWindowId: 12345,
        strict: true,
      },
    },
    cleared: [],
    sender: { role: 'observer', sessionId: 'observer-1' },
  });
  await hub.emit('observerWindowBindings', {
    bindings: {},
    cleared: ['BrowserA'],
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  assert.equal(hub.state.stickyPublishes.length, 3);
  assert.equal(hub.state.stickyPublishes[2].payload.seq, 3);
  assert.deepEqual(hub.state.stickyPublishes[2].payload.windowBindings, {
    BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
    BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
  });
});

test('coordinator continues after partial executor failures', async () => {
  const logger = createLogger();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const hub = createFakeHub();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor, logger });

  await coordinator.start();
  executor.state.nextError = new Error('browser session degraded');
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Dual Browser']);
  assert.equal(executor.state.executedCommands.length, 2);
  assert.match(logger.errors[0].message, /Browser command failed/i);
});

test('coordinator routes next and prev hotkeys to the active driver boundary', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor, logger });

  await coordinator.start();
  await hotkeys.emit('action', { type: 'next' });
  await hotkeys.emit('action', { type: 'prev' });

  assert.deepEqual(hub.state.sentDriverCommands, [
    { target: { role: 'driver' }, command: { type: 'next' } },
    { target: { role: 'driver' }, command: { type: 'prev' } },
  ]);
});

test('coordinator runs without an executor for audience-only slides', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, executor: null, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Full Slide']);
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
    hotkeys: {
      on() {},
      async start() {
        calls.push('hotkeys.start');
        throw new Error('native start failed');
      },
      async stop() {
        calls.push('hotkeys.stop');
      },
    },
    logger: createLogger(),
  });

  await assert.rejects(() => coordinator.start(), /native start failed/i);
  assert.deepEqual(calls, [
    'obs.connect',
    'hub.start',
    'executor.start',
    'hotkeys.start',
    'executor.stop',
    'hub.stop',
    'obs.disconnect',
  ]);
});
