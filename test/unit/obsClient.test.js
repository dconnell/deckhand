import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
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
        overlay: false,
      },
    },
  ]);
});

function createEventedFakeObsWebSocket(responder) {
  return class EventedFakeObsWebSocket {
    constructor() {
      this.calls = [];
      this.listeners = new Map();
    }

    async connect() {
      return { obsWebSocketVersion: '5.0.0', negotiatedRpcVersion: 1 };
    }

    async disconnect() {}

    on(event, handler) {
      const queue = this.listeners.get(event) ?? [];
      queue.push(handler);
      this.listeners.set(event, queue);
    }

    off(event, handler) {
      const queue = this.listeners.get(event) ?? [];
      this.listeners.set(event, queue.filter((entry) => entry !== handler));
    }

    emit(event, data) {
      for (const handler of this.listeners.get(event) ?? []) {
        handler(data);
      }
    }

    async call(method, payload) {
      this.calls.push({ method, payload });
      return responder ? responder(method, payload, this) : {};
    }
  };
}

test('obs client reports the current program scene', async () => {
  const Fake = createEventedFakeObsWebSocket(() => ({
    scenes: [{ sceneName: 'Full Slide' }, { sceneName: 'Freeze' }],
    currentProgramSceneName: 'Full Slide',
  }));
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();

  assert.equal(await obs.getCurrentProgramScene(), 'Full Slide');
});

test('obs client captureProgramScreenshot strips the data-uri prefix and writes the PNG bytes', async () => {
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const dataUri = `data:image/png;base64,${fakePng.toString('base64')}`;
  const Fake = createEventedFakeObsWebSocket((method, payload) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Full Slide' }], currentProgramSceneName: 'Full Slide' };
    }

    if (method === 'GetSourceScreenshot' && payload.sourceName === 'Full Slide') {
      return { imageData: dataUri };
    }

    return {};
  });
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  const target = path.join(os.tmpdir(), `deckhand-shot-${process.pid}-${Date.now()}.png`);
  await obs.captureProgramScreenshot(target);

  assert.deepEqual(await readFile(target), fakePng);
});

test('obs client setCurrentTransition sets transition name and optional duration', async () => {
  const Fake = createEventedFakeObsWebSocket();
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  await obs.setCurrentTransition('Slide Right', 300);

  assert.deepEqual(obs.getClient().calls, [
    { method: 'SetCurrentSceneTransition', payload: { transitionName: 'Slide Right' } },
    { method: 'SetCurrentSceneTransitionDuration', payload: { transitionDuration: 300 } },
  ]);
});

test('obs client switchProgramScene awaits the matching CurrentProgramSceneChanged event', async () => {
  const Fake = createEventedFakeObsWebSocket();
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  const instance = obs.getClient();

  let resolved = false;
  const pending = obs.switchProgramScene('Target', { waitForEvent: true, timeoutMs: 1000 });
  pending.then(() => {
    resolved = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false);

  instance.emit('CurrentProgramSceneChanged', { sceneName: 'Other' });
  await Promise.resolve();
  assert.equal(resolved, false);

  instance.emit('CurrentProgramSceneChanged', { sceneName: 'Target' });
  await pending;

  assert.equal(resolved, true);
  assert.deepEqual(instance.calls, [{ method: 'SetCurrentProgramScene', payload: { sceneName: 'Target' } }]);
});

test('obs client switchProgramScene without event waiting issues a plain SetCurrentProgramScene', async () => {
  const Fake = createEventedFakeObsWebSocket();
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  await obs.switchProgramScene('Full Slide');

  assert.deepEqual(obs.getClient().calls, [{ method: 'SetCurrentProgramScene', payload: { sceneName: 'Full Slide' } }]);
});

test('obs client ensureFreezeAssets creates a missing freeze scene and image source', async () => {
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Full Slide' }], currentProgramSceneName: 'Full Slide' };
    }

    if (method === 'GetInputList') {
      return { inputs: [] };
    }

    return {};
  });
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  await obs.ensureFreezeAssets({ sceneName: 'Freeze', inputName: 'Freeze Frame', imagePath: '/tmp/freeze.png' });

  assert.deepEqual(obs.getClient().calls.map((call) => call.method), [
    'GetSceneList',
    'CreateScene',
    'GetInputList',
    'CreateInput',
  ]);
  assert.deepEqual(obs.getClient().calls[3].payload, {
    sceneItemEnabled: true,
    sceneName: 'Freeze',
    inputKind: 'image_source',
    inputName: 'Freeze Frame',
    inputSettings: { file: '/tmp/freeze.png' },
  });
});

test('obs client waitForSceneTransitionEnd awaits the CurrentSceneTransitionEnded event', async () => {
  const Fake = createEventedFakeObsWebSocket();
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  const instance = obs.getClient();

  let resolved = false;
  const pending = obs.waitForSceneTransitionEnd({ timeoutMs: 1000 });
  pending.then(() => {
    resolved = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false, 'must not resolve before the transition ends');

  instance.emit('CurrentSceneTransitionEnded', {});
  await pending;

  assert.equal(resolved, true);
});

test('obs client waitForSceneTransitionEnd falls back to the timeout when no event arrives', async () => {
  const Fake = createEventedFakeObsWebSocket();
  const logger = { info() {}, error() {}, warn() {} };
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger,
  });

  await obs.connect();

  await assert.doesNotReject(obs.waitForSceneTransitionEnd({ timeoutMs: 15 }));
});

test('obs client ensureFreezeAssets re-points an existing image source at the freeze path', async () => {
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Freeze' }] };
    }

    if (method === 'GetInputList') {
      return { inputs: [{ inputName: 'Freeze Frame', inputKind: 'image_source' }] };
    }

    return {};
  });
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  await obs.ensureFreezeAssets({ sceneName: 'Freeze', inputName: 'Freeze Frame', imagePath: '/tmp/freeze.png' });

  assert.deepEqual(obs.getClient().calls.map((call) => call.method), ['GetSceneList', 'GetInputList', 'SetInputSettings']);
  assert.deepEqual(obs.getClient().calls[2].payload, {
    inputName: 'Freeze Frame',
    inputSettings: { file: '/tmp/freeze.png' },
    overlay: true,
  });
});
