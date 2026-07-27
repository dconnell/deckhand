import { buildPresentationState } from './scenes.js';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

function buildOutboundCommand(command) {
  const { target, ...payload } = command;
  return payload;
}

/**
 * Create the coordinator orchestration layer.
 *
 * @param {{ config: { driver: { type: string }, layouts: Record<string, unknown>, slides: Record<string, { layoutId: string, commands: Array<{ type: string, target: { controllerId: string, tabId: string | null }, [key: string]: unknown }> }> }, obs: { connect(): Promise<unknown>, disconnect(): Promise<unknown>, setScene(sceneName: string): Promise<unknown>, isConnected?(): boolean }, hub: { on(eventName: string, handler: (payload: unknown) => Promise<void> | void): void, start(): Promise<unknown>, stop(): Promise<unknown>, sendCommand(target: Record<string, unknown>, command: Record<string, unknown>): Promise<unknown>, publishSticky(channel: string, payload: Record<string, unknown>): Promise<unknown>, getSnapshot(): { activeDriver: Record<string, unknown> | null, observers: Array<Record<string, unknown>>, sticky: Record<string, unknown>, targets: Array<Record<string, unknown>> } }, hotkeys: { on(eventName: string, handler: (payload: unknown) => Promise<void> | void): void, start(): Promise<unknown>, stop(): Promise<unknown> }, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Coordinator dependencies.
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, handleDriverPositionChanged(position: { id: string, index?: Record<string, unknown>, meta?: Record<string, unknown> }): Promise<void>, handleHotkeyAction(action: { type: 'next' | 'prev' | 'goTo', id?: string }), getCurrentPresentationState(): Record<string, unknown> | null }}
 */
export function createCoordinator(options) {
  const logger = options.logger ?? createNoopLogger();
  let started = false;
  let obsStarted = false;
  let hubStarted = false;
  let hotkeysStarted = false;
  let presentationSeq = 0;
  let currentPresentationState = null;

  async function publishPresentationState(position) {
    presentationSeq += 1;
    const state = buildPresentationState(position.id, options.config, presentationSeq);
    currentPresentationState = state;
    await options.hub.publishSticky('presentationState', state);
    return state;
  }

  async function handleDriverPositionChanged(position) {
    const slideConfig = options.config.slides[position.id];

    if (slideConfig === undefined) {
      logger.warn('No slide actions configured for reported slide', { slideId: position.id });
      return;
    }

    let presentationState;

    try {
      presentationState = await publishPresentationState(position);
      logger.info('Published presentation state for slide', {
        layoutId: presentationState.layoutId,
        seq: presentationState.seq,
        slideId: position.id,
      });
    } catch (error) {
      presentationState = buildPresentationState(position.id, options.config, presentationSeq);
      currentPresentationState = presentationState;
      logger.error('Observer state publish failed', {
        error: error instanceof Error ? error.message : String(error),
        slideId: position.id,
      });
    }

    try {
      await options.obs.setScene(presentationState.audienceScene);
      logger.info('Applied OBS scene for slide', {
        scene: presentationState.audienceScene,
        slideId: position.id,
      });
    } catch (error) {
      logger.error('OBS scene switch failed', {
        error: error instanceof Error ? error.message : String(error),
        scene: presentationState.audienceScene,
        slideId: position.id,
      });
    }

    for (const command of slideConfig.commands) {
      try {
        await options.hub.sendCommand(command.target, buildOutboundCommand(command));
        logger.info('Dispatched slide command', {
          commandType: command.type,
          slideId: position.id,
          target: command.target,
        });
      } catch (error) {
        logger.error('Target command failed', {
          commandType: command.type,
          error: error instanceof Error ? error.message : String(error),
          slideId: position.id,
          target: command.target,
        });
      }
    }
  }

  async function handleHotkeyAction(action) {
    const snapshot = options.hub.getSnapshot();

    if (snapshot.activeDriver === null) {
      logger.warn('Hotkey pressed with no active driver connected', { action: action.type });
    }

    try {
      await options.hub.sendCommand({ role: 'driver' }, action);
      logger.info('Dispatched hotkey action to driver', { action: action.type });
    } catch (error) {
      logger.error('Driver command failed', {
        action: action.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function logSnapshot(message) {
    logger.info(message, options.hub.getSnapshot());
  }

  options.hub.on('driverPositionChanged', handleDriverPositionChanged);
  options.hub.on('driverRegistered', () => logSnapshot('Driver client registered'));
  options.hub.on('observerRegistered', () => logSnapshot('Observer client registered'));
  options.hub.on('targetRegistered', () => logSnapshot('Target client registered'));
  options.hub.on('clientDisconnected', () => logSnapshot('Client disconnected'));
  options.hotkeys.on('action', handleHotkeyAction);

  return {
    async start() {
      if (started) {
        return;
      }

      logger.info('Starting coordinator', { driver: options.config.driver.type });

      try {
        await options.obs.connect();
        obsStarted = true;
        await options.hub.start();
        hubStarted = true;
        await options.hotkeys.start();
        hotkeysStarted = true;
        started = true;
        logger.info('Coordinator started', { driver: options.config.driver.type });
      } catch (error) {
        if (hotkeysStarted) {
          await options.hotkeys.stop().catch(() => {});
          hotkeysStarted = false;
        }

        if (hubStarted) {
          await options.hub.stop().catch(() => {});
          hubStarted = false;
        }

        if (obsStarted) {
          await options.obs.disconnect().catch(() => {});
          obsStarted = false;
        }

        throw error;
      }
    },

    async stop() {
      if (!started) {
        return;
      }

      logger.info('Stopping coordinator');

      try {
        if (hotkeysStarted) {
          await options.hotkeys.stop();
          hotkeysStarted = false;
        }
      } finally {
        try {
          if (hubStarted) {
            await options.hub.stop();
            hubStarted = false;
          }
        } finally {
          if (obsStarted) {
            await options.obs.disconnect();
            obsStarted = false;
          }

          started = false;
          logger.info('Coordinator stopped');
        }
      }
    },

    getCurrentPresentationState() {
      return currentPresentationState;
    },

    handleDriverPositionChanged,
    handleHotkeyAction,
  };
}
