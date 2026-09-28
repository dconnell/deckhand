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
  const Fake = createFakeObsWebSocket();

  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
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

test('obs client captureProgramScreenshot rejects without writing a file when OBS returns empty image data', async () => {
  const Fake = createEventedFakeObsWebSocket((method, payload) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Full Slide' }], currentProgramSceneName: 'Full Slide' };
    }

    if (method === 'GetSourceScreenshot' && payload.sourceName === 'Full Slide') {
      return { imageData: '' };
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
  const target = path.join(os.tmpdir(), `deckhand-shot-empty-${process.pid}-${Date.now()}.png`);

  await assert.rejects(() => obs.captureProgramScreenshot(target), /empty program screenshot/);
  await assert.rejects(() => readFile(target), { code: 'ENOENT' });
});

test('obs client getProgramScreenshotBuffer returns low-resolution JPEG bytes for the current program scene', async () => {
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]);
  const dataUri = `data:image/jpeg;base64,${fakeJpeg.toString('base64')}`;
  const Fake = createEventedFakeObsWebSocket((method, payload) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Program' }], currentProgramSceneName: 'Program' };
    }

    if (method === 'GetSourceScreenshot') {
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

  assert.deepEqual(await obs.getProgramScreenshotBuffer(), fakeJpeg);
  assert.deepEqual(obs.getClient().calls, [
    { method: 'GetSceneList', payload: undefined },
    {
      method: 'GetSourceScreenshot',
      payload: {
        sourceName: 'Program',
        imageFormat: 'jpg',
        imageCompressionQuality: 60,
        imageHeight: 208,
        imageWidth: 320,
      },
    },
  ]);
});

test('obs client getStreamStatus issues the GetStreamStatus RPC', async () => {
  const status = {
    outputActive: true,
    outputBytes: 42,
    outputDuration: 84,
    outputCongestion: 0.1,
  };
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetStreamStatus') {
      return status;
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

  await obs.getStreamStatus();
  assert.deepEqual(obs.getClient().calls, [{ method: 'GetStreamStatus', payload: undefined }]);
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

test('obs client switchProgramScene ignores malformed scene-change events instead of reporting success', async () => {
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

  // Malformed payloads must never count as success: an event with no scene
  // name at all, an explicit null name, and the nested shape with the name
  // missing all have to be ignored.
  instance.emit('CurrentProgramSceneChanged', {});
  instance.emit('CurrentProgramSceneChanged', { sceneName: null });
  instance.emit('CurrentProgramSceneChanged', { eventData: {} });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false, 'malformed scene-change events must not resolve the wait');

  // OBS wraps the payload differently across versions; the nested exact
  // match must still resolve.
  instance.emit('CurrentProgramSceneChanged', { eventData: { sceneName: 'Target' } });
  await pending;
  assert.equal(resolved, true, 'an exact name match resolves the wait');
});

test('obs client switchProgramScene falls back to the timeout when no matching event arrives', async () => {
  const Fake = createEventedFakeObsWebSocket();
  const warnings = [];
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: {
      info() {},
      error() {},
      warn(message) {
        warnings.push(message);
      },
    },
  });

  await obs.connect();
  const instance = obs.getClient();

  // Only ever emit non-matching scene names; the wait must end via the
  // timeout fallback, not report success early.
  instance.emit('CurrentProgramSceneChanged', { sceneName: 'Other' });

  await assert.doesNotReject(obs.switchProgramScene('Target', { waitForEvent: true, timeoutMs: 15 }));
  assert.ok(
    warnings.some((message) => /Timed out waiting for OBS scene change event/.test(message)),
    'the timeout fallback must be logged as a warning',
  );
});

test('obs client ensureFreezeAssets creates a missing freeze scene and image source', async () => {
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Full Slide' }], currentProgramSceneName: 'Full Slide' };
    }

    if (method === 'GetInputList') {
      return { inputs: [] };
    }

    if (method === 'GetVideoSettings') {
      return { baseWidth: 1920, baseHeight: 1080 };
    }

    if (method === 'CreateInput') {
      return { sceneItemId: 1 };
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

  const calls = obs.getClient().calls;
  const methods = calls.map((call) => call.method);

  const createSceneIndex = methods.indexOf('CreateScene');
  const createInputIndex = methods.indexOf('CreateInput');
  const transformIndex = methods.indexOf('SetSceneItemTransform');

  assert.ok(createSceneIndex !== -1, 'creates the missing freeze scene');
  assert.deepEqual(calls[createSceneIndex].payload, { sceneName: 'Freeze' });

  assert.ok(createInputIndex !== -1, 'creates the missing freeze image source');
  assert.deepEqual(calls[createInputIndex].payload, {
    sceneItemEnabled: true,
    sceneName: 'Freeze',
    inputKind: 'image_source',
    inputName: 'Freeze Frame',
    inputSettings: { file: '/tmp/freeze.png' },
  });

  assert.ok(transformIndex !== -1, 'applies the freeze transform');
  assert.deepEqual(calls[transformIndex].payload, {
    sceneItemId: 1,
    sceneName: 'Freeze',
    sceneItemTransform: {
      positionX: 0,
      positionY: 0,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: 1920,
      boundsHeight: 1080,
    },
  });

  assert.ok(createInputIndex > createSceneIndex, 'creates the image source inside the freshly created scene');
  assert.ok(transformIndex > createInputIndex, 'transforms the scene item that CreateInput resolved');
});

test('obs client waitForSceneTransitionEnd awaits the SceneTransitionEnded event', async () => {
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

  instance.emit('SceneTransitionEnded', {});
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

test('obs client waitForSourceScreenshotStable resolves once consecutive screenshots match', async () => {
  const frames = ['frame-a', 'frame-b', 'frame-b'];
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSourceScreenshot') {
      return { imageData: frames.shift() ?? 'frame-b' };
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
  await obs.waitForSourceScreenshotStable('Deckhand_Full Slide', {
    pollIntervalMs: 1,
    stableSamples: 2,
    timeoutMs: 100,
  });

  assert.equal(
    obs.getClient().calls.filter((call) => call.method === 'GetSourceScreenshot').length,
    3,
  );
});

test('obs client waitForSourceScreenshotStable can require the frame to differ from the outgoing scene first', async () => {
  const frames = ['outgoing', 'outgoing', 'incoming', 'incoming'];
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSourceScreenshot') {
      return { imageData: frames.shift() ?? 'incoming' };
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
  await obs.waitForSourceScreenshotStable('Deckhand_Full Slide', {
    differentFromData: 'outgoing',
    pollIntervalMs: 1,
    stableSamples: 2,
    timeoutMs: 100,
  });

  assert.equal(
    obs.getClient().calls.filter((call) => call.method === 'GetSourceScreenshot').length,
    4,
  );
});

test('obs client waitForSourceScreenshotStable resolves via timeout fallback when the frame never stabilizes', async () => {
  let index = 0;
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSourceScreenshot') {
      index += 1;
      return { imageData: `frame-${index}` };
    }

    return {};
  });
  const logger = { info() {}, error() {}, warn() {} };
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger,
  });

  await obs.connect();
  await assert.doesNotReject(obs.waitForSourceScreenshotStable('Deckhand_Full Slide', {
    pollIntervalMs: 1,
    stableSamples: 3,
    timeoutMs: 10,
  }));
  assert.ok(index > 1);
});

test('obs client waitForSourceScreenshotStable defaults to a relaxed poll interval', async () => {
  let index = 0;
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSourceScreenshot') {
      index += 1;
      return { imageData: `frame-${index}` };
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

  // setTimeout never fires early, so the sample count over a short window
  // bounds the default interval: a 50ms default samples at most 3 times in
  // 100ms (0/50/100ms), while the old 10ms default would sample ~11 times.
  await assert.doesNotReject(obs.waitForSourceScreenshotStable('Deckhand_Full Slide', { timeoutMs: 100 }));

  const samples = obs.getClient().calls.filter((call) => call.method === 'GetSourceScreenshot').length;
  assert.ok(samples >= 1, 'the wait still samples the source');
  assert.ok(samples <= 3, `expected at most 3 samples with the relaxed default, got ${samples}`);
});

test('obs client setPreviewScene switches preview and waits until OBS reports it active', async () => {
  // OBS does not reflect a preview change on the first read after the write; the
  // fake reports the outgoing scene for the first post-write poll and only flips
  // on the second, so the client must keep polling until it sees the target.
  let pollsSincePreviewWrite = Number.POSITIVE_INFINITY;
  const Fake = createEventedFakeObsWebSocket((method, payload) => {
    if (method === 'SetCurrentPreviewScene') {
      pollsSincePreviewWrite = 0;
      return {};
    }

    if (method === 'GetSceneList') {
      if (pollsSincePreviewWrite < 2) {
        pollsSincePreviewWrite += 1;
      }

      return {
        currentProgramSceneName: 'Deckhand_Freeze',
        currentPreviewSceneName: pollsSincePreviewWrite >= 2 ? 'Deckhand_Dual Browser' : 'Deckhand_Full Slide',
        scenes: [
          { sceneName: 'Deckhand_Freeze' },
          { sceneName: 'Deckhand_Full Slide' },
          { sceneName: 'Deckhand_Dual Browser' },
        ],
      };
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
  await obs.setPreviewScene('Deckhand_Dual Browser', { timeoutMs: 50, pollIntervalMs: 1 });

  assert.deepEqual(obs.getClient().calls[0], {
    method: 'SetCurrentPreviewScene',
    payload: { sceneName: 'Deckhand_Dual Browser' },
  });

  const polls = obs.getClient().calls.filter((call) => call.method === 'GetSceneList').length;
  assert.equal(polls, 2, 'polls until OBS reports the preview target, then exits instead of spinning to the timeout');
});

test('obs client triggerStudioModeTransition waits until program matches the preview target', async () => {
  // The transition lands asynchronously: the first program read after the
  // trigger still reports the outgoing scene, and only the second poll sees the
  // preview target, so the client must keep polling until it matches.
  let pollsSinceTransition = Number.POSITIVE_INFINITY;
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'TriggerStudioModeTransition') {
      pollsSinceTransition = 0;
      return {};
    }

    if (method === 'GetSceneList') {
      if (pollsSinceTransition < 2) {
        pollsSinceTransition += 1;
      }

      return {
        currentProgramSceneName: pollsSinceTransition >= 2 ? 'Deckhand_Dual Browser' : 'Deckhand_Freeze',
        currentPreviewSceneName: 'Deckhand_Dual Browser',
        scenes: [
          { sceneName: 'Deckhand_Freeze' },
          { sceneName: 'Deckhand_Dual Browser' },
        ],
      };
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
  await obs.triggerStudioModeTransition({ targetSceneName: 'Deckhand_Dual Browser', timeoutMs: 50, pollIntervalMs: 1 });

  assert.deepEqual(obs.getClient().calls[0], {
    method: 'TriggerStudioModeTransition',
    payload: undefined,
  });

  const polls = obs.getClient().calls.filter((call) => call.method === 'GetSceneList').length;
  assert.equal(polls, 2, 'polls until program matches the preview target, then exits instead of spinning to the timeout');
});

test('obs client ensureFreezeAssets re-points an existing image source at the freeze path', async () => {
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Freeze' }] };
    }

    if (method === 'GetInputList') {
      return { inputs: [{ inputName: 'Freeze Frame', inputKind: 'image_source' }] };
    }

    if (method === 'GetVideoSettings') {
      return { baseWidth: 2560, baseHeight: 1440 };
    }

    if (method === 'GetSceneItemList') {
      return { sceneItems: [{ sceneItemId: 7, sourceName: 'Freeze Frame' }] };
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

  const calls = obs.getClient().calls;
  const methods = calls.map((call) => call.method);

  assert.equal(methods.includes('CreateScene'), false, 'freeze scene already exists');
  assert.equal(methods.includes('CreateInput'), false, 'freeze image source already exists');

  const setInputIndex = methods.indexOf('SetInputSettings');
  assert.ok(setInputIndex !== -1, 're-points the existing image source at the freeze path');
  assert.deepEqual(calls[setInputIndex].payload, {
    inputName: 'Freeze Frame',
    inputSettings: { file: '/tmp/freeze.png' },
    overlay: true,
  });

  const transformIndex = methods.indexOf('SetSceneItemTransform');
  assert.ok(transformIndex !== -1, 'keeps the freeze transform in place');
  assert.deepEqual(calls[transformIndex].payload, {
    sceneItemId: 7,
    sceneName: 'Freeze',
    sceneItemTransform: {
      positionX: 0,
      positionY: 0,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: 2560,
      boundsHeight: 1440,
    },
  });

  assert.ok(transformIndex > setInputIndex, 'transforms the item only after re-pointing it');
});

test('obs client ensureFreezeAssets creates a dim color-correction filter when dimPercent is set', async () => {
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Freeze' }] };
    }

    if (method === 'GetInputList') {
      return { inputs: [{ inputName: 'Freeze Frame', inputKind: 'image_source' }] };
    }

    if (method === 'GetSourceFilterList') {
      return { filters: [] };
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
  await obs.ensureFreezeAssets({
    sceneName: 'Freeze',
    inputName: 'Freeze Frame',
    imagePath: '/tmp/freeze.png',
    dimPercent: 10,
  });

  const calls = obs.getClient().calls.map((call) => call.method);
  const filterIndex = calls.indexOf('CreateSourceFilter');
  assert.ok(filterIndex !== -1, 'creates the dim filter');
  assert.deepEqual(obs.getClient().calls[filterIndex].payload, {
    sourceName: 'Freeze Frame',
    filterName: 'Deckhand_Dim',
    filterKind: 'color_filter',
    filterSettings: { opacity: 90 },
  });
});

test('obs client ensureFreezeAssets updates an existing dim filter to the configured opacity', async () => {
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Freeze' }] };
    }

    if (method === 'GetInputList') {
      return { inputs: [{ inputName: 'Freeze Frame', inputKind: 'image_source' }] };
    }

    if (method === 'GetSourceFilterList') {
      return {
        filters: [
          { filterName: 'Deckhand_Dim', filterKind: 'color_filter', filterEnabled: true, filterSettings: { opacity: 100 } },
        ],
      };
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
  await obs.ensureFreezeAssets({
    sceneName: 'Freeze',
    inputName: 'Freeze Frame',
    imagePath: '/tmp/freeze.png',
    dimPercent: 15,
  });

  const calls = obs.getClient().calls.map((call) => call.method);
  assert.equal(calls.includes('CreateSourceFilter'), false, 'does not recreate an existing filter');
  const settingsIndex = calls.indexOf('SetSourceFilterSettings');
  assert.ok(settingsIndex !== -1, 'updates the existing filter');
  assert.deepEqual(obs.getClient().calls[settingsIndex].payload, {
    sourceName: 'Freeze Frame',
    filterName: 'Deckhand_Dim',
    filterSettings: { opacity: 85 },
    overlay: false,
  });
});

test('obs client ensureFreezeAssets skips the dim filter when dimPercent is 0', async () => {
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
  await obs.ensureFreezeAssets({
    sceneName: 'Freeze',
    inputName: 'Freeze Frame',
    imagePath: '/tmp/freeze.png',
    dimPercent: 0,
  });

  const calls = obs.getClient().calls.map((call) => call.method);
  assert.equal(calls.includes('GetSourceFilterList'), false, 'leaves filters untouched when dim is disabled');
  assert.equal(calls.includes('CreateSourceFilter'), false);
  assert.equal(calls.includes('SetSourceFilterSettings'), false);
});

test('obs client ensureFreezeAssets recreates a missing freeze scene item and transforms it', async () => {
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Freeze' }] };
    }

    if (method === 'GetInputList') {
      return { inputs: [{ inputName: 'Freeze Frame', inputKind: 'image_source' }] };
    }

    if (method === 'GetVideoSettings') {
      return { baseWidth: 1920, baseHeight: 1080 };
    }

    if (method === 'GetSceneItemList') {
      return { sceneItems: [] };
    }

    if (method === 'CreateSceneItem') {
      return { sceneItemId: 42 };
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

  const calls = obs.getClient().calls;
  const createIndex = calls.findIndex((call) => call.method === 'CreateSceneItem');
  const transformIndex = calls.findIndex((call) => call.method === 'SetSceneItemTransform');
  assert.ok(createIndex !== -1, 'recreates the missing freeze scene item');
  assert.deepEqual(calls[createIndex].payload, {
    sceneItemEnabled: true,
    sceneName: 'Freeze',
    sourceName: 'Freeze Frame',
  });
  assert.ok(transformIndex !== -1, 'applies the freeze transform');
  assert.ok(transformIndex > createIndex, 'transforms the recreated scene item');
  assert.deepEqual(calls[transformIndex].payload, {
    sceneItemId: 42,
    sceneName: 'Freeze',
    sceneItemTransform: {
      positionX: 0,
      positionY: 0,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: 1920,
      boundsHeight: 1080,
    },
  });
});

test('obs client ensureFreezeAssets keeps ensuring the dim filter when the transform step fails', async () => {
  const Fake = createEventedFakeObsWebSocket((method) => {
    if (method === 'GetSceneList') {
      return { scenes: [{ sceneName: 'Freeze' }] };
    }

    if (method === 'GetInputList') {
      return { inputs: [{ inputName: 'Freeze Frame', inputKind: 'image_source' }] };
    }

    if (method === 'GetVideoSettings') {
      throw new Error('video settings unavailable');
    }

    if (method === 'GetSourceFilterList') {
      return { filters: [] };
    }

    return {};
  });
  const warnings = [];
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: Fake,
    logger: {
      info() {},
      error() {},
      warn(message, context) {
        warnings.push({ message, context });
      },
    },
  });

  await obs.connect();
  await obs.ensureFreezeAssets({
    sceneName: 'Freeze',
    inputName: 'Freeze Frame',
    imagePath: '/tmp/freeze.png',
    dimPercent: 10,
  });

  const calls = obs.getClient().calls.map((call) => call.method);
  assert.equal(calls.includes('SetSceneItemTransform'), false, 'skips the transform after the failure');
  assert.ok(calls.includes('CreateSourceFilter'), 'still ensures the dim filter after transform failure');
  assert.ok(warnings.length >= 1, 'transform failure must be logged as a warning');
});

function createFakeTimer() {
  const pending = [];

  return {
    pending,
    setTimeout(fn, ms) {
      const handle = { fn, ms, done: false };
      pending.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) {
        handle.done = true;
      }
    },
    delays() {
      return pending.map((handle) => handle.ms);
    },
    async run(count) {
      let executed = 0;

      while (executed < count && pending.some((handle) => !handle.done)) {
        const handle = pending.find((entry) => !entry.done);
        handle.done = true;
        await handle.fn();
        executed += 1;
      }
    },
  };
}

function createReconnectableObsWebSocket({ outcomes = [] } = {}) {
  return class ReconnectableObsWebSocket {
    constructor() {
      this.handlers = new Map();
      this.connectAttempts = 0;
      this.disconnectCalled = false;
      this.remainingOutcomes = [...outcomes];
    }

    on(event, handler) {
      const set = this.handlers.get(event) ?? new Set();
      set.add(handler);
      this.handlers.set(event, set);
    }

    off(event, handler) {
      this.handlers.get(event)?.delete(handler);
    }

    emit(event, data) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(data);
      }
    }

    async connect() {
      this.connectAttempts += 1;
      const outcome = this.remainingOutcomes.length > 0 ? this.remainingOutcomes.shift() : 'ok';

      if (outcome === 'fail') {
        throw new Error('obs reconnect attempt failed');
      }

      return { obsWebSocketVersion: '5.0.0', negotiatedRpcVersion: 1 };
    }

    async disconnect() {
      this.disconnectCalled = true;
    }

    async call() {
      return {};
    }
  };
}

test('obs client marks itself disconnected and emits reconnecting when the socket closes', async () => {
  const timer = createFakeTimer();
  const events = [];
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: createReconnectableObsWebSocket({ outcomes: ['ok'] }),
    timer,
    reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5000 },
    logger: { info() {}, error() {}, warn() {} },
  });
  obs.on('reconnecting', () => events.push('reconnecting'));
  obs.on('reconnected', () => events.push('reconnected'));

  await obs.connect();
  assert.equal(obs.isConnected(), true);

  obs.getClient().emit('ConnectionClosed');

  assert.equal(obs.isConnected(), false);
  assert.equal(obs.isReconnecting(), true);
  assert.deepEqual(events, ['reconnecting']);
});

test('obs client reconnects with backoff and emits reconnected once the socket is back', async () => {
  const timer = createFakeTimer();
  const events = [];
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: createReconnectableObsWebSocket({ outcomes: ['ok', 'fail', 'ok'] }),
    timer,
    reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5000 },
    logger: { info() {}, error() {}, warn() {} },
  });
  obs.on('reconnecting', () => events.push('reconnecting'));
  obs.on('reconnected', () => events.push('reconnected'));

  await obs.connect();
  obs.getClient().emit('ConnectionClosed');

  await timer.run(5);

  assert.equal(obs.isConnected(), true);
  assert.equal(obs.isReconnecting(), false);
  assert.deepEqual(events, ['reconnecting', 'reconnected']);
  assert.equal(obs.getClient().connectAttempts, 3);
});

test('obs client reconnect backoff starts at initialDelayMs and caps at maxDelayMs', async () => {
  const timer = createFakeTimer();
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: createReconnectableObsWebSocket({ outcomes: ['ok', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail'] }),
    timer,
    reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5000 },
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  obs.getClient().emit('ConnectionClosed');

  await timer.run(6);

  const delays = timer.delays();
  assert.equal(delays[0], 250, 'first backoff delay is the initial delay');
  assert.ok(delays.every((value) => value <= 5000), 'no backoff delay exceeds the cap');
  assert.equal(delays[delays.length - 1], 5000, 'backoff reaches the cap');
});

test('obs client suppresses reconnect after an explicit disconnect', async () => {
  const timer = createFakeTimer();
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: createReconnectableObsWebSocket({ outcomes: ['ok'] }),
    timer,
    reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5000 },
    logger: { info() {}, error() {}, warn() {} },
  });

  await obs.connect();
  obs.getClient().emit('ConnectionClosed');

  await obs.disconnect();

  const attemptsBefore = obs.getClient().connectAttempts;
  await timer.run(5);

  assert.equal(obs.getClient().connectAttempts, attemptsBefore);
  assert.equal(obs.isReconnecting(), false);
  assert.equal(obs.isConnected(), false);
});

test('obs client skips reconnect when the recovery block disables it', async () => {
  const timer = createFakeTimer();
  const events = [];
  const obs = createObsClient({
    url: 'ws://127.0.0.1:4455',
    password: '',
    OBSWebSocketClass: createReconnectableObsWebSocket({ outcomes: ['ok'] }),
    timer,
    reconnect: { enabled: false, initialDelayMs: 250, maxDelayMs: 5000 },
    logger: { info() {}, error() {}, warn() {} },
  });
  obs.on('reconnecting', () => events.push('reconnecting'));

  await obs.connect();
  obs.getClient().emit('ConnectionClosed');

  assert.equal(obs.isConnected(), false);
  assert.equal(obs.isReconnecting(), false);
  assert.equal(timer.delays().length, 0, 'no reconnect scheduled when disabled');
  assert.deepEqual(events, []);
});
