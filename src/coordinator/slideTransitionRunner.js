import os from 'node:os';
import path from 'node:path';

import { delay } from '../lifecycle/time.js';
import { deckhandInputName, deckhandSceneName } from '../obsNames.js';

const DEFAULT_FREEZE_FILENAME = 'deckhand-freeze-frame.png';
const DEFAULT_TRANSITION_DURATION_MS = 300;
const FREEZE_CUT_TRANSITION = 'Cut';
// Buffer added to the configured transition duration when waiting for the OBS
// slide animation to finish before re-arming the freeze frame.
const TRANSITION_END_BUFFER_MS = 300;

/**
 * Strip a `data:image/...;base64,` prefix so callers can inspect the raw
 * payload. Mirrors the decoding regex in obsClient's `decodeImageDataUri` so
 * emptiness checks here agree with what the client would decode.
 *
 * @param {string} data Screenshot data, typically a data URI.
 * @returns {string} The base64 payload without the data-URI prefix.
 */
function appScreenshotPayload(data) {
  return data.replace(/^data:image\/\w+;base64,/, '');
}

/**
 * The slide transition runner surface used by `createCoordinator`.
 *
 * @typedef {object} SlideTransitionRunner
 * @property {(transitions: import('../contracts/coordinator.js').CoordinatorTransitions) => Promise<void>} showFreezeScene Arm the freeze frame if needed, then cut the program to the freeze scene.
 * @property {(audienceScene: string) => Promise<void>} restoreAudienceScene Cut back to an audience scene and restore the operator's default transition.
 * @property {(transitions: import('../contracts/coordinator.js').CoordinatorTransitions, presentationState: { audienceScene: string }, direction: 'forward' | 'backward' | 'none', slideId: string, slideConfig: { commands: Array<Record<string, unknown>> }, mutate: () => Promise<void>, extras?: { baselineSourceData?: Record<string, string> | null, freezeAlreadyVisible?: boolean, previousPresentationState?: Record<string, unknown> | null }) => Promise<void>} runSlideTransition Run the freeze -> mutate -> wait -> reveal sequence.
 * @property {(slideConfig: { commands: Array<Record<string, unknown>> }, slideId: string) => Promise<void>} dispatchBrowserCommands Execute a slide's typed commands through the injected executor.
 * @property {() => Promise<void>} ensureFreezeAssetsIfConfigured Create freeze assets and capture the operator's default transition at startup.
 * @property {() => Promise<void>} ensureStudioModeForSessionIfSupported Enable OBS Studio Mode for the session when the client supports it.
 * @property {() => Promise<void>} restoreStudioModeIfManaged Restore Studio Mode to its pre-session state on stop.
 */

/**
 * Create the slide transition runner: one owner for the freeze-frame
 * lifecycle, the freeze -> mutate -> reveal sequence, OBS transition
 * selection/completion waits, source screenshot stability waits, Studio Mode
 * session state, and browser command dispatch.
 *
 * @param {object} options Runner dependencies.
 * @param {import('../contracts/coordinator.js').CoordinatorConfig} options.config Normalized presentation config.
 * @param {import('../contracts/coordinator.js').CoordinatorObsClient} options.obs OBS client.
 * @param {import('../contracts/coordinator.js').CoordinatorExecutor | null} [options.executor] Browser command executor; dispatch is a no-op when null.
 * @param {import('../logger.js').Logger} options.logger Shared logger.
 * @param {() => Record<string, unknown> | null} options.getCurrentPresentationState Reader for the coordinator's current presentation state.
 * @returns {SlideTransitionRunner} The runner.
 */
export function createSlideTransitionRunner(options) {
  const {
    config,
    obs,
    executor = null,
    logger,
    getCurrentPresentationState,
  } = options;
  let freezeArmed = false;
  let nextFreezeFramePathIndex = 0;
  let defaultTransitionName = FREEZE_CUT_TRANSITION;
  let restoreStudioModeOnStop = false;
  let originalStudioModeEnabled = false;

  function resolveFreezeImagePath(transitions) {
    const basePath = transitions.freezeImagePath ?? path.join(os.tmpdir(), DEFAULT_FREEZE_FILENAME);
    const parsed = path.parse(basePath);
    const extension = parsed.ext === '' ? '.png' : parsed.ext;
    return path.join(parsed.dir, `${parsed.name}-${nextFreezeFramePathIndex}${extension}`);
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

  async function showFreezeScene(transitions) {
    logger.info('Showing freeze scene before mutation', {
      freezeArmed,
      freezeScene: transitions.freezeScene,
    });

    if (!freezeArmed) {
      await armFreezeFrame(transitions);
    }

    await obs.setCurrentTransition(FREEZE_CUT_TRANSITION);
    await obs.switchProgramScene(transitions.freezeScene, { waitForEvent: true });
    await delay(transitions.settleMs);
    logger.info('Freeze scene is live', { freezeScene: transitions.freezeScene });
  }

  async function restoreAudienceScene(audienceScene) {
    const sceneName = deckhandSceneName(audienceScene);

    try {
      await obs.switchProgramScene(sceneName);
    } finally {
      try {
        await obs.setCurrentTransition(defaultTransitionName);
      } catch (restoreError) {
        logger.warn('Failed to restore OBS transition after driver-command recovery', {
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
          transitionName: defaultTransitionName,
        });
      }
    }
  }

  function sourceRectSizeKey(state, sourceId) {
    const slot = state?.slots?.find((entry) => entry.source === sourceId) ?? null;
    return slot?.rect === undefined ? null : `${slot.rect.w}x${slot.rect.h}`;
  }

  function sourceNeedsDifferentFrame(previousState, nextState, slideConfig, sourceId) {
    if (previousState === null) {
      return false;
    }

    if (sourceId === 'Slide' && previousState.slideId !== nextState.slideId) {
      return true;
    }

    if (slideConfig.commands.some((command) => command.source === sourceId)) {
      return true;
    }

    return sourceRectSizeKey(previousState, sourceId) !== sourceRectSizeKey(nextState, sourceId);
  }

  async function waitForAudienceSourcesToStabilize(previousState, nextState, slideConfig, baselineSourceData) {
    if (typeof obs.waitForSourceScreenshotStable !== 'function') {
      return;
    }

    for (const slot of nextState.slots) {
      const sourceName = deckhandInputName(slot.source);
      const differentFromData = sourceNeedsDifferentFrame(previousState, nextState, slideConfig, slot.source)
        ? (baselineSourceData?.[slot.source] ?? null)
        : null;

      logger.info('Waiting for OBS visible source screenshot to stabilize', {
        differentFromData: differentFromData !== null,
        slideId: nextState.slideId,
        source: slot.source,
        sourceName,
      });
      await obs.waitForSourceScreenshotStable(sourceName, { differentFromData });
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
   * @param {import('../contracts/coordinator.js').CoordinatorTransitions} transitions Normalized transition config.
   * @param {{ audienceScene: string }} presentationState The resolved target state.
   * @param {'forward' | 'backward' | 'none'} direction Perceived slide direction.
   * @param {string} slideId The active slide id, for logging.
   * @param {() => Promise<void>} mutate The dirty work to hide behind the freeze.
   */
  async function runSlideTransition(transitions, presentationState, direction, slideId, slideConfig, mutate, {
    baselineSourceData = null,
    freezeAlreadyVisible = false,
    previousPresentationState = null,
  } = {}) {
    const targetScene = deckhandSceneName(presentationState.audienceScene);

    try {
      // The freeze frame is pre-armed from the last fully settled reveal (or at
      // startup), so it still shows the outgoing audience frame even though the
      // reveal.js driver deck may already have advanced locally by the time the
      // coordinator hears about the slide change.
      if (!freezeAlreadyVisible) {
        await showFreezeScene(transitions);
      }

      await mutate();

      const directionalTransition = direction === 'forward'
        ? transitions.forward
        : direction === 'backward'
          ? transitions.backward
          : null;

      if (directionalTransition !== null) {
        await obs.setCurrentTransition(directionalTransition, transitions.durationMs ?? DEFAULT_TRANSITION_DURATION_MS);
      }

      const canUseStudioPreviewWarmup = typeof obs.getStudioModeEnabled === 'function'
        && typeof obs.setStudioModeEnabled === 'function'
        && typeof obs.setPreviewScene === 'function'
        && typeof obs.triggerStudioModeTransition === 'function';

      if (canUseStudioPreviewWarmup) {
        logger.info('Setting OBS preview scene for stabilized reveal', {
          slideId,
          targetScene,
        });
        await obs.setPreviewScene(targetScene);
        await waitForAudienceSourcesToStabilize(previousPresentationState, presentationState, slideConfig, baselineSourceData);
        await obs.triggerStudioModeTransition({ targetSceneName: targetScene });
      } else {
        await waitForAudienceSourcesToStabilize(previousPresentationState, presentationState, slideConfig, baselineSourceData);
        await obs.switchProgramScene(targetScene, { waitForEvent: true });
      }

      // Let the slide animation finish before re-arming the freeze and before
      // the `finally` restores the operator's default transition.
      await waitForSceneTransitionToSettle(transitions);

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
        await obs.switchProgramScene(targetScene);
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
        await obs.setCurrentTransition(defaultTransitionName);
      } catch (restoreError) {
        logger.warn('Failed to restore OBS transition', {
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
          transitionName: defaultTransitionName,
        });
      }
    }
  }

  /**
   * Wait for the OBS slide transition to finish. Prefers the
   * `CurrentSceneTransitionEnded` event (via the obs client); falls back to a
   * duration-based wait when the client cannot observe the event. This ensures
   * the freeze frame is re-captured from a fully settled frame rather than a
   * mid-transition composite.
   */
  async function waitForSceneTransitionToSettle(transitions) {
    const timeoutMs = (transitions.durationMs ?? DEFAULT_TRANSITION_DURATION_MS) + TRANSITION_END_BUFFER_MS;

    if (typeof obs.waitForSceneTransitionEnd !== 'function') {
      await delay(timeoutMs);
      return;
    }

    await obs.waitForSceneTransitionEnd({ timeoutMs });
  }

  /**
   * Probe the outgoing app-window slots directly before trusting a freshly
   * captured freeze frame. App-window captures can fail or render black in OBS
   * offscreen screenshot requests while the scene-level capture still reports
   * success, so the app slots are probed one by one; any probe failure means
   * the new capture is suspect.
   *
   * @returns {Promise<boolean>} True when the capture can be trusted (or cannot be probed).
   */
  async function appSlotCaptureIsReliable() {
    const currentPresentationState = getCurrentPresentationState();

    if (typeof obs.getSourceScreenshotData !== 'function' || currentPresentationState === null) {
      return true;
    }

    for (const slot of currentPresentationState.slots) {
      if (config.sources[slot.source]?.kind !== 'app') {
        continue;
      }

      let data = null;

      try {
        data = await obs.getSourceScreenshotData(deckhandInputName(slot.source));
      } catch (error) {
        logger.warn('Freeze frame may render black; keeping the last good freeze frame', {
          source: slot.source,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }

      if (typeof data !== 'string' || appScreenshotPayload(data).length === 0) {
        logger.warn('Freeze frame may render black; keeping the last good freeze frame', {
          source: slot.source,
          error: 'source screenshot returned no image data',
        });
        return false;
      }
    }

    return true;
  }

  async function armFreezeFrame(transitions) {
    if (typeof obs.captureProgramScreenshot !== 'function' || typeof obs.applyInputSettings !== 'function') {
      return;
    }

    const freezeImagePath = resolveFreezeImagePath(transitions);

    try {
      await obs.captureProgramScreenshot(freezeImagePath);

      // A capture that renders black must not replace the last good freeze
      // frame: skipping the settings apply (and the path rotation) keeps the
      // freeze input pointing at the prior still instead of a black screen.
      if (!await appSlotCaptureIsReliable()) {
        return;
      }

      await obs.applyInputSettings(transitions.freezeImage, { file: freezeImagePath });
      freezeArmed = true;
      nextFreezeFramePathIndex = nextFreezeFramePathIndex === 0 ? 1 : 0;
    } catch (error) {
      logger.warn('Failed to arm freeze frame', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function ensureFreezeAssetsIfConfigured() {
    const transitions = config.obs.transitions ?? null;

    if (transitions === null || typeof obs.ensureFreezeAssets !== 'function') {
      return;
    }

    try {
      // Capture the operator's true default transition before Deckhand touches
      // it, so each slide change restores to this (not a leftover from a prior
      // transition) and manual OBS use between changes is unaffected.
      if (typeof obs.getCurrentTransitionName === 'function') {
        defaultTransitionName = await obs.getCurrentTransitionName();
      }

      await obs.ensureFreezeAssets({
        sceneName: transitions.freezeScene,
        inputName: transitions.freezeImage,
        imagePath: resolveFreezeImagePath(transitions),
        dimPercent: transitions.freezeDimPercent,
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

  async function ensureStudioModeForSessionIfSupported() {
    const transitions = config.obs.transitions ?? null;

    if (transitions === null
      || typeof obs.getStudioModeEnabled !== 'function'
      || typeof obs.setStudioModeEnabled !== 'function'
      || typeof obs.setPreviewScene !== 'function'
      || typeof obs.triggerStudioModeTransition !== 'function') {
      return;
    }

    try {
      originalStudioModeEnabled = await obs.getStudioModeEnabled();

      if (!originalStudioModeEnabled) {
        await obs.setStudioModeEnabled(true);
        logger.info('Enabled OBS Studio Mode for Deckhand session');
      } else {
        logger.info('OBS Studio Mode already enabled before Deckhand session');
      }

      restoreStudioModeOnStop = true;
    } catch (error) {
      logger.warn('Failed to ensure OBS Studio Mode', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function restoreStudioModeIfManaged() {
    if (!restoreStudioModeOnStop || typeof obs.setStudioModeEnabled !== 'function') {
      return;
    }

    restoreStudioModeOnStop = false;

    try {
      await obs.setStudioModeEnabled(originalStudioModeEnabled);
      logger.info('Restored OBS Studio Mode after Deckhand session', {
        studioModeEnabled: originalStudioModeEnabled,
      });
    } catch (error) {
      logger.warn('Failed to restore OBS Studio Mode after Deckhand session', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    showFreezeScene,
    restoreAudienceScene,
    runSlideTransition,
    dispatchBrowserCommands,
    ensureFreezeAssetsIfConfigured,
    ensureStudioModeForSessionIfSupported,
    restoreStudioModeIfManaged,
  };
}
