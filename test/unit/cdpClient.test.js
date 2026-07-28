import assert from 'node:assert/strict';
import test from 'node:test';

import { createCdpClient } from '../../src/cdpClient.js';

function createFakeTransport() {
  const listeners = { message: new Set(), close: new Set(), error: new Set() };
  const sent = [];
  let closed = false;

  return {
    sent,
    get closed() {
      return closed;
    },
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close() {
      closed = true;
      listeners.close.forEach((handler) => handler());
    },
    emit(payload) {
      listeners.message.forEach((handler) => handler(JSON.stringify(payload)));
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

test('createTab creates a same-window target and resolves its targetId', async () => {
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
    params: { url: 'https://example.com/checkout' },
  });

  respondTo(transport, 3, { targetId: 'TARGET_TAB_CHECKOUT' });

  assert.deepEqual(await pending, { targetId: 'TARGET_TAB_CHECKOUT' });
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

test('navigateTab attaches once per target then sends Page.navigate on the session', async () => {
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
    method: 'Page.navigate',
    params: { url: 'https://example.com/a' },
    sessionId: 'SESSION_HOME',
  });

  respondTo(transport, 2, { frameId: 'FRAME_HOME' });
  await first;

  const second = client.navigateTab({ targetId: 'TARGET_TAB_HOME', url: 'https://example.com/b' });
  await new Promise((resolve) => setImmediate(resolve));

  // Second navigation reuses the cached session and does not attach again.
  assert.deepEqual(transport.sent[2], {
    id: 3,
    method: 'Page.navigate',
    params: { url: 'https://example.com/b' },
    sessionId: 'SESSION_HOME',
  });

  respondTo(transport, 3, { frameId: 'FRAME_HOME' });
  await second;
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
