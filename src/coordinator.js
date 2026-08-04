import os from 'node:os';
import path from 'node:path';

import { buildPresentationState } from './scenes.js';
import { buildMacWindowCaptureSettings } from './setupObs.js';
import { deckhandInputName, deckhandSceneName } from './obsNames.js';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

const DEFAULT_FREEZE_FILENAME = 'deckhand-freeze-frame.png';
const DEFAULT_TRANSITION_DURATION_MS = 300;
const FREEZE_CUT_TRANSITION = 'Cut';

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Extract a comparable `{ h, v }` index from a driver position payload.
 *
 * Returns `null` when no usable horizontal index is present (e.g. the first
 * reported position, or a payload that omits index data), which the direction
 * logic treats as "no previous frame to compare against".
 *
 * @param {{ index?: { h?: unknown, v?: unknown } } | null} position The driver position payload.
 * @returns {{ h: number, v: number } | null}
 */
export function extractSlideIndex(position) {
  const index = position?.index;

  if (index === null || typeof index !== 'object') {
    return null;
  }

  const h = Number.isInteger(index.h) ? index.h : null;

  if (h === null) {
    return null;
  }

  return { h, v: Number.isInteger(index.v) ? index.v : 0 };
}

/**
 * Compute the perceived slide direction from the previous vs. current index.
 *
 * `next` advances, `prev` retreats. Same-index jumps (or the first reported
 * position) yield `'none'`, which the reveal step treats as a neutral
 * transition. The comparison is horizontal-first, then vertical within the same
 * horizontal index, matching reveal.js deck ordering.
 *
 * @param {{ h: number, v: number } | null} previous The prior slide index.
 * @param {{ h: number, v: number } | null} current The new slide index.
 * @returns {'forward' | 'backward' | 'none'}
 */
export function computeSlideDirection(previous, current) {
  if (previous === null || current === null) {
    return 'none';
  }

  if (current.h > previous.h) {
    return 'forward';
  }

  if (current.h < previous.h) {
    return 'backward';
  }

  if (current.v > previous.v) {
    return 'forward';
  }

  if (current.v < previous.v) {
    return 'backward';
  }

  return 'none';
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
 * @param {{ config: { driver: { type: string }, obs: { url: string, password: string, transitions: null | { forward: string, backward: string, freezeScene: string, freezeImage: string, freezeImagePath: string | null, durationMs: number, settleMs: number, navigationWaitMs: number } }, layouts: Record<string, unknown>, slides: Record<string, { layoutId: string, commands: Array<{ type: string, source: string, tab?: string, url?: string, [key: string]: unknown }> }> }, obs: { connect(): Promise<unknown>, disconnect(): Promise<unknown>, setScene(sceneName: string): Promise<unknown>, isConnected?(): boolean, applyInputSettings?(inputName: string, inputSettings: Record<string, unknown>): Promise<void>, getCurrentTransitionName?(): Promise<string>, captureProgramScreenshot?(filePath: string): Promise<void>, switchProgramScene?(sceneName: string, options?: { waitForEvent?: boolean, timeoutMs?: number }): Promise<void>, setCurrentTransition?(name: string, durationMs?: number): Promise<void>, ensureFreezeAssets?(options: { sceneName: string, inputName: string, imagePath: string }): Promise<void> }, hub: { on(eventName: string, handler: (payload: unknown) => Promise<void> | void): void, start(): Promise<unknown>, stop(): Promise<unknown>, sendCommand(target: { role?: 'driver' }, command: Record<string, unknown>): Promise<unknown>, publishSticky(channel: string, payload: Record<string, unknown>): Promise<unknown>, getSnapshot(): { activeDriver: Record<string, unknown> | null, observers: Array<Record<string, unknown>>, sticky: Record<string, unknown> } }, executor?: { start(): Promise<void>, stop(): Promise<void>, execute(command: Record<string, unknown>): Promise<void> } | null, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Coordinator dependencies.
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
  let previousSlideIndex = null;
  let freezeArmed = false;
  let defaultTransitionName = FREEZE_CUT_TRANSITION;
  const runtimeWindowBindings = {};

  function buildResolvedPresentationState(slideId, seq) {
    const bootstrapWindowBindings = options.getManagedWindowBindings?.() ?? {};

    return buildPresentationState(slideId, options.config, seq, {
      windowBindings: {
        ...bootstrapWindowBindings,
        ...runtimeWindowBindings,
      },
    });
  }

  function preparePresentationState(slideId) {
    presentationSeq += 1;
    const state = buildResolvedPresentationState(slideId, presentationSeq);
    currentPresentationState = state;
    return state;
  }

  async function publishPresentationState(slideId) {
    const state = preparePresentationState(slideId);
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

  function observerCanResolveSource(source) {
    return options.config.sources[source]?.kind === 'browser';
  }

  function mergeRuntimeWindowBindings(payload) {
    let changed = false;

    for (const source of payload.cleared ?? []) {
      if (!observerCanResolveSource(source)) {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(runtimeWindowBindings, source)) {
        delete runtimeWindowBindings[source];
        changed = true;
      }
    }

    for (const [source, binding] of Object.entries(payload.bindings ?? {})) {
      if (!observerCanResolveSource(source)) {
        continue;
      }

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

      await options.obs.applyInputSettings(deckhandInputName(slot.source), buildMacWindowCaptureSettings(managedBinding));
    }
  }

  async function publishAndApplyBindings(presentationState, slideId) {
    try {
      await options.hub.publishSticky('presentationState', presentationState);
      logger.info('Published presentation state for slide', {
        layoutId: presentationState.layoutId,
        seq: presentationState.seq,
        slideId,
      });
    } catch (error) {
      logger.error('Observer state publish failed', {
        error: error instanceof Error ? error.message : String(error),
        slideId,
      });
    }

    try {
      await applyObsWindowBindings(presentationState);
    } catch (error) {
      logger.error('OBS window binding update failed', {
        error: error instanceof Error ? error.message : String(error),
        slideId,
      });
    }
  }

  async function applyLegacyAudienceScene(presentationState, slideId) {
    const sceneName = deckhandSceneName(presentationState.audienceScene);
    try {
      await options.obs.setScene(sceneName);
      logger.info('Applied OBS scene for slide', {
        scene: sceneName,
        slideId,
      });
    } catch (error) {
      logger.error('OBS scene switch failed', {
        error: error instanceof Error ? error.message : String(error),
        scene: sceneName,
        slideId,
      });
    }
  }

  /**
   * Run the freeze -> mutate -> wait -> reveal sequence that masks window
   * resize, content reflow, and browser navigation behind a still frame while
   * the whole audience frame slides directionally into place.
   *
   * Every OBS-touching step that can glitch (window capture rebind, page
   * navigation) happens inside `mutate`, which only runs once the Freeze scene
   * is confirmed on screen. The reveal direction comes from `direction`.
   *
   * @param {{ forward: string, backward: string, freezeScene: string, freezeImage: string, freezeImagePath: string | null, durationMs: number, settleMs: number, navigationWaitMs: number }} transitions Normalized transition config.
   * @param {{ audienceScene: string }} presentationState The resolved target state.
   * @param {'forward' | 'backward' | 'none'} direction Perceived slide direction.
   * @param {string} slideId The active slide id, for logging.
   * @param {() => Promise<void>} mutate The dirty work to hide behind the freeze.
   * @param {boolean} requiresNavigationWait Whether to wait the navigation cap.
   */
  async function runSlideTransition(transitions, presentationState, direction, slideId, mutate, requiresNavigationWait) {
    const targetScene = deckhandSceneName(presentationState.audienceScene);

    try {
      // The freeze frame is pre-armed with the *previous* frame (captured after
      // the last reveal, or at startup). Cutting to it is instant, so the
      // audience never sees the driver's slide content change or the window
      // resize: they see the frozen old frame until the reveal slides it away.
      if (!freezeArmed) {
        await armFreezeFrame(transitions);
      }

      await options.obs.setCurrentTransition(FREEZE_CUT_TRANSITION);
      await options.obs.switchProgramScene(transitions.freezeScene, { waitForEvent: true });
      await delay(transitions.settleMs);

      await mutate();

      await delay(requiresNavigationWait ? transitions.navigationWaitMs : transitions.settleMs);

      const directionalTransition = direction === 'forward'
        ? transitions.forward
        : direction === 'backward'
          ? transitions.backward
          : null;

      if (directionalTransition !== null) {
        await options.obs.setCurrentTransition(directionalTransition, transitions.durationMs ?? DEFAULT_TRANSITION_DURATION_MS);
      }

      await options.obs.switchProgramScene(targetScene, { waitForEvent: true });

      // Re-arm the freeze with the now-current frame so the *next* change
      // hides behind this one. Best-effort: a failure here only leaves a stale
      // freeze, it does not break this transition.
      await armFreezeFrame(transitions);

      logger.info('Revealed audience scene with directional transition', {
        scene: targetScene,
        direction,
        slideId,
      });
    } catch (error) {
      logger.error('Slide transition failed; falling back to direct scene switch', {
        error: error instanceof Error ? error.message : String(error),
        scene: targetScene,
        slideId,
      });

      try {
        await options.obs.switchProgramScene(targetScene);
      } catch (fallbackError) {
        logger.error('Fallback scene switch failed', {
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          scene: targetScene,
          slideId,
        });
      }
    } finally {
      // Always restore the operator's true default transition (captured at
      // startup), not whatever the previous transition left active, so manual
      // OBS use between Deckhand slide changes is unaffected.
      try {
        await options.obs.setCurrentTransition(defaultTransitionName);
      } catch (restoreError) {
        logger.warn('Failed to restore OBS transition', {
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
          transitionName: defaultTransitionName,
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

    const presentationState = preparePresentationState(position.id);
    const currentIndex = extractSlideIndex(position);
    const direction = computeSlideDirection(previousSlideIndex, currentIndex);
    previousSlideIndex = currentIndex;

    const transitions = options.config.obs.transitions ?? null;

    if (transitions === null) {
      await publishAndApplyBindings(presentationState, position.id);
      await applyLegacyAudienceScene(presentationState, position.id);
      await dispatchBrowserCommands(slideConfig, position.id);
      return;
    }

    const requiresNavigationWait = slideConfig.commands.some((command) => command.type === 'navigate');

    await runSlideTransition(transitions, presentationState, direction, position.id, async () => {
      await publishAndApplyBindings(presentationState, position.id);
      await dispatchBrowserCommands(slideConfig, position.id);
    }, requiresNavigationWait);
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

  function resolveFreezeImagePath(transitions) {
    return transitions.freezeImagePath ?? path.join(os.tmpdir(), DEFAULT_FREEZE_FILENAME);
  }

  async function armFreezeFrame(transitions) {
    if (typeof options.obs.captureProgramScreenshot !== 'function' || typeof options.obs.applyInputSettings !== 'function') {
      return;
    }

    const freezeImagePath = resolveFreezeImagePath(transitions);

    try {
      await options.obs.captureProgramScreenshot(freezeImagePath);
      await options.obs.applyInputSettings(transitions.freezeImage, { file: freezeImagePath });
      freezeArmed = true;
    } catch (error) {
      logger.warn('Failed to arm freeze frame', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function ensureFreezeAssetsIfConfigured() {
    const transitions = options.config.obs.transitions ?? null;

    if (transitions === null || typeof options.obs.ensureFreezeAssets !== 'function') {
      return;
    }

    try {
      // Capture the operator's true default transition before Deckhand touches
      // it, so each slide change restores to this (not a leftover from a prior
      // transition) and manual OBS use between changes is unaffected.
      if (typeof options.obs.getCurrentTransitionName === 'function') {
        defaultTransitionName = await options.obs.getCurrentTransitionName();
      }

      await options.obs.ensureFreezeAssets({
        sceneName: transitions.freezeScene,
        inputName: transitions.freezeImage,
        imagePath: resolveFreezeImagePath(transitions),
      });
      logger.info('Ensured OBS freeze assets', {
        scene: transitions.freezeScene,
        input: transitions.freezeImage,
        defaultTransition: defaultTransitionName,
      });
      await armFreezeFrame(transitions);
    } catch (error) {
      logger.error('Failed to ensure OBS freeze assets', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

        await ensureFreezeAssetsIfConfigured();

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
          if (executor !== null && typeof executor.stop === 'function') {
            try {
              await Promise.resolve(executor.stop());
            } catch {
              // best-effort cleanup
            }
          }
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
