import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSlideDirection, createCoordinator, extractSlideIndex } from '../../src/coordinator.js';

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

function createFakeObs() {
  const state = { connected: false, disconnected: false, scenes: [], inputSettings: [] };

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
    async applyInputSettings(inputName, inputSettings) {
      state.inputSettings.push({ inputName, inputSettings });
    },
    isConnected() {
      return state.connected;
    },
  };
}

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

test('coordinator publishes sticky presentation state for scene-only slides', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), getManagedBrowserPid: () => 47213, obs, hub, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Deckhand_Full Slide']);
  assert.deepEqual(obs.state.inputSettings, [
    {
      inputName: 'Deckhand_Slide',
      inputSettings: {
        owner_name: 'Google Chrome',
        owner_pid: 47213,
        window: 0,
      },
    },
  ]);
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
      managedWindowBindings: {
        Slide: { app: 'Google Chrome' },
        BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
        BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
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
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), getManagedBrowserPid: () => 47213, obs, hub, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Deckhand_Dual Browser']);
  assert.equal(hub.state.stickyPublishes[0].payload.seq, 1);
  assert.deepEqual(obs.state.inputSettings, [
    {
      inputName: 'Deckhand_BrowserA',
      inputSettings: {
        owner_name: 'Google Chrome',
        window_name: 'Primary',
        owner_pid: 47213,
        window: 0,
      },
    },
    {
      inputName: 'Deckhand_BrowserB',
      inputSettings: {
        owner_name: 'Google Chrome',
        window_name: 'Secondary',
        owner_pid: 47213,
        window: 0,
      },
    },
  ]);
  assert.deepEqual(executor.state.executedCommands, [
    { type: 'activateTab', source: 'BrowserA', tab: 'checkout' },
    { type: 'navigate', source: 'BrowserB', tab: 'main', url: 'https://example.com/other-app' },
  ]);
  assert.deepEqual(hub.state.sentDriverCommands, []);
});

test('coordinator warns on unknown slide ids without crashing', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), getManagedBrowserPid: () => 47213, obs, hub, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'missing', index: { h: 9, v: 0 }, meta: {} });

  assert.equal(obs.state.scenes.length, 0);
  assert.equal(hub.state.stickyPublishes.length, 0);
  assert.match(logger.warns[0].message, /No slide actions configured/i);
});

test('coordinator continues after observer publish failure', async () => {
  const logger = createLogger();
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
  const coordinator = createCoordinator({ config: createConfig(), getManagedBrowserPid: () => 47213, obs, hub, executor, logger });

  await coordinator.start();
  await hub.emitPosition({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Deckhand_Dual Browser']);
  assert.equal(executor.state.executedCommands.length, 2);
  assert.match(logger.errors[0].message, /Observer state publish failed/i);
});

test('coordinator republishes sticky presentation state when observer window bindings change', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor, logger });

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
  assert.deepEqual(obs.state.inputSettings.at(-2), {
    inputName: 'Deckhand_BrowserA',
    inputSettings: {
      owner_name: 'Google Chrome',
      window_name: 'Primary',
      owner_pid: 47213,
      window: 12345,
    },
  });
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
  assert.deepEqual(obs.state.scenes, ['Deckhand_Dual Browser']);
});

test('coordinator clears runtime window binding overrides and republishes bootstrap selectors', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor, logger });

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
  assert.deepEqual(obs.state.inputSettings.at(-2), {
    inputName: 'Deckhand_BrowserA',
    inputSettings: {
      owner_name: 'Google Chrome',
      window_name: 'Primary',
      window: 0,
    },
  });
  assert.deepEqual(hub.state.stickyPublishes[2].payload.windowBindings, {
    BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
    BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
  });
});

test('coordinator ignores observer window bindings for non-browser sources', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const config = createConfig();
  config.sources.TerminalA = { id: 'TerminalA', kind: 'iterm2' };
  config.layouts['full-terminal-a'] = {
    id: 'full-terminal-a',
    audienceScene: 'Full Terminal A',
    slots: [{ source: 'TerminalA', position: 'full' }],
    sources: ['TerminalA'],
  };
  config.slides.terminal = {
    layoutId: 'full-terminal-a',
    focus: 'TerminalA',
    script: null,
    commands: [],
  };

  const coordinator = createCoordinator({ config, obs, hub, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'terminal', index: { h: 2, v: 0 }, meta: {} });

  const initialPublishes = hub.state.stickyPublishes.length;
  assert.equal(initialPublishes, 1);

  await hub.emit('observerWindowBindings', {
    bindings: {
      TerminalA: {
        app: 'iTerm',
        pid: 626,
        macWindowId: 99999,
        strict: true,
      },
    },
    cleared: [],
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  assert.equal(hub.state.stickyPublishes.length, initialPublishes);
  assert.equal(
    obs.state.inputSettings.some((entry) => entry.inputName === 'Deckhand_TerminalA' && entry.inputSettings.window === 99999),
    false,
  );
});

test('coordinator continues after partial executor failures', async () => {
  const logger = createLogger();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const hub = createFakeHub();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor, logger });

  await coordinator.start();
  executor.state.nextError = new Error('browser session degraded');
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Deckhand_Dual Browser']);
  assert.equal(executor.state.executedCommands.length, 2);
  assert.match(logger.errors[0].message, /Browser command failed/i);
});

test('coordinator runs without an executor for audience-only slides', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor: null, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Deckhand_Full Slide']);
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

test('extractSlideIndex returns a comparable h/v index, or null when absent', () => {
  assert.deepEqual(extractSlideIndex({ index: { h: 2, v: 1 } }), { h: 2, v: 1 });
  assert.deepEqual(extractSlideIndex({ index: { h: 0 } }), { h: 0, v: 0 });
  assert.equal(extractSlideIndex({ index: { v: 1 } }), null);
  assert.equal(extractSlideIndex({}), null);
  assert.equal(extractSlideIndex(null), null);
});

test('computeSlideDirection classifies forward, backward, and neutral jumps', () => {
  assert.equal(computeSlideDirection({ h: 0, v: 0 }, { h: 1, v: 0 }), 'forward');
  assert.equal(computeSlideDirection({ h: 1, v: 0 }, { h: 0, v: 0 }), 'backward');
  assert.equal(computeSlideDirection({ h: 1, v: 0 }, { h: 1, v: 2 }), 'forward');
  assert.equal(computeSlideDirection({ h: 1, v: 2 }, { h: 1, v: 0 }), 'backward');
  assert.equal(computeSlideDirection({ h: 2, v: 0 }, { h: 2, v: 0 }), 'none');
  assert.equal(computeSlideDirection(null, { h: 0, v: 0 }), 'none');
});

function createTransitionsConfig(overrides = {}) {
  const config = createConfig();
  config.obs.transitions = {
    forward: 'Slide Right',
    backward: 'Slide Left',
    freezeScene: 'Freeze',
    freezeImage: 'Freeze Frame',
    settleMs: 1,
    navigationWaitMs: 1,
    durationMs: 50,
    ...overrides,
  };
  return config;
}

function createTracingHub(trace) {
  const handlers = new Map();
  return {
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    emit(eventName, payload) {
      return handlers.get(eventName)?.(payload);
    },
    async start() {},
    async stop() {},
    async sendCommand() {},
    async publishSticky() {
      trace.push('publishSticky');
    },
    getSnapshot() {
      return { activeDriver: null, observers: [], sticky: {} };
    },
  };
}

function createTracingObs(trace, { failCapture = false } = {}) {
  return {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    async setScene(name) {
      trace.push(`setScene:${name}`);
    },
    async applyInputSettings(name) {
      trace.push(`applyInputSettings:${name}`);
    },
    async getCurrentTransitionName() {
      trace.push('getCurrentTransitionName');
      return 'Fade';
    },
    async captureProgramScreenshot() {
      trace.push('captureProgramScreenshot');

      if (failCapture) {
        throw new Error('screenshot failed');
      }
    },
    async setCurrentTransition(name) {
      trace.push(`setCurrentTransition:${name}`);
    },
    async switchProgramScene(name) {
      trace.push(`switchProgramScene:${name}`);
    },
    async ensureFreezeAssets() {
      trace.push('ensureFreezeAssets');
    },
  };
}

function createTracingExecutor(trace) {
  return {
    async start() {},
    async stop() {},
    async execute(command) {
      trace.push(`execute:${command.type}`);
    },
  };
}

test('coordinator ensures freeze assets at startup when transitions are configured', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();

  assert.ok(trace.includes('ensureFreezeAssets'));
});

test('coordinator runs freeze -> mutate -> directional reveal for a forward jump', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  const freezeIndex = trace.indexOf('switchProgramScene:Freeze');
  const revealIndex = trace.indexOf('switchProgramScene:Deckhand_Dual Browser');
  const publishIndex = trace.indexOf('publishSticky');

  assert.ok(freezeIndex !== -1 && revealIndex !== -1, 'freeze and reveal scene switches both occur');
  assert.ok(freezeIndex < publishIndex, 'state publishes only after the freeze scene is showing');
  assert.ok(publishIndex < revealIndex, 'dirty work completes before the reveal');

  assert.ok(trace.includes('captureProgramScreenshot'), 'captures the outgoing frame');
  assert.ok(trace.includes('applyInputSettings:Freeze Frame'), 'loads the freeze image source');
  assert.ok(trace.includes('setCurrentTransition:Cut'), 'cuts to the freeze instantly');
  assert.ok(trace.includes('setCurrentTransition:Slide Right'), 'reveals with the forward transition');

  const cutIndex = trace.indexOf('setCurrentTransition:Cut');
  const forwardIndex = trace.indexOf('setCurrentTransition:Slide Right');
  assert.ok(cutIndex < forwardIndex, 'cut happens before the directional reveal');
});

test('coordinator picks the backward transition for a prev jump and restores the operator transition', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 2, v: 0 }, meta: {} });
  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });

  assert.ok(trace.includes('setCurrentTransition:Slide Left'), 'reveals with the backward transition');
  assert.ok(trace.includes('setCurrentTransition:Fade'), 'restores the captured operator transition');
  const restoreIndex = trace.lastIndexOf('setCurrentTransition:Fade');
  const revealIndex = trace.indexOf('switchProgramScene:Deckhand_Full Slide');
  assert.ok(restoreIndex > revealIndex, 'transition is restored after the reveal');
});

test('coordinator waits the navigation cap behind the freeze for slides with navigate commands', async () => {
  let observedWait = 0;
  const config = createTransitionsConfig({ navigationWaitMs: 7, settleMs: 1 });
  const obs = {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    async applyInputSettings() {},
    async getCurrentTransitionName() {
      return 'Fade';
    },
    async captureProgramScreenshot() {},
    async setCurrentTransition() {},
    async switchProgramScene() {},
    async ensureFreezeAssets() {},
  };
  const realSetTimeout = setTimeout;
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    observedWait = Math.max(observedWait, ms);
    return realSetTimeout(fn, ms);
  };
  try {
    const coordinator = createCoordinator({
      config,
      obs,
      hub: createTracingHub([]),
      executor: createTracingExecutor([]),
      logger: createLogger(),
    });

    await coordinator.start();
    await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

    assert.ok(observedWait >= 7, 'uses the navigation wait for slides that navigate');
  } finally {
    globalThis.setTimeout = original;
  }
});

test('coordinator treats a freeze capture failure as best-effort and still reveals the target', async () => {
  const trace = [];
  const logger = createLogger();
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs: createTracingObs(trace, { failCapture: true }),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'still reveals the target scene');
  assert.ok(trace.includes('setCurrentTransition:Fade'), 'restores the operator transition');
  assert.ok(logger.warns.some((entry) => /arm freeze frame/i.test(entry.message)), 'warns about the failed freeze arm');
});

test('coordinator falls back to a direct scene switch when the reveal itself fails', async () => {
  const trace = [];
  const logger = createLogger();
  const obs = createTracingObs(trace);
  // The reveal switch passes { waitForEvent: true }; the fallback passes none.
  const realSwitch = obs.switchProgramScene;
  obs.switchProgramScene = async (name, opts) => {
    if (opts && opts.waitForEvent && name === 'Deckhand_Dual Browser') {
      throw new Error('reveal rejected');
    }

    return realSwitch(name);
  };

  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs,
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'attempts the reveal');
  assert.ok(trace.includes('setCurrentTransition:Fade'), 'restores the operator transition after failure');
  assert.ok(logger.errors.some((entry) => /Slide transition failed/i.test(entry.message)), 'logs the transition failure');
});
