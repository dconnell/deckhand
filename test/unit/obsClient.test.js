import assert from 'node:assert/strict';
import test from 'node:test';

import { createObsClient } from '../../src/obsClient.js';

function createFakeObsWebSocket({ shouldFailCall = false, shouldFailConnect = false } = {}) {
  return class FakeObsWebSocket {
    constructor() {
      this.calls = [];
      this.disconnectCalled = false;
      this.shouldFailConnect = shouldFailConnect;
      this.shouldFailCall = shouldFailCall;
    }

    async connect(url, password) {
      if (this.shouldFailConnect) {
        throw new Error('connect failed');
      }

      this.connectedArgs = { url, password };
      return { obsWebSocketVersion: '5.0.0', negotiatedRpcVersion: 1 };
    }

    async disconnect() {
      this.disconnectCalled = true;
    }

    async call(method, payload) {
      if (this.shouldFailCall) {
        throw new Error('scene rejected');
      }

      this.calls.push({ method, payload });
      return {};
    }
  };
}

test('obs client connect succeeds and records connection state', async () => {
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: 'secret',
    OBSWebSocketClass: createFakeObsWebSocket(),
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();

  assert.equal(obs.isConnected(), true);
});

test('obs client surfaces connect failures clearly', async () => {
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: createFakeObsWebSocket({ shouldFailConnect: true }),
    logger: { info() {}, error() {}, warn() {} },
  });

  await assert.rejects(() => obs.connect(), /connect failed/i);
});

test('obs client setScene uses SetCurrentProgramScene', async () => {
  const FakeObsWebSocket = createFakeObsWebSocket();
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: FakeObsWebSocket,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  await obs.setScene('Gameplay');

  assert.deepEqual(obs.getClient().calls, [
    {
      method: 'SetCurrentProgramScene',
      payload: { sceneName: 'Gameplay' },
    },
  ]);
});

test('obs client rejects scene changes while disconnected', async () => {
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: createFakeObsWebSocket(),
    logger: { info() {}, error() {}, warn() {} },
  });

  await assert.rejects(() => obs.setScene('Gameplay'), /not connected/i);
});

test('obs client surfaces scene rejection errors', async () => {
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: createFakeObsWebSocket({ shouldFailCall: true }),
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  await assert.rejects(() => obs.setScene('Missing Scene'), /scene rejected/i);
});

test('obs client applies window capture settings for managed sources', async () => {
  const FakeObsWebSocket = createFakeObsWebSocket();
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: FakeObsWebSocket,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  await obs.applyInputSettings('Slide', {
    owner_name: 'Google Chrome',
    window_name: 'Deckhand Example Deck',
    owner_pid: 47213,
    window: 12345,
  });

  assert.deepEqual(obs.getClient().calls, [
    {
      method: 'SetInputSettings',
      payload: {
        inputName: 'Slide',
        inputSettings: {
          owner_name: 'Google Chrome',
          window_name: 'Deckhand Example Deck',
          owner_pid: 47213,
          window: 12345,
        },
        overlay: true,
      },
    },
  ]);
});
