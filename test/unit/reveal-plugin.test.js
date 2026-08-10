import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const pluginPath = new URL('../../reveal/deckhand-plugin.js', import.meta.url);

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(eventName, handler) {
    const handlers = this.listeners.get(eventName) ?? [];
    handlers.push(handler);
    this.listeners.set(eventName, handlers);
  }

  dispatch(eventName, event = {}) {
    for (const handler of this.listeners.get(eventName) ?? []) {
      handler(event);
    }
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open');
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }
}

function createDeck() {
  const handlers = new Map();
  const currentSlide = { dataset: { deckhandId: 'welcome' }, __deckhandIndices: { h: 0, v: 0 } };

  return {
    currentSlide,
    handlers,
    getCurrentSlide() {
      return currentSlide;
    },
    getIndices(slide) {
      if (slide && slide.__deckhandIndices) {
        return slide.__deckhandIndices;
      }

      return { h: 0, v: 0 };
    },
    next() {},
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    prev() {},
    slide() {},
  };
}

test('reveal plugin reports the current slide after websocket open even when reveal ready fired earlier', async () => {
  FakeWebSocket.instances = [];
  const source = await readFile(pluginPath, 'utf8');
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, '.slides section');
      return [{ dataset: { deckhandId: 'welcome' } }];
    },
  };
  const context = {
    console: {
      info() {},
      log() {},
      warn() {},
    },
    clearTimeout,
    document,
    setTimeout,
    window: {
      WebSocket: FakeWebSocket,
    },
  };

  vm.runInNewContext(source, context);

  const plugin = context.window.DeckhandRevealPlugin({ hubUrl: 'ws://127.0.0.1:8765' });
  const deck = createDeck();
  plugin.init(deck);

  deck.handlers.get('ready')({
    currentSlide: deck.currentSlide,
    indexh: 0,
    indexv: 0,
  });

  const socket = FakeWebSocket.instances[0];
  socket.open();

  assert.deepEqual(socket.sent, [
    {
      type: 'register',
      role: 'driver',
      capabilities: ['next', 'prev', 'goTo'],
    },
  ]);

  socket.dispatch('message', {
    data: JSON.stringify({
      type: 'registered',
      role: 'driver',
      sessionId: 'driver-1',
    }),
  });

  assert.deepEqual(socket.sent, [
    {
      type: 'register',
      role: 'driver',
      capabilities: ['next', 'prev', 'goTo'],
    },
    {
      type: 'slideManifest',
      slides: [
        {
          id: 'welcome',
          index: { h: 0, v: 0 },
        },
      ],
    },
    {
      type: 'positionChanged',
      position: {
        id: 'welcome',
        index: { h: 0, v: 0 },
        meta: { idSource: 'data-deckhand-id', indexh: 0, indexv: 0, driverEventId: 1 },
      },
    },
  ]);
});

test('reveal plugin publishes an ordered slide manifest with stable ids and headings before current position', async () => {
  FakeWebSocket.instances = [];
  const source = await readFile(pluginPath, 'utf8');
  const slides = [
    {
      dataset: { deckhandId: 'intro' },
      __deckhandIndices: { h: 0, v: 0 },
      querySelector(selector) {
        assert.match(selector, /^h1, h2, h3, h4, h5, h6$/);
        return { textContent: 'Intro' };
      },
    },
    {
      dataset: {},
      __deckhandIndices: { h: 1, v: 0 },
      querySelector(selector) {
        assert.match(selector, /^h1, h2, h3, h4, h5, h6$/);
        return { textContent: 'Details' };
      },
    },
    {
      dataset: { deckhandId: 'closing' },
      __deckhandIndices: { h: 2, v: 0 },
      querySelector() {
        return null;
      },
    },
  ];
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, '.slides section');
      return slides;
    },
  };
  const context = {
    console: {
      info() {},
      log() {},
      warn() {},
    },
    clearTimeout,
    document,
    setTimeout,
    window: {
      WebSocket: FakeWebSocket,
    },
  };

  vm.runInNewContext(source, context);

  const plugin = context.window.DeckhandRevealPlugin({ hubUrl: 'ws://127.0.0.1:8765' });
  const deck = createDeck();
  plugin.init(deck);

  deck.handlers.get('ready')({
    currentSlide: deck.currentSlide,
    indexh: 0,
    indexv: 0,
  });

  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.dispatch('message', {
    data: JSON.stringify({
      type: 'registered',
      role: 'driver',
      sessionId: 'driver-1',
    }),
  });

  assert.deepEqual(socket.sent.slice(1), [
    {
      type: 'slideManifest',
      slides: [
        {
          id: 'intro',
          index: { h: 0, v: 0 },
          heading: 'Intro',
        },
        {
          id: '1.0',
          index: { h: 1, v: 0 },
          heading: 'Details',
        },
        {
          id: 'closing',
          index: { h: 2, v: 0 },
        },
      ],
    },
    {
      type: 'positionChanged',
      position: {
        id: 'welcome',
        index: { h: 0, v: 0 },
        meta: { idSource: 'data-deckhand-id', indexh: 0, indexv: 0, driverEventId: 1 },
      },
    },
  ]);
});

test('reveal plugin republishes the slide manifest when the driver reconnects', async () => {
  FakeWebSocket.instances = [];
  const source = await readFile(pluginPath, 'utf8');
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, '.slides section');
      return [
        {
          dataset: { deckhandId: 'welcome' },
          __deckhandIndices: { h: 0, v: 0 },
          querySelector() {
            return { textContent: 'Welcome' };
          },
        },
      ];
    },
  };
  const scheduled = [];
  const context = {
    console: {
      info() {},
      log() {},
      warn() {},
    },
    clearTimeout() {},
    document,
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    window: {
      WebSocket: FakeWebSocket,
    },
  };

  vm.runInNewContext(source, context);

  const plugin = context.window.DeckhandRevealPlugin({
    hubUrl: 'ws://127.0.0.1:8765',
    reconnectDelayMs: 5,
  });
  const deck = createDeck();
  plugin.init(deck);

  deck.handlers.get('ready')({
    currentSlide: deck.currentSlide,
    indexh: 0,
    indexv: 0,
  });

  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();
  firstSocket.dispatch('message', {
    data: JSON.stringify({
      type: 'registered',
      role: 'driver',
      sessionId: 'driver-1',
    }),
  });

  firstSocket.readyState = FakeWebSocket.CLOSED;
  firstSocket.dispatch('close');
  while (scheduled.length > 0 && FakeWebSocket.instances.length === 1) {
    scheduled.shift()();
  }

  const secondSocket = FakeWebSocket.instances[1];
  secondSocket.open();
  secondSocket.dispatch('message', {
    data: JSON.stringify({
      type: 'registered',
      role: 'driver',
      sessionId: 'driver-2',
    }),
  });

  assert.deepEqual(secondSocket.sent, [
    {
      type: 'register',
      role: 'driver',
      capabilities: ['next', 'prev', 'goTo'],
    },
    {
      type: 'slideManifest',
      slides: [
        {
          id: 'welcome',
          index: { h: 0, v: 0 },
          heading: 'Welcome',
        },
      ],
    },
    {
      type: 'positionChanged',
      position: {
        id: 'welcome',
        index: { h: 0, v: 0 },
        meta: { idSource: 'data-deckhand-id', indexh: 0, indexv: 0, driverEventId: 1 },
      },
    },
  ]);
});

test('reveal plugin emits a position-settled ack after the slide has painted', async () => {
  FakeWebSocket.instances = [];
  const source = await readFile(pluginPath, 'utf8');
  const rafQueue = [];
  const context = {
    console: {
      info() {},
      log() {},
      warn() {},
    },
    clearTimeout,
    document: {
      querySelectorAll() {
        return [];
      },
    },
    setTimeout,
    window: {
      WebSocket: FakeWebSocket,
      requestAnimationFrame(callback) {
        rafQueue.push(callback);
        return rafQueue.length;
      },
    },
  };

  vm.runInNewContext(source, context);

  const plugin = context.window.DeckhandRevealPlugin({ hubUrl: 'ws://127.0.0.1:8765' });
  const deck = createDeck();
  plugin.init(deck);

  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.dispatch('message', {
    data: JSON.stringify({
      type: 'registered',
      role: 'driver',
      sessionId: 'driver-1',
    }),
  });

  socket.sent.length = 0;
  deck.handlers.get('slidechanged')({
    currentSlide: { dataset: { deckhandId: 'demo' } },
    indexh: 1,
    indexv: 0,
  });

  assert.deepEqual(socket.sent, [
    {
      type: 'positionChanged',
      position: {
        id: 'demo',
        index: { h: 1, v: 0 },
        meta: { idSource: 'data-deckhand-id', indexh: 1, indexv: 0, driverEventId: 2 },
      },
    },
  ]);

  const flushRaf = () => {
    const callbacks = rafQueue.splice(0);
    callbacks.forEach((callback) => callback());
  };

  flushRaf();
  assert.equal(socket.sent.length, 1);

  flushRaf();
  assert.deepEqual(socket.sent[1], {
    type: 'positionSettled',
    eventId: 2,
  });
});
