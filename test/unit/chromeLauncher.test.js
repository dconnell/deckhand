import assert from 'node:assert/strict';
import test from 'node:test';

import { createWsTransport, discoverCdpEndpoint } from '../../src/chromeLauncher.js';

class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.sent = [];
    this.closed = false;
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  send(raw) {
    this.sent.push(raw);
  }

  close() {
    this.closed = true;
    this.handlers.get('close')?.forEach((handler) => handler());
  }

  emit(event, payload) {
    this.handlers.get(event)?.forEach((handler) => handler(payload));
  }
}

test('discoverCdpEndpoint returns the webSocketDebuggerUrl from /json/version', async () => {
  const calls = [];

  const result = await discoverCdpEndpoint({
    debugPort: 9222,
    retries: 1,
    retryDelayMs: 0,
    fetchFn: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
      }), { status: 200 });
    },
  });

  assert.deepEqual(calls, ['http://127.0.0.1:9222/json/version']);
  assert.deepEqual(result, {
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    chromePid: null,
  });
});

test('discoverCdpEndpoint retries until the endpoint becomes reachable', async () => {
  let attempts = 0;

  const result = await discoverCdpEndpoint({
    debugPort: 9333,
    retries: 5,
    retryDelayMs: 0,
    fetchFn: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('connect ECONNREFUSED');
      }
      return new Response(JSON.stringify({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/xyz',
      }), { status: 200 });
    },
  });

  assert.equal(attempts, 3);
  assert.equal(result.webSocketDebuggerUrl, 'ws://127.0.0.1:9333/devtools/browser/xyz');
});

test('discoverCdpEndpoint rejects after exhausting retries', async () => {
  await assert.rejects(
    discoverCdpEndpoint({
      debugPort: 9444,
      retries: 2,
      retryDelayMs: 0,
      fetchFn: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    }),
    /could not reach chrome devtools/i,
  );
});

test('createWsTransport forwards CDP frames and close events through the contract', async () => {
  const fake = {
    handlers: new Map(),
    sent: [],
    closed: false,
    on(event, handler) {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
    },
    send(raw) {
      this.sent.push(raw);
    },
    close() {
      this.closed = true;
      this.handlers.get('close')?.forEach((handler) => handler());
    },
    emit(event, payload) {
      this.handlers.get(event)?.forEach((handler) => handler(payload));
    },
  };

  const transport = createWsTransport({
    url: 'ws://127.0.0.1:9222/devtools/browser/abc',
    WebSocketClass: class {
      constructor() {
        Object.assign(this, fake);
      }
    },
  });

  const messages = [];
  const closes = [];

  transport.on('message', (raw) => messages.push(raw));
  transport.on('close', () => closes.push('closed'));

  transport.send('{"id":1,"method":"Target.getTargets"}');
  fake.emit('message', '{"id":1,"result":{}}');
  fake.emit('close');

  assert.deepEqual(fake.sent, ['{"id":1,"method":"Target.getTargets"}']);
  assert.deepEqual(messages, ['{"id":1,"result":{}}']);
  assert.deepEqual(closes, ['closed']);
});

test('createWsTransport exposes readiness that resolves on socket open', async () => {
  const fake = {
    handlers: new Map(),
    sent: [],
    closed: false,
    on(event, handler) {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
    },
    send(raw) {
      this.sent.push(raw);
    },
    close() {
      this.closed = true;
      this.handlers.get('close')?.forEach((handler) => handler());
    },
    emit(event, payload) {
      this.handlers.get(event)?.forEach((handler) => handler(payload));
    },
  };

  const transport = createWsTransport({
    url: 'ws://127.0.0.1:9222/devtools/browser/abc',
    WebSocketClass: class {
      constructor() {
        Object.assign(this, fake);
      }
    },
  });

  const ready = transport.waitUntilReady();
  fake.emit('open');

  await assert.doesNotReject(ready);
});
