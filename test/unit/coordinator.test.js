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
      Slide: { id: 'Slide', kind: 'browser' },
      BrowserA: { id: 'BrowserA', kind: 'browser' },
      BrowserB: { id: 'BrowserB', kind: 'browser' },
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
          {
            type: 'navigate',
            source: 'BrowserA',
            tab: 'tabA',
            url: 'https://example.com/step2',
          },
          {
            type: 'navigate',
            source: 'BrowserB',
            tab: null,
            url: 'https://example.com/other-app',
          },
        ],
      },
    },
    presenter: {
      platform: 'macos',
      stage: { x: 0, y: 0, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Safari' },
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
    sentCommands: [],
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
      state.sentCommands.push({ target, command });
    },
    async publishSticky(channel, payload) {
      state.stickyPublishes.push({ channel, payload });
    },
    getSnapshot() {
      return { activeDriver: null, observers: [], sticky: {}, targets: [] };
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

test('coordinator starts obs then hub then hotkeys', async () => {
  const calls = [];
  const logger = createLogger();
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
      return { activeDriver: null, observers: [], sticky: {}, targets: [] };
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

  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, logger });

  await coordinator.start();

  assert.deepEqual(calls, ['obs.connect', 'hub.start', 'hotkeys.start']);
  assert.match(logger.infos[0].message, /starting/i);
});

test('coordinator stops hotkeys then hub then obs', async () => {
  const calls = [];
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
        return { activeDriver: null, observers: [], sticky: {}, targets: [] };
      },
    },
    hotkeys: {
      on() {},
      async start() {},
      async stop() {
        calls.push('hotkeys.stop');
      },
    },
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.stop();

  assert.deepEqual(calls, ['hotkeys.stop', 'hub.stop', 'obs.disconnect']);
});

test('coordinator publishes sticky presentation state for scene-only slides', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, logger });

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
        Slide: { app: 'Safari' },
      },
      focus: null,
      script: null,
      commands: [],
    },
  });
  assert.deepEqual(hub.state.sentCommands, []);
});

test('coordinator publishes state and multiple target commands for a slide', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Dual Browser']);
  assert.equal(hub.state.stickyPublishes[0].payload.seq, 1);
  assert.deepEqual(hub.state.sentCommands, [
    {
      target: { controllerId: 'BrowserA', tabId: 'tabA' },
      command: { type: 'navigate', url: 'https://example.com/step2' },
    },
    {
      target: { controllerId: 'BrowserB' },
      command: { type: 'navigate', url: 'https://example.com/other-app' },
    },
  ]);
});

test('coordinator warns on unknown slide ids without crashing', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, logger });

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
  const sent = [];
  const hub = {
    handlers: new Map(),
    on(eventName, handler) {
      this.handlers.set(eventName, handler);
    },
    async start() {},
    async stop() {},
    async sendCommand(target, command) {
      sent.push({ target, command });
    },
    async publishSticky() {
      throw new Error('observer offline');
    },
    async emitPosition(payload) {
      return this.handlers.get('driverPositionChanged')?.(payload);
    },
    getSnapshot() {
      return { activeDriver: null, observers: [], sticky: {}, targets: [] };
    },
  };
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, logger });

  await coordinator.start();
  await hub.emitPosition({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Dual Browser']);
  assert.equal(sent.length, 2);
  assert.match(logger.errors[0].message, /Observer state publish failed/i);
});

test('coordinator continues after partial command failures', async () => {
  const logger = createLogger();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const sent = [];
  const hub = {
    handlers: new Map(),
    on(eventName, handler) {
      this.handlers.set(eventName, handler);
    },
    async start() {},
    async stop() {},
    async sendCommand(target, command) {
      sent.push({ target, command });
      if (target.controllerId === 'BrowserA') {
        throw new Error('tab offline');
      }
    },
    async publishSticky() {},
    async emitPosition(payload) {
      return this.handlers.get('driverPositionChanged')?.(payload);
    },
    getSnapshot() {
      return { activeDriver: null, observers: [], sticky: {}, targets: [] };
    },
  };
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, logger });

  await coordinator.start();
  await hub.emitPosition({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Dual Browser']);
  assert.equal(sent.length, 2);
  assert.match(logger.errors[0].message, /Target command failed/i);
});

test('coordinator routes next and prev hotkeys to the active driver boundary', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const hotkeys = createFakeHotkeys();
  const obs = createFakeObs();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, hotkeys, logger });

  await coordinator.start();
  await hotkeys.emit('action', { type: 'next' });
  await hotkeys.emit('action', { type: 'prev' });

  assert.deepEqual(hub.state.sentCommands, [
    { target: { role: 'driver' }, command: { type: 'next' } },
    { target: { role: 'driver' }, command: { type: 'prev' } },
  ]);
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
        return { activeDriver: null, observers: [], sticky: {}, targets: [] };
      },
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
  assert.deepEqual(calls, ['obs.connect', 'hub.start', 'hotkeys.start', 'hub.stop', 'obs.disconnect']);
});
