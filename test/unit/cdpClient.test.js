import assert from 'node:assert/strict';
import test from 'node:test';

import { createCdpClient } from '../../src/cdpClient.js';

function createFakeTransport(options = {}) {
  const listeners = { message: new Set(), close: new Set(), error: new Set() };
  const sent = [];
  let closed = false;
  let ready = options.autoReady !== false;
  let resolveReady = null;
  let rejectReady = null;

  const readyPromise = ready
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

  return {
    sent,
    get closed() {
      return closed;
    },
    waitUntilReady() {
      return readyPromise;
    },
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close() {
      closed = true;
      rejectReady?.(new Error('transport closed before ready'));
      listeners.close.forEach((handler) => handler());
    },
    emit(payload) {
      listeners.message.forEach((handler) => handler(JSON.stringify(payload)));
    },
    emitReady() {
      if (ready) {
        return;
      }

      ready = true;
      resolveReady?.();
    },
    emitClose() {
      listeners.close.forEach((handler) => handler());
    },
    on(event, handler) {
      listeners[event]?.add(handler);
    },
  };
}

function createFakeDiscovery(result) {
  return async () => result;
}

function respondTo(transport, id, result) {
  transport.emit({ id, result });
}

function respondWithError(transport, id, errorMessage) {
  transport.emit({ id, error: { message: errorMessage } });
}

test('connect discovers the browser endpoint, opens the transport, and records the chrome pid', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://127.0.0.1:9232/devtools/browser/abc', chromePid: 47213 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  assert.equal(client.isConnected(), true);
  assert.equal(client.getChromePid(), 47213);
  assert.equal(transport.closed, false);
});

test('connect waits for the transport to become ready before reporting connected', async () => {
  const transport = createFakeTransport({ autoReady: false });
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://127.0.0.1:9232/devtools/browser/abc', chromePid: 47213 }),
    createTransport() {
      return transport;
    },
  });

  const pending = client.connect();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.isConnected(), false);

  transport.emitReady();
  await pending;

  assert.equal(client.isConnected(), true);
});

test('disconnect closes the transport and reports disconnected', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://127.0.0.1:9232/devtools/browser/abc', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();
  await client.disconnect();

  assert.equal(client.isConnected(), false);
  assert.equal(transport.closed, true);
});

test('createWindow creates a new-window target and resolves its targetId and windowId', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const pending = client.createWindow({ url: 'https://example.com/home' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[0], {
    id: 1,
    method: 'Target.createTarget',
    params: { url: 'https://example.com/home', newWindow: true },
  });

  respondTo(transport, 1, { targetId: 'TARGET_TAB_HOME' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[1], {
    id: 2,
    method: 'Browser.getWindowForTarget',
    params: { targetId: 'TARGET_TAB_HOME' },
  });

  respondTo(transport, 2, { windowId: 91 });

  assert.deepEqual(await pending, { targetId: 'TARGET_TAB_HOME', windowId: 91 });
});

test('createWindow forwards an initial size request when width and height are provided', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const pending = client.createWindow({
    url: 'https://example.com/teleprompter',
    width: 500,
    height: 700,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[0], {
    id: 1,
    method: 'Target.createTarget',
    params: {
      url: 'https://example.com/teleprompter',
      newWindow: true,
      width: 500,
      height: 700,
    },
  });

  respondTo(transport, 1, { targetId: 'TARGET_TAB_TELEPROMPTER' });
  await new Promise((resolve) => setImmediate(resolve));
  respondTo(transport, 2, { windowId: 92 });

  assert.deepEqual(await pending, { targetId: 'TARGET_TAB_TELEPROMPTER', windowId: 92 });
});

test('createTab creates a background target and resolves its targetId and owning windowId', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const windowPending = client.createWindow({ url: 'https://example.com/home' });
  await new Promise((resolve) => setImmediate(resolve));
  respondTo(transport, 1, { targetId: 'TARGET_TAB_HOME' });
  await new Promise((resolve) => setImmediate(resolve));
  respondTo(transport, 2, { windowId: 91 });
  await windowPending;

  const pending = client.createTab({ url: 'https://example.com/checkout' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[2], {
    id: 3,
    method: 'Target.createTarget',
    params: { url: 'https://example.com/checkout', background: true },
  });

  respondTo(transport, 3, { targetId: 'TARGET_TAB_CHECKOUT' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[3], {
    id: 4,
    method: 'Browser.getWindowForTarget',
    params: { targetId: 'TARGET_TAB_CHECKOUT' },
  });

  respondTo(transport, 4, { windowId: 91 });

  assert.deepEqual(await pending, { targetId: 'TARGET_TAB_CHECKOUT', windowId: 91 });
});

test('activateTab sends Target.activateTarget for the named handle', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const pending = client.activateTab({ targetId: 'TARGET_TAB_CHECKOUT' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[0], {
    id: 1,
    method: 'Target.activateTarget',
    params: { targetId: 'TARGET_TAB_CHECKOUT' },
  });

  respondTo(transport, 1, {});
  await pending;
});

test('navigateTab enables Page then awaits the load event before resolving', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const first = client.navigateTab({ targetId: 'TARGET_TAB_HOME', url: 'https://example.com/a' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[0], {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: 'TARGET_TAB_HOME', flatten: true },
  });

  respondTo(transport, 1, { sessionId: 'SESSION_HOME' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[1], {
    id: 2,
    method: 'Page.enable',
    params: {},
    sessionId: 'SESSION_HOME',
  });

  respondTo(transport, 2, {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[2], {
    id: 3,
    method: 'Page.navigate',
    params: { url: 'https://example.com/a' },
    sessionId: 'SESSION_HOME',
  });

  let resolved = false;
  first.then(() => {
    resolved = true;
  });
  respondTo(transport, 3, { frameId: 'FRAME_HOME' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(resolved, false, 'navigateTab must not resolve until Page.loadEventFired arrives');

  transport.emit({ method: 'Page.loadEventFired', sessionId: 'SESSION_HOME', params: {} });
  await first;

  assert.equal(resolved, true);
});

test('navigateTab reuses the cached session and skips Page.enable on subsequent calls', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const first = client.navigateTab({ targetId: 'TARGET_TAB_HOME', url: 'https://example.com/a' });
  await new Promise((resolve) => setImmediate(resolve));
  respondTo(transport, 1, { sessionId: 'SESSION_HOME' });
  await new Promise((resolve) => setImmediate(resolve));
  respondTo(transport, 2, {});
  await new Promise((resolve) => setImmediate(resolve));
  respondTo(transport, 3, { frameId: 'FRAME_HOME' });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({ method: 'Page.loadEventFired', sessionId: 'SESSION_HOME', params: {} });
  await first;

  const second = client.navigateTab({ targetId: 'TARGET_TAB_HOME', url: 'https://example.com/b' });
  await new Promise((resolve) => setImmediate(resolve));

  // No attach, no Page.enable: straight to Page.navigate on the cached session.
  assert.deepEqual(transport.sent[3], {
    id: 4,
    method: 'Page.navigate',
    params: { url: 'https://example.com/b' },
    sessionId: 'SESSION_HOME',
  });

  respondTo(transport, 4, { frameId: 'FRAME_HOME' });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emit({ method: 'Page.loadEventFired', sessionId: 'SESSION_HOME', params: {} });
  await second;
});

test('navigateTab resolves via the timeout fallback when no load event arrives', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const pending = client.navigateTab({ targetId: 'TARGET_TAB_HOME', url: 'https://example.com/a', loadTimeoutMs: 20 });
  await new Promise((resolve) => setImmediate(resolve));
  respondTo(transport, 1, { sessionId: 'SESSION_HOME' });
  await new Promise((resolve) => setImmediate(resolve));
  respondTo(transport, 2, {});
  await new Promise((resolve) => setImmediate(resolve));
  respondTo(transport, 3, { frameId: 'FRAME_HOME' });

  await assert.doesNotReject(pending);
});

test('waitForTabPaint attaches to the target session and awaits a painted frame', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const pending = client.waitForTabPaint({ targetId: 'TARGET_TAB_HOME' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[0], {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: 'TARGET_TAB_HOME', flatten: true },
  });

  respondTo(transport, 1, { sessionId: 'SESSION_HOME' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transport.sent[1].method, 'Runtime.evaluate');
  assert.equal(transport.sent[1].sessionId, 'SESSION_HOME');
  assert.equal(transport.sent[1].params.awaitPromise, true);
  assert.match(transport.sent[1].params.expression, /requestAnimationFrame/);

  respondTo(transport, 2, {
    result: {
      type: 'object',
      value: {
        reason: 'paint',
        readyState: 'complete',
        visibilityState: 'visible',
      },
    },
  });

  await pending;
});

test('setWindowTitle attaches once per target then applies a one-shot title script with no polling', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const pending = client.setWindowTitle({ targetId: 'TARGET_TAB_HOME', title: 'Deckhand BrowserA' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[0], {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: 'TARGET_TAB_HOME', flatten: true },
  });

  respondTo(transport, 1, { sessionId: 'SESSION_HOME' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transport.sent[1].id, 2);
  assert.equal(transport.sent[1].method, 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(transport.sent[1].sessionId, 'SESSION_HOME');
  assert.equal(typeof transport.sent[1].params?.source, 'string');
  assert.doesNotMatch(transport.sent[1].params.source, /setInterval/);
  assert.match(transport.sent[1].params.source, /Deckhand BrowserA/);

  respondTo(transport, 2, { identifier: 'deckhand-title-script' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[2], {
    id: 3,
    method: 'Runtime.evaluate',
    params: { expression: transport.sent[1].params.source },
    sessionId: 'SESSION_HOME',
  });

  respondTo(transport, 3, { result: { type: 'string', value: 'Deckhand BrowserA' } });
  await pending;
});

test('getTargets resolves the targetInfos returned by Target.getTargets', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const pending = client.getTargets();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transport.sent[0], { id: 1, method: 'Target.getTargets', params: {} });

  respondTo(transport, 1, {
    targetInfos: [
      { targetId: 'TARGET_TAB_HOME', type: 'page', url: 'https://example.com/home' },
    ],
  });

  assert.deepEqual(await pending, [
    { targetId: 'TARGET_TAB_HOME', type: 'page', url: 'https://example.com/home' },
  ]);
});

test('cdp command errors reject the calling promise with the error message', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const pending = client.activateTab({ targetId: 'MISSING' });
  await new Promise((resolve) => setImmediate(resolve));

  respondWithError(transport, 1, 'No target with given id found');

  await assert.rejects(pending, /No target with given id found/);
});

test('transport close marks the client disconnected and emits the disconnected lifecycle event', async () => {
  const transport = createFakeTransport();
  const events = [];
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });
  client.on('disconnected', () => events.push('disconnected'));

  await client.connect();
  transport.emitClose();

  assert.equal(client.isConnected(), false);
  assert.deepEqual(events, ['disconnected']);
});

test('transport close rejects pending requests instead of leaving them unresolved', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: createFakeDiscovery({ webSocketDebuggerUrl: 'ws://browser', chromePid: 1 }),
    createTransport() {
      return transport;
    },
  });

  await client.connect();

  const pending = client.activateTab({ targetId: 'TARGET_TAB_CHECKOUT' });
  await new Promise((resolve) => setImmediate(resolve));

  transport.emitClose();

  await assert.rejects(pending, /closed/i);
});

test('connect rejects when discovery fails', async () => {
  const transport = createFakeTransport();
  const client = createCdpClient({
    discover: async () => {
      throw new Error('chrome not running');
    },
    createTransport() {
      return transport;
    },
  });

  await assert.rejects(client.connect(), /chrome not running/);
  assert.equal(client.isConnected(), false);
});
