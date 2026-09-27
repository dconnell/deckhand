import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoordinator } from '../../../src/coordinator.js';
import {
  createConfig,
  createFakeExecutor,
  createFakeHub,
  createFakeObs,
  createLogger,
  listPublishesByChannel,
} from '../../helpers/coordinatorFixtures.js';

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
  assert.equal(listPublishesByChannel(hub, 'presentationState').length, 1);
  assert.ok(listPublishesByChannel(hub, 'presenterState').length >= 1, 'the presenter state is published alongside the presentation state');
  assert.deepEqual(listPublishesByChannel(hub, 'presentationState')[0], {
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
  assert.equal(listPublishesByChannel(hub, 'presentationState')[0].payload.seq, 1);
  assert.equal(listPublishesByChannel(hub, 'presenterState').at(-1).payload.presentationSeq, 1);
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
  assert.equal(listPublishesByChannel(hub, 'presentationState').length, 0);
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
    async publishSticky(channel) {
      if (channel === 'presenterState') {
        return;
      }
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

  assert.equal(listPublishesByChannel(hub, 'presentationState').length, 2);
  assert.ok(listPublishesByChannel(hub, 'presenterState').length >= 2, 'the presenter state is republished with the updated bindings');
  assert.equal(listPublishesByChannel(hub, 'presentationState')[1].payload.seq, 2);
  assert.deepEqual(obs.state.inputSettings.at(-1), {
    inputName: 'Deckhand_BrowserA',
    inputSettings: {
      owner_name: 'Google Chrome',
      window_name: 'Primary',
      owner_pid: 47213,
      window: 12345,
    },
  });
  assert.deepEqual(listPublishesByChannel(hub, 'presentationState')[1].payload.windowBindings, {
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

  assert.equal(listPublishesByChannel(hub, 'presentationState').length, 3);
  assert.ok(listPublishesByChannel(hub, 'presenterState').length >= 3, 'the presenter state follows every binding republish');
  assert.equal(listPublishesByChannel(hub, 'presentationState')[2].payload.seq, 3);
  assert.deepEqual(obs.state.inputSettings.at(-1), {
    inputName: 'Deckhand_BrowserA',
    inputSettings: {
      owner_name: 'Google Chrome',
      window_name: 'Primary',
      window: 0,
    },
  });
  assert.deepEqual(listPublishesByChannel(hub, 'presentationState')[2].payload.windowBindings, {
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
  config.sources.TerminalA = { id: 'TerminalA', kind: 'app', app: 'iTerm2' };
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

  const initialPublishes = listPublishesByChannel(hub, 'presentationState').length;
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

  assert.equal(listPublishesByChannel(hub, 'presentationState').length, initialPublishes);
  assert.ok(
    !obs.state.inputSettings.some((entry) => entry.inputName === 'Deckhand_TerminalA' && entry.inputSettings.window === 99999),
    'the app source never receives OBS window bindings from observer updates',
  );
});
