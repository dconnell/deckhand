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
 * @param {{ url: string, password: string, OBSWebSocketClass?: new () => { connect(url: string, password?: string): Promise<unknown>, disconnect(): Promise<unknown>, call(method: string, payload?: Record<string, unknown>): Promise<unknown> }, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Adapter options.
 * @returns {{ connect(): Promise<unknown>, disconnect(): Promise<void>, setScene(sceneName: string): Promise<void>, applyInputSettings(inputName: string, inputSettings: Record<string, unknown>): Promise<void>, isConnected(): boolean, getClient(): unknown }}
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
          overlay: true,
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
  };
}
