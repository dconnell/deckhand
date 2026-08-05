import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';

import WebSocket from 'ws';

import { createCoordinator } from '../../src/coordinator.js';
import { createHub } from '../../src/hub.js';

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

function createConfig(port) {
  return {
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { host: '127.0.0.1', port },
    sources: {
      Slide: {
        id: 'Slide',
        kind: 'browser',
        browser: { windowLabel: 'slide', tabs: { deck: { url: 'http://deck/', preload: true } }, initialTab: 'deck' },
      },
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
      BrowserB: {
        id: 'BrowserB',
        kind: 'browser',
        browser: {
          windowLabel: 'browser-b',
          tabs: { main: { url: 'https://example.com/other', preload: true } },
          initialTab: 'main',
        },
      },
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
      'id.p16': {
        layoutId: 'dual-browser',
        focus: 'BrowserB',
        script: 'BrowserA goes left. BrowserB goes right.',
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
        Presenter: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
      },
      stt: null,
      teleprompter: {
        followEnabledByDefault: true,
        window: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
      },
      http: { host: '127.0.0.1', port: 3001 },
    },
  };
}

async function createClient(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  const messages = [];
  socket.on('message', (buffer) => {
    messages.push(JSON.parse(String(buffer)));
  });

  return {
    socket,
    messages,
    async send(payload) {
      socket.send(JSON.stringify(payload));
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    async close() {
      socket.close();
      await once(socket, 'close');
    },
  };
}

async function flushMessages() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('coordinator integration publishes presentation state and dispatches browser commands', async () => {
  const logger = createLogger();
  const obsCalls = [];
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });
  await hub.start();

  const port = hub.getAddress().port;

  const executedCommands = [];
  const executor = {
    async start() {},
    async stop() {},
    async execute(command) {
      executedCommands.push(command);
    },
  };

  const coordinator = createCoordinator({
    config: createConfig(port),
    obs: {
      async connect() {},
      async disconnect() {},
      async setScene(sceneName) {
        obsCalls.push(sceneName);
      },
      isConnected() {
        return true;
      },
    },
    hub,
    executor,
    logger,
  });

  const driver = await createClient(port);
  const observer = await createClient(port);

  try {
    await coordinator.start();
    await driver.send({ type: 'register', role: 'driver', capabilities: ['next', 'prev', 'goTo'] });
    await observer.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });

    await driver.send({
      type: 'positionChanged',
      position: {
        id: 'id.p16',
        index: { h: 15, v: 0 },
        meta: { indexh: 15, indexv: 0 },
      },
    });
    await flushMessages();

    assert.deepEqual(obsCalls, ['Deckhand_Dual Browser']);
    assert.deepEqual(executedCommands, [
      { type: 'activateTab', source: 'BrowserA', tab: 'checkout' },
      { type: 'navigate', source: 'BrowserB', tab: 'main', url: 'https://example.com/other-app' },
    ]);

    assert.deepEqual(observer.messages.filter((message) => message.type === 'presentationState'), [
      {
        type: 'presentationState',
        seq: 1,
        slideId: 'id.p16',
        layoutId: 'dual-browser',
        audienceScene: 'Dual Browser',
        slots: [
          {
            source: 'BrowserA',
            position: 'left',
            rect: { x: 0, y: 0, w: 900, h: 1168 },
          },
          {
            source: 'BrowserB',
            position: 'right',
            rect: { x: 900, y: 0, w: 900, h: 1168 },
          },
        ],
        windowBindings: {
          BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
          BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
        },
        managedWindowBindings: {
          Slide: { app: 'Google Chrome' },
          BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
          BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
          Presenter: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
        },
        focus: 'BrowserB',
        script: 'BrowserA goes left. BrowserB goes right.',
      },
    ]);
  } finally {
    await Promise.all([driver.close(), observer.close()]);
    await coordinator.stop();
    await hub.stop();
  }
});
