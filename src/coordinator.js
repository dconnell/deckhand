import { buildPresentationState } from './scenes.js';
import { buildMacWindowCaptureSettings } from './setupObs.js';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

function isBrowserSource(config, sourceId) {
  return config.sources[sourceId]?.kind === 'browser';
}

/**
 * Create the coordinator orchestration layer.
 *
 * The coordinator resolves slide config into typed browser commands and
 * dispatches them through an injected executor. It does not own browser logic
 * directly; the executor seam keeps slide-event orchestration decoupled from the
 * Deckhand browser session runtime.
 *
 * @param {{ config: { driver: { type: string }, layouts: Record<string, unknown>, slides: Record<string, { layoutId: string, commands: Array<{ type: string, source: string, tab?: string, url?: string, [key: string]: unknown }> }> }, obs: { connect(): Promise<unknown>, disconnect(): Promise<unknown>, setScene(sceneName: string): Promise<unknown>, isConnected?(): boolean }, hub: { on(eventName: string, handler: (payload: unknown) => Promise<void> | void): void, start(): Promise<unknown>, stop(): Promise<unknown>, sendCommand(target: { role?: 'driver' }, command: Record<string, unknown>): Promise<unknown>, publishSticky(channel: string, payload: Record<string, unknown>): Promise<unknown>, getSnapshot(): { activeDriver: Record<string, unknown> | null, observers: Array<Record<string, unknown>>, sticky: Record<string, unknown> } }, executor?: { start(): Promise<void>, stop(): Promise<void>, execute(command: Record<string, unknown>): Promise<void> } | null, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Coordinator dependencies.
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, handleDriverPositionChanged(position: { id: string, index?: Record<string, unknown>, meta?: Record<string, unknown> }): Promise<void>, getCurrentPresentationState(): Record<string, unknown> | null }}
 */
export function createCoordinator(options) {
  const logger = options.logger ?? createNoopLogger();
  const executor = options.executor ?? null;
  let started = false;
  let obsStarted = false;
  let hubStarted = false;
  let executorStarted = false;
  let presentationSeq = 0;
  let currentPresentationState = null;
  const runtimeWindowBindings = {};

  function buildResolvedPresentationState(slideId, seq) {
    const bootstrapWindowBindings = options.getManagedBrowserBindings?.() ?? {};

    return buildPresentationState(slideId, options.config, seq, {
      windowBindings: {
        ...bootstrapWindowBindings,
        ...runtimeWindowBindings,
      },
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

  async function applyObsWindowBindings(presentationState) {
    if (typeof options.obs.applyInputSettings !== 'function' || options.config.presenter === null) {
      return;
    }

    for (const slot of presentationState.slots) {
      const binding = presentationState.windowBindings?.[slot.source];

      if (binding === undefined) {
        continue;
      }

      const managedBinding = { ...binding };
      if (managedBinding.pid === undefined && isBrowserSource(options.config, slot.source)) {
        const chromePid = options.getManagedBrowserPid?.();
        if (typeof chromePid === 'number') {
          managedBinding.pid = chromePid;
        }
      }

      await options.obs.applyInputSettings(slot.source, buildMacWindowCaptureSettings(managedBinding));
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
      await applyObsWindowBindings(presentationState);
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

    if (currentPresentationState !== null) {
      try {
        await applyObsWindowBindings(currentPresentationState);
      } catch (error) {
        logger.error('OBS input binding update failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function logSnapshot(message) {
    logger.info(message, options.hub.getSnapshot());
  }

  options.hub.on('driverPositionChanged', handleDriverPositionChanged);
  options.hub.on('driverRegistered', () => logSnapshot('Driver client registered'));
  options.hub.on('observerRegistered', () => logSnapshot('Observer client registered'));
  options.hub.on('observerWindowBindings', handleObserverWindowBindings);
  options.hub.on('clientDisconnected', () => logSnapshot('Client disconnected'));

  return {
    async start() {
      if (started) {
        return;
      }

      logger.info('Starting coordinator', { driver: options.config.driver.type });

      try {
        await options.obs.connect();
        obsStarted = true;

        if (executor !== null) {
          await executor.start();
          executorStarted = true;
        }

        await options.hub.start();
        hubStarted = true;

        started = true;
        logger.info('Coordinator started', { driver: options.config.driver.type });
      } catch (error) {
        if (hubStarted) {
          await options.hub.stop().catch(() => {});
          hubStarted = false;
        }

        if (executorStarted) {
          await executor?.stop().catch(() => {});
          executorStarted = false;
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
    },

    getCurrentPresentationState() {
      return currentPresentationState;
    },

    getRuntimeWindowBindings() {
      return { ...runtimeWindowBindings };
    },

    handleDriverPositionChanged,
  };
}
