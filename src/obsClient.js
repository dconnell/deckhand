import { writeFile } from 'node:fs/promises';
import { OBSWebSocket } from 'obs-websocket-js/json';
import { regionTransform } from './scenes.js';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

/**
 * Name of the Color Correction filter applied to the freeze image source.
 *
 * @type {string}
 */
const FREEZE_DIM_FILTER_NAME = 'Deckhand_Dim';

/**
 * OBS's built-in "Color Correction" filter kind, used to dim the freeze frame.
 *
 * @type {string}
 */
const COLOR_CORRECTION_FILTER_KIND = 'color_filter';
const SOURCE_STABILITY_SAMPLE_WIDTH = 320;
const SOURCE_STABILITY_SAMPLE_HEIGHT = 208;
const SOURCE_STABILITY_SAMPLE_QUALITY = 60;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function decodeImageDataUri(dataUri) {
  const base64 = typeof dataUri === 'string'
    ? dataUri.replace(/^data:image\/\w+;base64,/, '')
    : '';

  return Buffer.from(base64, 'base64');
}

async function waitForNamedScene({ getCurrentName, expectedName, logger, timeoutMs = 2000, pollIntervalMs = 50, kind }) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (await getCurrentName() === expectedName) {
      return;
    }

    await delay(pollIntervalMs);
  }

  logger.warn(`Timed out waiting for OBS ${kind} scene; continuing`, {
    expectedName,
    timeoutMs,
  });
}

/**
 * Create a thin OBS v5 wrapper used by the coordinator.
 *
 * @param {{ url: string, password: string, OBSWebSocketClass?: new () => { connect(url: string, password?: string): Promise<unknown>, disconnect(): Promise<unknown>, call(method: string, payload?: Record<string, unknown>): Promise<unknown>, on?(event: string, handler: (data: unknown) => void): void, off?(event: string, handler: (data: unknown) => void): void }, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void }, reconnect?: { enabled?: boolean, initialDelayMs?: number, maxDelayMs?: number }, timer?: { setTimeout(fn: () => void, ms: number): unknown, clearTimeout(handle: unknown): void } }} options Adapter options.
 * @returns {{ connect(): Promise<unknown>, disconnect(): Promise<void>, setScene(sceneName: string): Promise<void>, applyInputSettings(inputName: string, inputSettings: Record<string, unknown>): Promise<void>, isConnected(): boolean, isReconnecting(): boolean, on(event: 'reconnecting' | 'reconnected', handler: (event: string) => void): void, getClient(): unknown, getCurrentProgramScene(): Promise<string>, getCurrentPreviewScene(): Promise<string>, getCurrentTransitionName(): Promise<string>, getStudioModeEnabled(): Promise<boolean>, setStudioModeEnabled(enabled: boolean): Promise<void>, setPreviewScene(sceneName: string, options?: { timeoutMs?: number, pollIntervalMs?: number }): Promise<void>, triggerStudioModeTransition(options?: { targetSceneName?: string, timeoutMs?: number, pollIntervalMs?: number }): Promise<void>, getSourceScreenshotData(sourceName: string): Promise<string>, getProgramScreenshotBuffer(): Promise<Buffer>, getStreamStatus(): Promise<unknown>, captureProgramScreenshot(filePath: string): Promise<void>, setCurrentTransition(name: string, durationMs?: number): Promise<void>, switchProgramScene(sceneName: string, options?: { waitForEvent?: boolean, timeoutMs?: number }): Promise<void>, waitForSceneTransitionEnd(options?: { timeoutMs?: number }): Promise<void>, waitForSourceScreenshotStable(sourceName: string, options?: { differentFromData?: string | null, pollIntervalMs?: number, stableSamples?: number, timeoutMs?: number }): Promise<void>, ensureFreezeAssets(options: { sceneName: string, inputName: string, imagePath: string, dimPercent?: number }): Promise<void> }}
 */
export function createObsClient(options) {
  const logger = options.logger ?? createNoopLogger();
  const OBSWebSocketClass = options.OBSWebSocketClass ?? OBSWebSocket;
  const client = new OBSWebSocketClass();
  const timer = options.timer ?? {
    setTimeout(fn, ms) {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const reconnectConfig = options.reconnect ?? { enabled: true, initialDelayMs: 250, maxDelayMs: 5000 };
  let connected = false;
  let reconnecting = false;
  let stopped = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let listenersAttached = false;
  const lifecycleHandlers = new Map();
  const closeListeners = new Map();

  /**
   * Ensure the freeze image source carries a Color Correction filter dimmed by
   * `dimPercent`. The filter lives on the freeze image source, which only
   * appears in the freeze scene, so the dim is visible only while the freeze
   * masks a slide change — giving the presenter an immediate cue that the
   * advance registered. Idempotent: creates the filter if absent, otherwise
   * rewrites its opacity to match the configured value. A `dimPercent` of `0`
   * (or omitting it) leaves the source's filters untouched.
   *
   * @param {string} sourceName The freeze image input name.
   * @param {number | undefined} dimPercent Reduction in 0..100 applied as opacity.
   * @returns {Promise<void>}
   */
  async function ensureFreezeDimFilter(sourceName, dimPercent) {
    if (typeof dimPercent !== 'number' || dimPercent <= 0) {
      return;
    }

    const opacity = Math.round(100 - dimPercent);

    let filters = [];
    try {
      const list = await client.call('GetSourceFilterList', { sourceName });
      filters = Array.isArray(list?.filters) ? list.filters : [];
    } catch (error) {
      logger.warn('Failed to read OBS freeze image filters; skipping dim ensure', {
        error: error instanceof Error ? error.message : String(error),
        sourceName,
      });
      return;
    }

    const hasDimFilter = filters.some((filter) => filter?.filterName === FREEZE_DIM_FILTER_NAME);

    try {
      if (!hasDimFilter) {
        await client.call('CreateSourceFilter', {
          sourceName,
          filterName: FREEZE_DIM_FILTER_NAME,
          filterKind: COLOR_CORRECTION_FILTER_KIND,
          filterSettings: { opacity },
        });
        logger.info('Created OBS freeze dim filter', { sourceName, opacity });
      } else {
        await client.call('SetSourceFilterSettings', {
          sourceName,
          filterName: FREEZE_DIM_FILTER_NAME,
          filterSettings: { opacity },
          overlay: false,
        });
      }
    } catch (error) {
      logger.warn('Failed to apply OBS freeze dim filter', {
        error: error instanceof Error ? error.message : String(error),
        sourceName,
      });
    }
  }

  /**
   * Pin the freeze image's scene item to the full canvas at its native bounds.
   *
   * OBS's default scene-item transform leaves the item at its source-native
   * size/offset, so the canvas-sized freeze image renders cropped and zoomed
   * (left edge cut off) instead of filling the scene. Re-applied on every
   * ensure so canvas resolution changes are picked up. Failures warn and
   * continue so the rest of the ensure still runs.
   *
   * @param {{ sceneName: string, inputName: string, createdSceneItemId?: number | null }} args Transform target.
   * @returns {Promise<void>}
   */
  async function applyFreezeSceneItemTransform({ sceneName, inputName, createdSceneItemId = null }) {
    let baseWidth;
    let baseHeight;

    try {
      const video = await client.call('GetVideoSettings');
      baseWidth = video?.baseWidth;
      baseHeight = video?.baseHeight;
    } catch (error) {
      logger.warn('Failed to read OBS video settings; skipping freeze transform', {
        error: error instanceof Error ? error.message : String(error),
        sceneName,
        inputName,
      });
      return;
    }

    // Tolerate environments where canvas dimensions are unavailable (e.g. stubs)
    // rather than guessing geometry; a real failure to apply the transform below
    // still warns.
    if (!(Number.isFinite(baseWidth) && baseWidth > 0) || !(Number.isFinite(baseHeight) && baseHeight > 0)) {
      return;
    }

    try {
      let sceneItemId = createdSceneItemId;

      if (sceneItemId === null || sceneItemId === undefined) {
        const itemList = await client.call('GetSceneItemList', { sceneName });
        const items = Array.isArray(itemList?.sceneItems) ? itemList.sceneItems : [];
        const existing = items.find((item) => item?.sourceName === inputName);

        if (existing) {
          sceneItemId = existing.sceneItemId;
        } else {
          const createdItem = await client.call('CreateSceneItem', {
            sceneItemEnabled: true,
            sceneName,
            sourceName: inputName,
          });
          sceneItemId = createdItem?.sceneItemId;
        }
      }

      if (sceneItemId === null || sceneItemId === undefined) {
        logger.warn('Could not resolve the OBS freeze scene item; skipping freeze transform', {
          sceneName,
          inputName,
        });
        return;
      }

      await client.call('SetSceneItemTransform', {
        sceneItemId,
        sceneName,
        sceneItemTransform: regionTransform('full', baseWidth, baseHeight),
      });
    } catch (error) {
      logger.warn('Failed to apply OBS freeze scene item transform', {
        error: error instanceof Error ? error.message : String(error),
        sceneName,
        inputName,
      });
    }
  }

  async function getSourceScreenshotData(sourceName, { sample = false } = {}) {
    const payload = {
      sourceName,
      imageFormat: sample ? 'jpg' : 'png',
    };

    if (sample) {
      payload.imageCompressionQuality = SOURCE_STABILITY_SAMPLE_QUALITY;
      payload.imageHeight = SOURCE_STABILITY_SAMPLE_HEIGHT;
      payload.imageWidth = SOURCE_STABILITY_SAMPLE_WIDTH;
    }

    const screenshot = await client.call('GetSourceScreenshot', payload);

    return typeof screenshot?.imageData === 'string' ? screenshot.imageData : '';
  }

  function emitLifecycle(event) {
    const handlers = lifecycleHandlers.get(event);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        logger.warn('OBS lifecycle handler threw', {
          event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function computeBackoffDelay(attempt) {
    const base = reconnectConfig.initialDelayMs * (2 ** attempt);
    return Math.min(base, reconnectConfig.maxDelayMs);
  }

  function handleTransportClosed() {
    if (stopped || !connected) {
      return;
    }

    connected = false;

    if (!reconnectConfig.enabled || reconnecting) {
      return;
    }

    reconnecting = true;
    reconnectAttempt = 0;
    emitLifecycle('reconnecting');
    scheduleReconnect();
  }

  function attachCloseListeners() {
    if (listenersAttached || typeof client.on !== 'function') {
      return;
    }

    client.on('ConnectionClosed', handleTransportClosed);
    client.on('ConnectionError', handleTransportClosed);
    closeListeners.set('ConnectionClosed', handleTransportClosed);
    closeListeners.set('ConnectionError', handleTransportClosed);
    listenersAttached = true;
  }

  function detachCloseListeners() {
    if (typeof client.off !== 'function') {
      return;
    }

    for (const [event, handler] of closeListeners.entries()) {
      client.off(event, handler);
    }

    closeListeners.clear();
    listenersAttached = false;
  }

  function scheduleReconnect() {
    if (stopped || !reconnectConfig.enabled) {
      return;
    }

    const delay = computeBackoffDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = timer.setTimeout(attemptReconnect, delay);
  }

  async function attemptReconnect() {
    if (stopped || !reconnecting) {
      return;
    }

    try {
      await client.connect(options.url, options.password);
      connected = true;
      reconnecting = false;
      reconnectAttempt = 0;
      reconnectTimer = null;
      logger.info('Reconnected to OBS', { url: options.url });
      emitLifecycle('reconnected');
    } catch (error) {
      logger.warn('OBS reconnect attempt failed', {
        error: error instanceof Error ? error.message : String(error),
        url: options.url,
      });
      scheduleReconnect();
    }
  }

  return {
    async connect() {
      attachCloseListeners();
      try {
        const result = await client.connect(options.url, options.password);
        connected = true;
        reconnecting = false;
        reconnectAttempt = 0;
        logger.info('Connected to OBS', { url: options.url });
        return result;
      } catch (error) {
        connected = false;
        logger.error('Failed to connect to OBS', {
          error: error instanceof Error ? error.message : String(error),
          url: options.url,
        });
        throw error;
      }
    },

    async disconnect() {
      stopped = true;
      reconnecting = false;

      if (reconnectTimer !== null) {
        timer.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      detachCloseListeners();

      if (connected) {
        await client.disconnect();
        connected = false;
        logger.info('Disconnected from OBS');
      }
    },

    isReconnecting() {
      return reconnecting;
    },

    on(event, handler) {
      if (event !== 'reconnecting' && event !== 'reconnected') {
        return;
      }

      const handlers = lifecycleHandlers.get(event) ?? new Set();
      handlers.add(handler);
      lifecycleHandlers.set(event, handlers);
    },

    async setScene(sceneName) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      try {
        await client.call('SetCurrentProgramScene', { sceneName });
        logger.info('Switched OBS scene', { sceneName });
      } catch (error) {
        logger.error('Failed to switch OBS scene', {
          error: error instanceof Error ? error.message : String(error),
          sceneName,
        });
        throw error;
      }
    },

    async applyInputSettings(inputName, inputSettings) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      try {
        await client.call('SetInputSettings', {
          inputName,
          inputSettings,
          overlay: false,
        });
        logger.info('Applied OBS input settings', { inputName });
      } catch (error) {
        logger.error('Failed to apply OBS input settings', {
          error: error instanceof Error ? error.message : String(error),
          inputName,
        });
        throw error;
      }
    },

    isConnected() {
      return connected;
    },

    getClient() {
      return client;
    },

    async getCurrentProgramScene() {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      const list = await client.call('GetSceneList');
      return list.currentProgramSceneName;
    },

    async getCurrentPreviewScene() {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      const list = await client.call('GetSceneList');
      return list.currentPreviewSceneName;
    },

    async getStudioModeEnabled() {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      const state = await client.call('GetStudioModeEnabled');
      return state.studioModeEnabled === true;
    },

    async setStudioModeEnabled(enabled) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      await client.call('SetStudioModeEnabled', { studioModeEnabled: enabled === true });
    },

    async getCurrentTransitionName() {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      const transition = await client.call('GetCurrentSceneTransition');
      return transition.transitionName;
    },

    async captureProgramScreenshot(filePath) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      const sceneName = await this.getCurrentProgramScene();

      let shot;
      try {
        shot = await client.call('GetSourceScreenshot', {
          sourceName: sceneName,
          imageFormat: 'png',
        });
      } catch (error) {
        logger.error('Failed to capture OBS program screenshot', {
          error: error instanceof Error ? error.message : String(error),
          sceneName,
        });
        throw error;
      }

      const dataUri = typeof shot.imageData === 'string' ? shot.imageData : '';
      const decoded = decodeImageDataUri(dataUri);

      // A zero-byte capture renders as a fully black frame in OBS, so treat it
      // as a failure rather than arming a blank freeze frame for the audience.
      if (decoded.length === 0) {
        throw new Error('OBS returned an empty program screenshot');
      }

      try {
        await writeFile(filePath, decoded);
      } catch (error) {
        logger.error('Failed to write OBS screenshot to disk', {
          error: error instanceof Error ? error.message : String(error),
          filePath,
        });
        throw error;
      }
    },

    async getSourceScreenshotData(sourceName) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      return getSourceScreenshotData(sourceName);
    },

    async getProgramScreenshotBuffer() {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      const sceneName = await this.getCurrentProgramScene();
      const dataUri = await getSourceScreenshotData(sceneName, { sample: true });
      return decodeImageDataUri(dataUri);
    },

    async getStreamStatus() {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      return client.call('GetStreamStatus');
    },

    async setCurrentTransition(name, durationMs) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      try {
        await client.call('SetCurrentSceneTransition', { transitionName: name });

        if (durationMs !== undefined) {
          await client.call('SetCurrentSceneTransitionDuration', { transitionDuration: durationMs });
        }
      } catch (error) {
        logger.error('Failed to set OBS current transition', {
          error: error instanceof Error ? error.message : String(error),
          transitionName: name,
        });
        throw error;
      }
    },

    async setPreviewScene(sceneName, { timeoutMs = 2000, pollIntervalMs = 50 } = {}) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      try {
        await client.call('SetCurrentPreviewScene', { sceneName });
        await waitForNamedScene({
          expectedName: sceneName,
          getCurrentName: () => this.getCurrentPreviewScene(),
          kind: 'preview',
          logger,
          pollIntervalMs,
          timeoutMs,
        });
      } catch (error) {
        logger.error('Failed to switch OBS preview scene', {
          error: error instanceof Error ? error.message : String(error),
          sceneName,
        });
        throw error;
      }
    },

    async triggerStudioModeTransition({ targetSceneName, timeoutMs = 2000, pollIntervalMs = 50 } = {}) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      const expectedScene = targetSceneName ?? null;

      try {
        await client.call('TriggerStudioModeTransition');

        if (expectedScene !== null) {
          await waitForNamedScene({
            expectedName: expectedScene,
            getCurrentName: () => this.getCurrentProgramScene(),
            kind: 'program',
            logger,
            pollIntervalMs,
            timeoutMs,
          });
        }
      } catch (error) {
        logger.error('Failed to trigger OBS studio-mode transition', {
          error: error instanceof Error ? error.message : String(error),
          targetSceneName: expectedScene,
        });
        throw error;
      }
    },

    async switchProgramScene(sceneName, { waitForEvent = false, timeoutMs = 2000 } = {}) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      if (!waitForEvent) {
        try {
          await client.call('SetCurrentProgramScene', { sceneName });
          return;
        } catch (error) {
          logger.error('Failed to switch OBS program scene', {
            error: error instanceof Error ? error.message : String(error),
            sceneName,
          });
          throw error;
        }
      }

      await new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          clearTimeout(timer);

          if (typeof client.off === 'function') {
            client.off('CurrentProgramSceneChanged', handler);
          }
        };

        const timer = setTimeout(() => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          logger.warn('Timed out waiting for OBS scene change event; continuing', {
            sceneName,
            timeoutMs,
          });
          resolve();
        }, timeoutMs);

        const handler = (data) => {
          if (settled) {
            return;
          }

          // Only an exact scene-name match counts as success. OBS wraps the
          // payload differently across versions ({ sceneName } vs
          // { eventData: { sceneName } }), but a malformed event that carries
          // no name must never be reported as a completed scene change.
          const reported = data?.sceneName ?? data?.eventData?.sceneName ?? null;

          if (reported !== sceneName) {
            return;
          }

          settled = true;
          cleanup();
          resolve();
        };

        if (typeof client.on === 'function') {
          client.on('CurrentProgramSceneChanged', handler);
        }

        client.call('SetCurrentProgramScene', { sceneName }).catch((error) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          logger.error('Failed to switch OBS program scene', {
            error: error instanceof Error ? error.message : String(error),
            sceneName,
          });
          reject(error);
        });
      });
    },

    async waitForSceneTransitionEnd({ timeoutMs = 2000 } = {}) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      await new Promise((resolve) => {
        let settled = false;

        const cleanup = () => {
          clearTimeout(timer);

          if (typeof client.off === 'function') {
            client.off('SceneTransitionEnded', handler);
          }
        };

        const timer = setTimeout(() => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          logger.warn('Timed out waiting for OBS scene transition to end; continuing', { timeoutMs });
          resolve();
        }, timeoutMs);

        const handler = () => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          resolve();
        };

        if (typeof client.on === 'function') {
          client.on('SceneTransitionEnded', handler);
        }
      });
    },

    async waitForSourceScreenshotStable(sourceName, {
      differentFromData = null,
      // 50ms keeps screenshot polling from hammering OBS (a 10ms cadence
      // serialized every RPC behind the websocket) while still settling a
      // transition in a handful of samples.
      pollIntervalMs = 50,
      stableSamples = 2,
      timeoutMs = 2000,
    } = {}) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      const startedAt = Date.now();
      let previous = null;
      let unchangedSamples = 0;
      let totalSamples = 0;

      while (Date.now() - startedAt <= timeoutMs) {
        const current = await getSourceScreenshotData(sourceName, { sample: true });
        totalSamples += 1;

        const isMeaningfullyDifferent = differentFromData === null || current !== differentFromData;

        if (current !== '' && current === previous && isMeaningfullyDifferent) {
          unchangedSamples += 1;
        } else {
          unchangedSamples = isMeaningfullyDifferent ? 1 : 0;
          previous = current;
        }

        if (unchangedSamples >= stableSamples) {
          logger.info('OBS source screenshot stabilized', {
            sourceName,
            stableSamples,
            totalSamples,
          });
          return;
        }

        await delay(pollIntervalMs);
      }

      logger.warn('Timed out waiting for OBS source screenshot to stabilize; continuing', {
        pollIntervalMs,
        sourceName,
        stableSamples,
        timeoutMs,
        totalSamples,
      });
    },

    async ensureFreezeAssets({ sceneName, inputName, imagePath, dimPercent }) {
      if (!connected) {
        throw new Error('OBS client is not connected');
      }

      const sceneList = await client.call('GetSceneList');
      const existingScenes = new Set(sceneList.scenes.map((scene) => scene.sceneName));

      if (!existingScenes.has(sceneName)) {
        await client.call('CreateScene', { sceneName });
        logger.info('Created OBS freeze scene', { sceneName });
      }

      const inputList = await client.call('GetInputList');
      const hasInput = inputList.inputs.some((input) => input.inputName === inputName);

      if (!hasInput) {
        const createdInput = await client.call('CreateInput', {
          sceneItemEnabled: true,
          sceneName,
          inputKind: 'image_source',
          inputName,
          inputSettings: { file: imagePath },
        });
        logger.info('Created OBS freeze image source', { inputName, sceneName });

        await applyFreezeSceneItemTransform({
          sceneName,
          inputName,
          createdSceneItemId: createdInput?.sceneItemId ?? null,
        });
      } else {
        await client.call('SetInputSettings', {
          inputName,
          inputSettings: { file: imagePath },
          overlay: true,
        });

        await applyFreezeSceneItemTransform({ sceneName, inputName });
      }

      await ensureFreezeDimFilter(inputName, dimPercent);
    },
  };
}
