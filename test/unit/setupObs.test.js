import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { reconcileObsPresentation, setupObs } from '../../src/setupObs.js';

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

function createConfig() {
  return {
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
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
    presenter: {
      stage: { x: 0, y: 0, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        BrowserA: { app: 'Google Chrome', titleIncludes: 'Deckhand Demo Primary' },
        BrowserB: { app: 'Google Chrome', titleIncludes: 'Deckhand Demo Secondary' },
      },
    },
  };
}

function createStrictBindingConfig() {
  return {
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    layouts: {
      'full-slide': {
        id: 'full-slide',
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full' }],
        sources: ['Slide'],
      },
    },
    presenter: {
      stage: { x: 0, y: 0, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
      },
    },
  };
}

function createFakeObsSocket() {
  let latestInstance = null;
  const sharedState = {
    calls: [],
    inputs: [],
    inputKinds: new Map(),
    sceneItemsByScene: new Map(),
    scenes: [],
    video: { baseWidth: 1920, baseHeight: 1080 },
  };

  return class FakeObsSocket {
    constructor() {
      latestInstance = this;
      this.calls = sharedState.calls;
      this.video = sharedState.video;
      this.scenes = sharedState.scenes;
      this.inputs = sharedState.inputs;
      this.inputKinds = sharedState.inputKinds;
      this.sceneItemsByScene = sharedState.sceneItemsByScene;
    }

    async connect(url, password) {
      this.connected = { url, password };
      return {};
    }

    async disconnect() {
      this.disconnected = true;
    }

    async call(method, payload = {}) {
      this.calls.push({ method, payload });

      if (method === 'GetVersion') {
        return {
          obsVersion: '31.0.0',
          obsWebSocketVersion: '5.0.0',
          platform: 'macOS',
        };
      }

      if (method === 'GetVideoSettings') {
        return this.video;
      }

      if (method === 'SetVideoSettings') {
        this.video.baseWidth = payload.baseWidth ?? this.video.baseWidth;
        this.video.baseHeight = payload.baseHeight ?? this.video.baseHeight;
        return {};
      }

      if (method === 'GetSceneList') {
        return {
          scenes: this.scenes.map((sceneName) => ({ sceneName })),
        };
      }

      if (method === 'GetInputList') {
        return {
          inputs: this.inputs.map((inputName) => ({ inputName, inputKind: this.inputKinds.get(inputName) ?? 'window_capture' })),
        };
      }

      if (method === 'CreateScene') {
        this.scenes.push(payload.sceneName);
        this.sceneItemsByScene.set(payload.sceneName, []);
        return {};
      }

      if (method === 'RemoveScene') {
        const sceneIndex = this.scenes.indexOf(payload.sceneName);
        if (sceneIndex !== -1) {
          this.scenes.splice(sceneIndex, 1);
        }
        this.sceneItemsByScene.delete(payload.sceneName);
        return {};
      }

      if (method === 'GetSceneItemList') {
        return {
          sceneItems: this.sceneItemsByScene.get(payload.sceneName) ?? [],
        };
      }

      if (method === 'RemoveSceneItem') {
        const sceneItems = this.sceneItemsByScene.get(payload.sceneName) ?? [];
        this.sceneItemsByScene.set(
          payload.sceneName,
          sceneItems.filter((item) => item.sceneItemId !== payload.sceneItemId),
        );
        return {};
      }

      if (method === 'CreateInput') {
        this.inputs.push(payload.inputName);
        this.inputKinds.set(payload.inputName, payload.inputKind);
        const sceneItems = this.sceneItemsByScene.get(payload.sceneName) ?? [];
        const sceneItemId = sceneItems.length + 1;
        sceneItems.push({ sceneItemId, sourceName: payload.inputName });
        this.sceneItemsByScene.set(payload.sceneName, sceneItems);
        return { sceneItemId };
      }

      if (method === 'SetInputSettings') {
        return {};
      }

      if (method === 'RemoveInput') {
        const inputIndex = this.inputs.indexOf(payload.inputName);
        if (inputIndex !== -1) {
          this.inputs.splice(inputIndex, 1);
        }
        this.inputKinds.delete(payload.inputName);

        for (const [sceneName, sceneItems] of this.sceneItemsByScene.entries()) {
          this.sceneItemsByScene.set(sceneName, sceneItems.filter((item) => item.sourceName !== payload.inputName));
        }

        return {};
      }

      if (method === 'CreateSceneItem') {
        const sceneItems = this.sceneItemsByScene.get(payload.sceneName) ?? [];
        const sceneItemId = sceneItems.length + 1;
        sceneItems.push({ sceneItemId, sourceName: payload.sourceName });
        this.sceneItemsByScene.set(payload.sceneName, sceneItems);
        return { sceneItemId };
      }

      if (method === 'SetSceneItemTransform') {
        return {};
      }

      throw new Error(`Unexpected OBS call: ${method}`);
    }

    static getLatestInstance() {
      return latestInstance;
    }
  };
}

test('setupObs warns on presenter stage mismatch by default and still applies layout-derived scenes', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();

  const exitCode = await setupObs({
    config: createConfig(),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(exitCode, 0);
  assert.match(logger.warns[0].message, /OBS canvas does not match presenter stage dimensions/i);

  const client = FakeObsSocket.getLatestInstance();
  assert.equal(client.calls.some((entry) => entry.method === 'SetVideoSettings'), false);
  assert.equal(client.calls.some((entry) => entry.method === 'CreateScene'), true);
  assert.equal(client.calls.some((entry) => entry.method === 'SetSceneItemTransform'), true);
});

test('setupObs does not emit circular logger contexts in successful CLI-style runs', async () => {
  const logger = {
    error(message, context) {
      JSON.stringify({ message, context });
    },
    info(message, context) {
      JSON.stringify({ message, context });
    },
    warn(message, context) {
      JSON.stringify({ message, context });
    },
  };
  const FakeObsSocket = createFakeObsSocket();

  const exitCode = await setupObs({
    config: createConfig(),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(exitCode, 0);
});

test('setupObs applies presenter stage dimensions to OBS canvas when --set-canvas is enabled', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();

  const exitCode = await setupObs({
    config: createConfig(),
    logger,
    options: { check: false, setCanvas: true },
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(exitCode, 0);

  const client = FakeObsSocket.getLatestInstance();
  assert.deepEqual(
    client.calls.filter((entry) => entry.method === 'SetVideoSettings').map((entry) => entry.payload),
    [{ baseWidth: 1800, baseHeight: 1168 }],
  );
});

test('setupObs check mode is read-only and fails on drift', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();

  const exitCode = await setupObs({
    config: createConfig(),
    logger,
    options: { check: true, setCanvas: false },
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(exitCode, 1);
  assert.match(logger.errors[0].message, /OBS canvas does not match presenter stage dimensions/i);

  const client = FakeObsSocket.getLatestInstance();
  assert.equal(client.calls.some((entry) => entry.method === 'CreateScene'), false);
  assert.equal(client.calls.some((entry) => entry.method === 'SetVideoSettings'), false);
});

test('setupObs reports invalid config errors clearly without throwing', async () => {
  const logger = createLogger();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-setup-obs-invalid-'));
  const configPath = path.join(tempDir, 'config.json');

  try {
    await writeFile(configPath, JSON.stringify({
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { port: 8765 },
      slides: { intro: { layout: 'full-slide' } },
    }, null, 2), 'utf8');

    const exitCode = await setupObs({ configPath, logger });

    assert.equal(exitCode, 1);
    assert.match(logger.errors[0].message, /Invalid configuration at sources:/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('setupObs recreates stale managed inputs with bootstrap capture settings', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();

  const exitCode = await setupObs({
    config: createConfig(),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(exitCode, 0);

  const client = FakeObsSocket.getLatestInstance();
  client.inputs = ['Deckhand_Slide', 'Deckhand_BrowserA', 'Deckhand_BrowserB'];
  client.inputKinds.set('Deckhand_Slide', 'window_capture');
  client.inputKinds.set('Deckhand_BrowserA', 'window_capture');
  client.inputKinds.set('Deckhand_BrowserB', 'window_capture');
  client.scenes = ['Deckhand_Full Slide', 'Deckhand_Dual Browser'];
  client.sceneItemsByScene.set('Deckhand_Full Slide', [{ sceneItemId: 1, sourceName: 'Deckhand_Slide' }]);
  client.sceneItemsByScene.set('Deckhand_Dual Browser', [
    { sceneItemId: 1, sourceName: 'Deckhand_BrowserA' },
    { sceneItemId: 2, sourceName: 'Deckhand_BrowserB' },
  ]);
  client.calls.length = 0;

  const secondExitCode = await setupObs({
    config: createConfig(),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(secondExitCode, 0);
  assert.deepEqual(
    client.calls.filter((entry) => entry.method === 'RemoveInput').map((entry) => entry.payload.inputName).sort(),
    [],
  );
  assert.deepEqual(
    client.calls.filter((entry) => entry.method === 'SetInputSettings').map((entry) => entry.payload.inputName).sort(),
    ['Deckhand_BrowserA', 'Deckhand_BrowserB', 'Deckhand_Slide'],
  );
  assert.deepEqual(
    client.calls.filter((entry) => entry.method === 'SetInputSettings').map((entry) => ({
      inputName: entry.payload.inputName,
      inputSettings: entry.payload.inputSettings,
    })),
    [
      {
        inputName: 'Deckhand_Slide',
        inputSettings: {
          owner_name: 'Google Chrome',
          window_name: 'Deckhand Deck',
          window: 0,
        },
      },
      {
        inputName: 'Deckhand_BrowserA',
        inputSettings: {
          owner_name: 'Google Chrome',
          window_name: 'Deckhand Demo Primary',
          window: 0,
        },
      },
      {
        inputName: 'Deckhand_BrowserB',
        inputSettings: {
          owner_name: 'Google Chrome',
          window_name: 'Deckhand Demo Secondary',
          window: 0,
        },
      },
    ],
  );
});

test('reconcileObsPresentation applies strict bindings with a two-step window reset before exact id', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();

  const bootstrapExitCode = await setupObs({
    config: createStrictBindingConfig(),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(bootstrapExitCode, 0);

  const client = FakeObsSocket.getLatestInstance();
  client.calls.length = 0;
  client.sceneItemsByScene.set('Deckhand_Full Slide', []);

  await reconcileObsPresentation({
    config: createStrictBindingConfig(),
    logger,
    obs: client,
    windowBindings: {
      Slide: {
        app: 'Google Chrome',
        macWindowId: 12345,
        pid: 47213,
        strict: true,
      },
    },
  });

  assert.equal(client.calls.some((entry) => entry.method === 'RemoveInput' && entry.payload.inputName === 'Deckhand_Slide'), false);

  const slideSettingCalls = client.calls.filter(
    (entry) => entry.method === 'SetInputSettings' && entry.payload.inputName === 'Deckhand_Slide',
  );

  assert.ok(slideSettingCalls.length >= 2);
  const resetCall = slideSettingCalls.find((entry) => entry.payload.inputSettings?.window === 0);
  const strictCall = slideSettingCalls.find((entry) => entry.payload.inputSettings?.window === 12345);
  assert.ok(resetCall);
  assert.ok(strictCall);
});

test('reconcileObsPresentation rebuilds a managed scene when OBS rejects CreateSceneItem', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();

  const bootstrapExitCode = await setupObs({
    config: createConfig(),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(bootstrapExitCode, 0);

  const client = FakeObsSocket.getLatestInstance();
  client.calls.length = 0;
  for (const sceneName of client.scenes) {
    client.sceneItemsByScene.set(sceneName, []);
  }

  let injectedFailure = false;
  const originalCall = client.call.bind(client);
  client.call = async (method, payload = {}) => {
    if (!injectedFailure && method === 'CreateSceneItem') {
      injectedFailure = true;
      const error = new Error('Failed to create the scene item.');
      error.code = 700;
      throw error;
    }

    return originalCall(method, payload);
  };

  await reconcileObsPresentation({
    config: createConfig(),
    logger,
    obs: client,
    windowBindings: {},
  });

  assert.equal(injectedFailure, true);
  assert.ok(client.calls.some((entry) => entry.method === 'RemoveScene' && entry.payload.sceneName.startsWith('Deckhand_')));
  assert.ok(client.calls.some((entry) => entry.method === 'CreateScene' && entry.payload.sceneName.startsWith('Deckhand_')));
  const fullSlideItems = client.sceneItemsByScene.get('Deckhand_Full Slide') ?? [];
  assert.ok(fullSlideItems.some((item) => item.sourceName === 'Deckhand_Slide'));
});

test('setupObs removes stale scene items that are not part of the layout model', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();
  const client = new FakeObsSocket();

  client.scenes.push('Deckhand_Full Browser');
  client.sceneItemsByScene.set('Deckhand_Full Browser', [
    { sceneItemId: 1, sourceName: 'Deckhand_BrowserA' },
    { sceneItemId: 2, sourceName: 'Deckhand_BrowserPrimary' },
    { sceneItemId: 3, sourceName: 'Deckhand_Browser' },
  ]);

  const config = createConfig();
  config.layouts['full-browser'] = {
    id: 'full-browser',
    audienceScene: 'Full Browser',
    slots: [{ source: 'BrowserA', position: 'full' }],
    sources: ['BrowserA'],
  };

  const exitCode = await setupObs({
    config,
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(
    client.calls.filter((entry) => entry.method === 'RemoveSceneItem').map((entry) => entry.payload.sceneItemId).sort(),
    [2, 3],
  );
});

function createPruneConfig({ includeB = true, includeC = true, transitions = null } = {}) {
  const layouts = {
    'full-a': { id: 'full-a', audienceScene: 'Full A', slots: [{ source: 'RandomAppA', position: 'full' }], sources: ['RandomAppA'] },
  };

  if (includeB) {
    layouts['full-b'] = { id: 'full-b', audienceScene: 'Full B', slots: [{ source: 'RandomAppB', position: 'full' }], sources: ['RandomAppB'] };
  }

  if (includeC) {
    layouts['full-c'] = { id: 'full-c', audienceScene: 'Full C', slots: [{ source: 'RandomAppC', position: 'full' }], sources: ['RandomAppC'] };
  }

  const resolvedTransitions = transitions === null
    ? null
    : { freezeScene: 'Deckhand_Freeze', freezeImage: 'Deckhand_Freeze Frame', ...transitions };

  return {
    obs: { url: 'ws://127.0.0.1:4455', password: '', prune: true, transitions: resolvedTransitions },
    layouts,
    presenter: null,
  };
}

test('reconcileObsPresentation prunes Deckhand_ inputs and scenes dropped from the config', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();

  await setupObs({
    config: createPruneConfig({ includeB: true, includeC: true }),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  const client = FakeObsSocket.getLatestInstance();
  // Simulate the operator's own, non-Deckhand OBS content alongside Deckhand's.
  client.inputs.push('MyPersonalInput');
  client.scenes.push('MyIntroScene');
  client.calls.length = 0;

  const exitCode = await setupObs({
    config: createPruneConfig({ includeB: false, includeC: false }),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(exitCode, 0);

  assert.deepEqual(
    client.calls.filter((entry) => entry.method === 'RemoveInput').map((entry) => entry.payload.inputName).sort(),
    ['Deckhand_RandomAppB', 'Deckhand_RandomAppC'],
  );
  assert.deepEqual(
    client.calls.filter((entry) => entry.method === 'RemoveScene').map((entry) => entry.payload.sceneName).sort(),
    ['Deckhand_Full B', 'Deckhand_Full C'],
  );

  // Non-Deckhand content survives, and the still-desired Deckhand input remains.
  assert.ok(client.inputs.includes('Deckhand_RandomAppA'));
  assert.ok(client.inputs.includes('MyPersonalInput'));
  assert.ok(client.scenes.includes('Deckhand_Full A'));
  assert.ok(client.scenes.includes('MyIntroScene'));
  assert.equal(client.inputs.includes('Deckhand_RandomAppB'), false);
  assert.equal(client.scenes.includes('Deckhand_Full C'), false);
});

test('reconcileObsPresentation leaves Deckhand_ entities alone when obs.prune is false', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();

  await setupObs({
    config: createPruneConfig({ includeB: true, includeC: true }),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  const client = FakeObsSocket.getLatestInstance();
  client.calls.length = 0;

  const noPruneConfig = createPruneConfig({ includeB: false, includeC: false });
  noPruneConfig.obs.prune = false;

  const exitCode = await setupObs({
    config: noPruneConfig,
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(exitCode, 0);
  assert.equal(client.calls.some((entry) => entry.method === 'RemoveInput'), false);
  assert.equal(client.calls.some((entry) => entry.method === 'RemoveScene'), false);
  // The dropped inputs still linger because pruning is disabled.
  assert.ok(client.inputs.includes('Deckhand_RandomAppB'));
});

test('reconcileObsPresentation retains freeze assets with transitions and prunes them without', async () => {
  const logger = createLogger();
  const FakeObsSocket = createFakeObsSocket();

  await setupObs({
    config: createPruneConfig({ transitions: { forward: 'Slide Right', backward: 'Slide Left' } }),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  const client = FakeObsSocket.getLatestInstance();
  // Freeze assets are normally created by the coordinator; seed them as existing.
  client.inputs.push('Deckhand_Freeze Frame');
  client.scenes.push('Deckhand_Freeze');
  client.calls.length = 0;

  // Transitions still configured: freeze assets are desired and must survive.
  await setupObs({
    config: createPruneConfig({ transitions: { forward: 'Slide Right', backward: 'Slide Left' } }),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.equal(client.calls.some((entry) => entry.method === 'RemoveInput' && entry.payload.inputName === 'Deckhand_Freeze Frame'), false);
  assert.equal(client.calls.some((entry) => entry.method === 'RemoveScene' && entry.payload.sceneName === 'Deckhand_Freeze'), false);

  client.calls.length = 0;

  // Transitions dropped: freeze assets are no longer desired and are pruned.
  await setupObs({
    config: createPruneConfig({ transitions: null }),
    logger,
    OBSWebSocketClass: FakeObsSocket,
  });

  assert.ok(client.calls.some((entry) => entry.method === 'RemoveInput' && entry.payload.inputName === 'Deckhand_Freeze Frame'));
  assert.ok(client.calls.some((entry) => entry.method === 'RemoveScene' && entry.payload.sceneName === 'Deckhand_Freeze'));
});
