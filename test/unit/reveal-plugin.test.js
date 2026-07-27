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
  const currentSlide = { dataset: { deckhandId: 'welcome' } };

  return {
    currentSlide,
    handlers,
    getCurrentSlide() {
      return currentSlide;
    },
    getIndices() {
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
      type: 'positionChanged',
      position: {
        id: 'welcome',
        index: { h: 0, v: 0 },
        meta: { idSource: 'data-deckhand-id', indexh: 0, indexv: 0 },
      },
    },
  ]);
});
