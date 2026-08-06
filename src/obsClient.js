import { writeFile } from 'node:fs/promises';
import { OBSWebSocket } from 'obs-websocket-js/json';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

/**
 * Create a thin OBS v5 wrapper used by the coordinator.
 *
 * @param {{ url: string, password: string, OBSWebSocketClass?: new () => { connect(url: string, password?: string): Promise<unknown>, disconnect(): Promise<unknown>, call(method: string, payload?: Record<string, unknown>): Promise<unknown>, on?(event: string, handler: (data: unknown) => void): void, off?(event: string, handler: (data: unknown) => void): void }, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Adapter options.
 * @returns {{ connect(): Promise<unknown>, disconnect(): Promise<void>, setScene(sceneName: string): Promise<void>, applyInputSettings(inputName: string, inputSettings: Record<string, unknown>): Promise<void>, isConnected(): boolean, getClient(): unknown, getCurrentProgramScene(): Promise<string>, getCurrentTransitionName(): Promise<string>, captureProgramScreenshot(filePath: string): Promise<void>, setCurrentTransition(name: string, durationMs?: number): Promise<void>, switchProgramScene(sceneName: string, options?: { waitForEvent?: boolean, timeoutMs?: number }): Promise<void>, waitForSceneTransitionEnd(options?: { timeoutMs?: number }): Promise<void>, ensureFreezeAssets(options: { sceneName: string, inputName: string, imagePath: string }): Promise<void> }}
 */
export function createObsClient(options) {
  const logger = options.logger ?? createNoopLogger();
  const OBSWebSocketClass = options.OBSWebSocketClass ?? OBSWebSocket;
  const client = new OBSWebSocketClass();
  let connected = false;

  return {
    async connect() {
      try {
        const result = await client.connect(options.url, options.password);
        connected = true;
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
      if (!connected) {
        return;
      }

      await client.disconnect();
      connected = false;
      logger.info('Disconnected from OBS');
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
      const base64 = dataUri.replace(/^data:image\/\w+;base64,/, '');

      try {
        await writeFile(filePath, Buffer.from(base64, 'base64'));
      } catch (error) {
        logger.error('Failed to write OBS screenshot to disk', {
          error: error instanceof Error ? error.message : String(error),
          filePath,
        });
        throw error;
      }
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

          const reported = data?.sceneName ?? data?.eventData?.sceneName ?? null;

          if (reported === null || reported === sceneName) {
            settled = true;
            cleanup();
            resolve();
          }
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
            client.off('CurrentSceneTransitionEnded', handler);
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
          client.on('CurrentSceneTransitionEnded', handler);
        }
      });
    },

    async ensureFreezeAssets({ sceneName, inputName, imagePath }) {
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
        await client.call('CreateInput', {
          sceneItemEnabled: true,
          sceneName,
          inputKind: 'image_source',
          inputName,
          inputSettings: { file: imagePath },
        });
        logger.info('Created OBS freeze image source', { inputName, sceneName });
      } else {
        await client.call('SetInputSettings', {
          inputName,
          inputSettings: { file: imagePath },
          overlay: true,
        });
      }
    },
  };
}
