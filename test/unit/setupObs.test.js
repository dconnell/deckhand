import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { setupObs } from '../../src/setupObs.js';

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
          { source: 'BrowserPrimary', position: 'left' },
          { source: 'BrowserSecondary', position: 'right' },
        ],
        sources: ['BrowserPrimary', 'BrowserSecondary'],
      },
    },
    presenter: {
      stage: { x: 0, y: 0, width: 1800, height: 1168 },
    },
  };
}

function createFakeObsSocket() {
  let latestInstance = null;

  return class FakeObsSocket {
    constructor() {
      latestInstance = this;
      this.calls = [];
      this.video = { baseWidth: 1920, baseHeight: 1080 };
      this.scenes = [];
      this.inputs = [];
      this.sceneItemsByScene = new Map();
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
        this.video = {
          ...this.video,
          baseWidth: payload.baseWidth ?? this.video.baseWidth,
          baseHeight: payload.baseHeight ?? this.video.baseHeight,
        };
        return {};
      }

      if (method === 'GetSceneList') {
        return {
          scenes: this.scenes.map((sceneName) => ({ sceneName })),
        };
      }

      if (method === 'GetInputList') {
        return {
          inputs: this.inputs.map((inputName) => ({ inputName })),
        };
      }

      if (method === 'CreateScene') {
        this.scenes.push(payload.sceneName);
        this.sceneItemsByScene.set(payload.sceneName, []);
        return {};
      }

      if (method === 'GetSceneItemList') {
        return {
          sceneItems: this.sceneItemsByScene.get(payload.sceneName) ?? [],
        };
      }

      if (method === 'CreateInput') {
        this.inputs.push(payload.inputName);
        const sceneItems = this.sceneItemsByScene.get(payload.sceneName) ?? [];
        const sceneItemId = sceneItems.length + 1;
        sceneItems.push({ sceneItemId, sourceName: payload.inputName });
        this.sceneItemsByScene.set(payload.sceneName, sceneItems);
        return { sceneItemId };
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
      hotkeys: { next: 'F13', prev: 'F14' },
      slides: { intro: { layout: 'full-slide' } },
    }, null, 2), 'utf8');

    const exitCode = await setupObs({ configPath, logger });

    assert.equal(exitCode, 1);
    assert.match(logger.errors[0].message, /Invalid configuration at layouts:/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
