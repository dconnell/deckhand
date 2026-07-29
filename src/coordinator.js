import { buildPresentationState } from './scenes.js';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

/**
 * Create the coordinator orchestration layer.
 *
 * The coordinator resolves slide config into typed browser commands and
 * dispatches them through an injected executor. It does not own browser logic
 * directly; the executor seam keeps slide-event orchestration decoupled from the
 * Deckhand browser session runtime.
 *
 * @param {{ config: { driver: { type: string }, layouts: Record<string, unknown>, slides: Record<string, { layoutId: string, commands: Array<{ type: string, source: string, tab?: string, url?: string, [key: string]: unknown }> }> }, obs: { connect(): Promise<unknown>, disconnect(): Promise<unknown>, setScene(sceneName: string): Promise<unknown>, isConnected?(): boolean }, hub: { on(eventName: string, handler: (payload: unknown) => Promise<void> | void): void, start(): Promise<unknown>, stop(): Promise<unknown>, sendCommand(target: { role?: 'driver' }, command: Record<string, unknown>): Promise<unknown>, publishSticky(channel: string, payload: Record<string, unknown>): Promise<unknown>, getSnapshot(): { activeDriver: Record<string, unknown> | null, observers: Array<Record<string, unknown>>, sticky: Record<string, unknown> } }, hotkeys: { on(eventName: string, handler: (payload: unknown) => Promise<void> | void): void, start(): Promise<unknown>, stop(): Promise<unknown> }, executor?: { start(): Promise<void>, stop(): Promise<void>, execute(command: Record<string, unknown>): Promise<void> } | null, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Coordinator dependencies.
 * @returns {{ start(options?: { enableHotkeys?: boolean }): Promise<void>, enableHotkeys(): Promise<void>, stop(): Promise<void>, handleDriverPositionChanged(position: { id: string, index?: Record<string, unknown>, meta?: Record<string, unknown> }): Promise<void>, handleHotkeyAction(action: { type: 'next' | 'prev' | 'goTo', id?: string }), getCurrentPresentationState(): Record<string, unknown> | null }}
 */
export function createCoordinator(options) {
  const logger = options.logger ?? createNoopLogger();
  const executor = options.executor ?? null;
  let started = false;
  let obsStarted = false;
  let hubStarted = false;
  let executorStarted = false;
  let hotkeysStarted = false;
  let presentationSeq = 0;
  let currentPresentationState = null;
  const runtimeWindowBindings = {};

  function buildResolvedPresentationState(slideId, seq) {
    return buildPresentationState(slideId, options.config, seq, {
      windowBindings: runtimeWindowBindings,
    });
  }

  async function publishPresentationState(slideId) {
    presentationSeq += 1;
    const state = buildResolvedPresentationState(slideId, presentationSeq);
    currentPresentationState = state;
    await options.hub.publishSticky('presentationState', state);
    return state;
  }

  async function republishCurrentPresentationState(reason) {
    if (currentPresentationState === null) {
      return;
    }

    let presentationState;

    try {
      presentationState = await publishPresentationState(currentPresentationState.slideId);
      logger.info('Republished presentation state for runtime binding update', {
        reason,
        seq: presentationState.seq,
        slideId: presentationState.slideId,
      });
    } catch (error) {
      presentationState = buildResolvedPresentationState(currentPresentationState.slideId, presentationSeq);
      currentPresentationState = presentationState;
      logger.error('Observer state republish failed', {
        error: error instanceof Error ? error.message : String(error),
        reason,
        slideId: presentationState.slideId,
      });
    }
  }

  function mergeRuntimeWindowBindings(payload) {
    let changed = false;

    for (const source of payload.cleared ?? []) {
      if (Object.prototype.hasOwnProperty.call(runtimeWindowBindings, source)) {
        delete runtimeWindowBindings[source];
        changed = true;
      }
    }

    for (const [source, binding] of Object.entries(payload.bindings ?? {})) {
      const current = runtimeWindowBindings[source];
      const next = { ...binding };

      if (current === undefined || JSON.stringify(current) !== JSON.stringify(next)) {
        runtimeWindowBindings[source] = next;
        changed = true;
      }
    }

    return changed;
  }

  async function dispatchBrowserCommands(slideConfig, slideId) {
    if (executor === null) {
      return;
    }

    for (const command of slideConfig.commands) {
      try {
        await executor.execute(command);
        logger.info('Dispatched browser command', {
          commandType: command.type,
          slideId,
          source: command.source,
          tab: command.tab,
        });
      } catch (error) {
        logger.error('Browser command failed', {
          commandType: command.type,
          error: error instanceof Error ? error.message : String(error),
          slideId,
          source: command.source,
          tab: command.tab,
        });
      }
    }
  }

  async function handleDriverPositionChanged(position) {
    const slideConfig = options.config.slides[position.id];

    if (slideConfig === undefined) {
      logger.warn('No slide actions configured for reported slide', { slideId: position.id });
      return;
    }

    let presentationState;

    try {
      presentationState = await publishPresentationState(position.id);
      logger.info('Published presentation state for slide', {
        layoutId: presentationState.layoutId,
        seq: presentationState.seq,
        slideId: position.id,
      });
    } catch (error) {
      presentationState = buildResolvedPresentationState(position.id, presentationSeq);
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

    await dispatchBrowserCommands(slideConfig, position.id);
  }

  async function handleObserverWindowBindings(payload) {
    if (!mergeRuntimeWindowBindings(payload)) {
      return;
    }

    await republishCurrentPresentationState('windowBindingsChanged');
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

  async function startHotkeys() {
    if (hotkeysStarted) {
      return;
    }

    await options.hotkeys.start();
    hotkeysStarted = true;
  }

  options.hub.on('driverPositionChanged', handleDriverPositionChanged);
  options.hub.on('driverRegistered', () => logSnapshot('Driver client registered'));
  options.hub.on('observerRegistered', () => logSnapshot('Observer client registered'));
  options.hub.on('observerWindowBindings', handleObserverWindowBindings);
  options.hub.on('clientDisconnected', () => logSnapshot('Client disconnected'));
  options.hotkeys.on('action', handleHotkeyAction);

  return {
    async start(startOptions = {}) {
      if (started) {
        return;
      }

      logger.info('Starting coordinator', { driver: options.config.driver.type });

      try {
        await options.obs.connect();
        obsStarted = true;
        await options.hub.start();
        hubStarted = true;

        if (executor !== null) {
          await executor.start();
          executorStarted = true;
        }

        if (startOptions.enableHotkeys !== false) {
          await startHotkeys();
        }

        started = true;
        logger.info('Coordinator started', { driver: options.config.driver.type });
      } catch (error) {
        if (hotkeysStarted) {
          await options.hotkeys.stop().catch(() => {});
          hotkeysStarted = false;
        }

        if (executorStarted) {
          await executor?.stop().catch(() => {});
          executorStarted = false;
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

    async enableHotkeys() {
      if (!started) {
        throw new Error('coordinator is not started');
      }

      await startHotkeys();
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
          if (executorStarted) {
            await executor?.stop();
            executorStarted = false;
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
      }
    },

    getCurrentPresentationState() {
      return currentPresentationState;
    },

    handleDriverPositionChanged,
    handleHotkeyAction,
  };
}
