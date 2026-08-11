import os from 'node:os';
import path from 'node:path';

import { createPresenterSession } from './presenter/session.js';
import { reduceStreamHealth } from './presenter/reduceStreamHealth.js';
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
// Buffer added to the configured transition duration when waiting for the OBS
// slide animation to finish before re-arming the freeze frame.
const TRANSITION_END_BUFFER_MS = 300;
const DRIVER_SETTLE_TIMEOUT_MS = 2000;
const DRIVER_COMMAND_POSITION_TIMEOUT_MS = 1500;
const PRESENTER_FOLLOW_TICK_MS = 250;
const PRESENTER_STATUS_POLL_MS = 5000;

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

function resolvePresenterStepMs(stt) {
  if (Number.isFinite(stt?.stepMs) && stt.stepMs > 0) {
    return Math.round(stt.stepMs);
  }

  const stream = stt?.streamSettings ?? stt?.stream ?? null;

  if (stream !== null && typeof stream === 'object') {
    if (Number.isFinite(stream.stepMs) && stream.stepMs > 0) {
      return Math.round(stream.stepMs);
    }

    if (Number.isFinite(stream.chunkMs) && stream.chunkMs > 0) {
      const overlapMs = Number.isFinite(stream.overlapMs) ? stream.overlapMs : 0;
      const stepMs = stream.chunkMs - overlapMs;

      if (stepMs > 0) {
        return Math.round(stepMs);
      }
    }
  }

  return Number.isFinite(stt?.chunkSeconds) && stt.chunkSeconds > 0
    ? Math.round(stt.chunkSeconds * 1000)
    : 0;
}

// The predictor needs enough lookahead to bridge the gap between transcript
// updates (which arrive every `stepMs`). Returning `stepMs` directly left the
// teleprompter lagging live speech; `max(stepMs * 3, 3000)` gives follow mode a
// long enough cap to project smoothly between updates.
function resolvePresenterPredictionLeadMs(stt) {
  const stepMs = resolvePresenterStepMs(stt);

  if (stepMs <= 0) {
    return 0;
  }

  return Math.max(stepMs * 3, 3000);
}

/**
 * Create the coordinator orchestration layer.
 *
 * The coordinator resolves slide config into typed browser commands and
 * dispatches them through an injected executor. It does not own browser logic
 * directly; the executor seam keeps slide-event orchestration decoupled from the
 * Deckhand browser session runtime.
 *
 * @param {{ config: { driver: { type: string }, obs: { url: string, password: string, transitions: null | { forward: string | null, backward: string | null, freezeScene: string, freezeImage: string, freezeImagePath: string | null, durationMs: number, settleMs: number, navigationWaitMs: number, windowSettleMs: number, freezeDimPercent: number } }, layouts: Record<string, unknown>, slides: Record<string, { layoutId: string, commands: Array<{ type: string, source: string, tab?: string, url?: string, [key: string]: unknown }> }> }, obs: { connect(): Promise<unknown>, disconnect(): Promise<unknown>, setScene(sceneName: string): Promise<unknown>, isConnected?(): boolean, applyInputSettings?(inputName: string, inputSettings: Record<string, unknown>): Promise<void>, getCurrentTransitionName?(): Promise<string>, captureProgramScreenshot?(filePath: string): Promise<void>, switchProgramScene?(sceneName: string, options?: { waitForEvent?: boolean, timeoutMs?: number }): Promise<void>, waitForSceneTransitionEnd?(options?: { timeoutMs?: number }): Promise<void>, setCurrentTransition?(name: string, durationMs?: number): Promise<void>, ensureFreezeAssets?(options: { sceneName: string, inputName: string, imagePath: string, dimPercent?: number }): Promise<void> }, hub: { on(eventName: string, handler: (payload: unknown) => Promise<void> | void): void, start(): Promise<unknown>, stop(): Promise<unknown>, sendCommand(target: { role?: 'driver' }, command: Record<string, unknown>): Promise<unknown>, publishSticky(channel: string, payload: Record<string, unknown>): Promise<unknown>, getSnapshot(): { activeDriver: Record<string, unknown> | null, observers: Array<Record<string, unknown>>, sticky: Record<string, unknown> } }, executor?: { start(): Promise<void>, stop(): Promise<void>, execute(command: Record<string, unknown>): Promise<void> } | null, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Coordinator dependencies.
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
  const presenterSession = options.config.presenter === null
    ? null
    : createPresenterSession({
        followEnabledByDefault: options.config.presenter.teleprompter.followEnabledByDefault,
        predictionLeadMs: resolvePresenterPredictionLeadMs(options.config.presenter.stt),
        tracking: options.config.presenter.teleprompter.tracking,
      });
  let previousSlideIndex = null;
  let freezeArmed = false;
  let nextFreezeFramePathIndex = 0;
  let slideOperation = Promise.resolve();
  let pendingFrozenDriverCommand = null;
  let restoreStudioModeOnStop = false;
  let originalStudioModeEnabled = false;
  let defaultTransitionName = FREEZE_CUT_TRANSITION;
  const runtimeWindowBindings = {};
  // The last window-capture settings actually pushed to OBS, per source, so an
  // unchanged binding between slides does not trigger a macOS capture
  // re-acquisition that would delay the resized frame.
  const lastAppliedObsBindings = new Map();
  // Seq-keyed deferreds awaiting the presenter's `windowSettled` ack, so a slide
  // change reveals only after the physical windows have actually moved/resized
  // instead of after a guessed fixed delay.
  const windowSettleWaiters = new Map();
  const driverSettleWaiters = new Map();
  const completedDriverSettleEvents = new Set();
  const pendingDriverPositions = new Map();
  let presenterFollowTimer = null;
  let presenterStatusTimer = null;
  let presenterPreview = null;
  let previousStreamStatus = null;

  function buildResolvedPresentationState(slideId, seq) {
    const bootstrapWindowBindings = options.getManagedWindowBindings?.() ?? {};

    return buildPresentationState(slideId, options.config, seq, {
      windowBindings: {
        ...bootstrapWindowBindings,
        ...runtimeWindowBindings,
      },
    });
  }

  function enqueueSlideOperation(work) {
    const run = slideOperation.then(work, work);
    slideOperation = run.catch(() => {});
    return run;
  }

  function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    return { promise, resolve, reject };
  }

  function preparePresentationState(slideId) {
    presentationSeq += 1;
    const state = buildResolvedPresentationState(slideId, presentationSeq);
    currentPresentationState = state;
    return state;
  }

  async function publishPresenterState(nowMs = Date.now()) {
    if (presenterSession === null) {
      return null;
    }

    presenterSession.tick(nowMs);
    const presenterState = presenterSession.getState();
    await options.hub.publishSticky('presenterState', presenterState);
    return presenterState;
  }

  function createProgramPreviewSnapshot() {
    if (presenterPreview === null) {
      return null;
    }

    return {
      body: presenterPreview.body,
      etag: `"presenter-preview-${presenterPreview.revision}"`,
      lastModified: new Date(presenterPreview.capturedAtMs).toUTCString(),
    };
  }

  async function refreshProgramPreview(nowMs = Date.now()) {
    if (presenterSession === null || typeof options.obs.getProgramScreenshotBuffer !== 'function') {
      return;
    }

    try {
      const body = await options.obs.getProgramScreenshotBuffer();
      const revision = (presenterPreview?.revision ?? 0) + 1;
      presenterPreview = { body, revision, capturedAtMs: nowMs };
      presenterSession.updateObsPreview({
        available: true,
        revision,
        capturedAtMs: nowMs,
        stale: false,
      }, nowMs);
    } catch (error) {
      presenterSession.updateObsPreview({
        available: false,
        capturedAtMs: nowMs,
        stale: true,
      }, nowMs);
      logger.warn('Failed to refresh presenter program preview', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function refreshStreamHealth(nowMs = Date.now()) {
    if (presenterSession === null || typeof options.obs.getStreamStatus !== 'function') {
      return;
    }

    try {
      const status = await options.obs.getStreamStatus();
      const stream = reduceStreamHealth(status, {
        previousStatus: previousStreamStatus,
        previousSummary: presenterSession.getState().stream,
        nowMs,
      });
      previousStreamStatus = status;
      presenterSession.updateStream(stream, nowMs);
    } catch (error) {
      logger.warn('Failed to refresh presenter stream health', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function pollPresenterStatus(nowMs = Date.now()) {
    if (presenterSession === null) {
      return null;
    }

    await Promise.all([
      refreshProgramPreview(nowMs),
      refreshStreamHealth(nowMs),
      presenterSession.tick(nowMs),
    ]);

    return publishPresenterState(nowMs);
  }

  async function maybePublishPresenterTick(nowMs = Date.now()) {
    if (presenterSession === null) {
      return null;
    }

    if (!presenterSession.tick(nowMs)) {
      return presenterSession.getState();
    }

    const presenterState = presenterSession.getState();
    await options.hub.publishSticky('presenterState', presenterState);
    return presenterState;
  }

  async function syncPresenterStateFromPresentation(presentationState, nowMs = Date.now()) {
    if (presenterSession === null) {
      return null;
    }

    presenterSession.applyPresentationState(presentationState, nowMs);
    await options.hub.publishSticky('presenterState', presenterSession.getState());
    return presenterSession.getState();
  }

  async function publishPresentationState(slideId) {
    const state = preparePresentationState(slideId);
    await options.hub.publishSticky('presentationState', state);
    await syncPresenterStateFromPresentation(state, Date.now());
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

  async function handleDriverSlideManifest(payload) {
    if (presenterSession === null || !payload?.manifest) {
      return;
    }

    try {
      presenterSession.applySlideManifest(payload.manifest, Date.now());
      await options.hub.publishSticky('presenterState', presenterSession.getState());
      logger.info('Updated presenter state from driver slide manifest', {
        slideCount: payload.manifest.slides.length,
      });
    } catch (error) {
      logger.error('Failed to reduce driver slide manifest into presenter state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleObserverTranscript(payload) {
    if (presenterSession === null || payload?.transcript === undefined) {
      return;
    }

    presenterSession.applyTranscript(payload.transcript, Date.now());
    await options.hub.publishSticky('presenterState', presenterSession.getState());
  }

  async function processObserverPresenterCommand(payload) {
    if (presenterSession === null || payload?.command === undefined) {
      return;
    }

    const command = payload.command;

    if (command.op === 'focusTeleprompter' || command.op === 'reopenTeleprompter') {
      if (typeof options.focusPresenterTeleprompter !== 'function') {
        logger.warn('Presenter teleprompter focus requested but no browser-session hook is available', {
          op: command.op,
        });
        return;
      }

      try {
        await options.focusPresenterTeleprompter({ reopen: command.op === 'reopenTeleprompter' });
      } catch (error) {
        logger.error('Failed to focus or reopen tracked teleprompter window', {
          error: error instanceof Error ? error.message : String(error),
          op: command.op,
        });
      }
      return;
    }

    presenterSession.applyCommand(command, Date.now());
    await options.hub.publishSticky('presenterState', presenterSession.getState());
  }

  function handleObserverPresenterCommand(payload) {
    return enqueueSlideOperation(() => processObserverPresenterCommand(payload));
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

      const settings = buildMacWindowCaptureSettings(managedBinding);
      const settingsKey = JSON.stringify(settings);

      // Skip a re-bind whose settings are identical to what OBS already has.
      // macOS window_capture re-acquires its stream when SetInputSettings lands,
      // even when nothing changed; the re-acquisition delays the next resized
      // frame, which then surfaces on the reveal as a window visibly resizing
      // to fit. Only push settings when they actually differ.
      if (lastAppliedObsBindings.get(slot.source) === settingsKey) {
        continue;
      }

      await options.obs.applyInputSettings(deckhandInputName(slot.source), settings);
      lastAppliedObsBindings.set(slot.source, settingsKey);
    }
  }

  async function publishAndApplyBindings(presentationState, slideId) {
    try {
      await options.hub.publishSticky('presentationState', presentationState);
      await syncPresenterStateFromPresentation(presentationState, Date.now());
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

  async function showFreezeScene(transitions) {
    logger.info('Showing freeze scene before mutation', {
      freezeArmed,
      freezeScene: transitions.freezeScene,
    });

    if (!freezeArmed) {
      await armFreezeFrame(transitions);
    }

    await options.obs.setCurrentTransition(FREEZE_CUT_TRANSITION);
    await options.obs.switchProgramScene(transitions.freezeScene, { waitForEvent: true });
    await delay(transitions.settleMs);
    logger.info('Freeze scene is live', { freezeScene: transitions.freezeScene });
  }

  async function restoreAudienceScene(audienceScene) {
    const sceneName = deckhandSceneName(audienceScene);

    try {
      await options.obs.switchProgramScene(sceneName);
    } finally {
      try {
        await options.obs.setCurrentTransition(defaultTransitionName);
      } catch (restoreError) {
        logger.warn('Failed to restore OBS transition after driver-command recovery', {
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
          transitionName: defaultTransitionName,
        });
      }
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
   * @param {{ forward: string | null, backward: string | null, freezeScene: string, freezeImage: string, freezeImagePath: string | null, durationMs: number, settleMs: number, windowSettleMs: number, freezeDimPercent: number }} transitions Normalized transition config.
   * @param {{ audienceScene: string }} presentationState The resolved target state.
   * @param {'forward' | 'backward' | 'none'} direction Perceived slide direction.
   * @param {string} slideId The active slide id, for logging.
   * @param {() => Promise<void>} mutate The dirty work to hide behind the freeze.
   */
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
    if (typeof options.obs.waitForSourceScreenshotStable !== 'function') {
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
      await options.obs.waitForSourceScreenshotStable(sourceName, { differentFromData });
    }
  }

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
        await options.obs.setCurrentTransition(directionalTransition, transitions.durationMs ?? DEFAULT_TRANSITION_DURATION_MS);
      }

      const canUseStudioPreviewWarmup = typeof options.obs.getStudioModeEnabled === 'function'
        && typeof options.obs.setStudioModeEnabled === 'function'
        && typeof options.obs.setPreviewScene === 'function'
        && typeof options.obs.triggerStudioModeTransition === 'function';

      if (canUseStudioPreviewWarmup) {
        logger.info('Setting OBS preview scene for stabilized reveal', {
          slideId,
          targetScene,
        });
        await options.obs.setPreviewScene(targetScene);
        await waitForAudienceSourcesToStabilize(previousPresentationState, presentationState, slideConfig, baselineSourceData);
        await options.obs.triggerStudioModeTransition({ targetSceneName: targetScene });
      } else {
        await waitForAudienceSourcesToStabilize(previousPresentationState, presentationState, slideConfig, baselineSourceData);
        await options.obs.switchProgramScene(targetScene, { waitForEvent: true });
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

  async function processDriverPositionChanged(position) {
    const slideConfig = options.config.slides[position.id];

    if (slideConfig === undefined) {
      logger.warn('No slide actions configured for reported slide', { slideId: position.id });
      return;
    }

    const previousPresentationState = currentPresentationState;
    const presentationState = preparePresentationState(position.id);
    const currentIndex = extractSlideIndex(position);
    const direction = computeSlideDirection(previousSlideIndex, currentIndex);
    const driverEventId = Number.isInteger(position?.meta?.driverEventId) ? position.meta.driverEventId : null;
    const frozenDriverCommand = pendingFrozenDriverCommand;

    if (frozenDriverCommand !== null) {
      clearTimeout(frozenDriverCommand.restoreTimer);
      pendingFrozenDriverCommand = null;
    }

    logger.info('Processing driver position change', {
      direction,
      driverEventId,
      freezeAlreadyVisible: frozenDriverCommand !== null,
      layoutId: presentationState.layoutId,
      seq: presentationState.seq,
      slideId: position.id,
    });

    previousSlideIndex = currentIndex;

    const transitions = options.config.obs.transitions ?? null;

    if (transitions === null) {
      await publishAndApplyBindings(presentationState, position.id);
      await applyLegacyAudienceScene(presentationState, position.id);
      await dispatchBrowserCommands(slideConfig, position.id);
      return;
    }

    await runSlideTransition(transitions, presentationState, direction, position.id, slideConfig, async () => {
      // Register the settle waiter before publishing so a fast presenter ack
      // can never beat the listener.
      const windowSettled = expectWindowSettle(presentationState.seq, transitions.windowSettleMs);
      const driverSettled = expectDriverPositionSettle(driverEventId, DRIVER_SETTLE_TIMEOUT_MS);
      await publishAndApplyBindings(presentationState, position.id);
      // Every mutable surface must be truly settled before the reveal: driver
      // deck paint, presenter window geometry, and any browser commands.
      logger.info('Waiting for transition dependencies to settle', {
        driverEventId,
        seq: presentationState.seq,
        slideId: position.id,
      });
      await Promise.all([
        dispatchBrowserCommands(slideConfig, position.id),
        windowSettled,
        driverSettled,
      ]);
    }, {
      baselineSourceData: frozenDriverCommand?.baselineSourceData ?? null,
      freezeAlreadyVisible: frozenDriverCommand !== null,
      previousPresentationState,
    });
  }

  function handleDriverPositionChanged(position) {
    const eventId = Number.isInteger(position?.meta?.driverEventId) ? position.meta.driverEventId : null;

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return enqueueSlideOperation(() => processDriverPositionChanged(position));
    }

    logger.info('Staged driver position change awaiting settle ack', {
      driverEventId: eventId,
      slideId: position.id,
    });

    for (const [pendingEventId, pending] of pendingDriverPositions.entries()) {
      if (pendingEventId >= eventId) {
        continue;
      }

      clearTimeout(pending.timer);
      pending.resolve();
      pendingDriverPositions.delete(pendingEventId);
    }

    if (pendingFrozenDriverCommand !== null) {
      clearTimeout(pendingFrozenDriverCommand.restoreTimer);
      pendingFrozenDriverCommand.restoreTimer = null;
    }

    const deferred = createDeferred();
    const timer = setTimeout(() => {
      const pending = pendingDriverPositions.get(eventId);
      if (pending === undefined) {
        return;
      }

      pendingDriverPositions.delete(eventId);
      completedDriverSettleEvents.add(eventId);
      logger.warn('Timed out waiting for driver position-settle ack; processing latest staged driver position anyway', {
        driverEventId: eventId,
        slideId: position.id,
      });
      enqueueSlideOperation(() => processDriverPositionChanged(pending.position)).then(pending.resolve, pending.reject);
    }, DRIVER_SETTLE_TIMEOUT_MS);

    pendingDriverPositions.set(eventId, {
      position,
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer,
    });
    return deferred.promise;
  }

  async function processObserverDriverCommand(payload) {
    const command = payload?.command;

    if (command === undefined) {
      return;
    }

    if (pendingFrozenDriverCommand !== null) {
      logger.warn('Ignored overlapping observer driver command while a frozen transition is already in flight', {
        commandType: command.type,
      });
      return;
    }

    const transitions = options.config.obs.transitions ?? null;

    if (transitions === null || currentPresentationState === null) {
      await options.hub.sendCommand({ role: 'driver' }, command);
      return;
    }

    if (options.hub.getSnapshot().activeDriver === null) {
      logger.warn('No active driver connected for observer driver command', {
        commandType: command.type,
      });
      return;
    }

    const previousAudienceScene = currentPresentationState.audienceScene;
    let baselineSourceData = null;

    if (typeof options.obs.getSourceScreenshotData === 'function') {
      try {
        baselineSourceData = {};
        for (const slot of currentPresentationState.slots) {
          baselineSourceData[slot.source] = await options.obs.getSourceScreenshotData(deckhandInputName(slot.source));
        }
      } catch (error) {
        logger.warn('Failed to capture outgoing visible sources for OBS-difference gating', {
          error: error instanceof Error ? error.message : String(error),
          scene: previousAudienceScene,
        });
        baselineSourceData = null;
      }
    }

    try {
      logger.info('Freezing before forwarding observer driver command', {
        commandType: command.type,
        hasBaselineSourceData: baselineSourceData !== null,
        previousAudienceScene,
      });
      await showFreezeScene(transitions);
    } catch (error) {
      logger.error('Failed to pre-freeze before forwarding driver command', {
        commandType: command.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const token = {};
    const restoreTimer = setTimeout(() => {
      if (pendingFrozenDriverCommand?.token !== token) {
        return;
      }

      pendingFrozenDriverCommand = null;
      logger.warn('Timed out waiting for driver position change after command; restoring previous audience scene', {
        commandType: command.type,
      });
      restoreAudienceScene(previousAudienceScene).catch((restoreError) => {
        logger.error('Failed to restore audience scene after driver-command timeout', {
          commandType: command.type,
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        });
      });
    }, DRIVER_COMMAND_POSITION_TIMEOUT_MS);

    pendingFrozenDriverCommand = {
      baselineSourceData,
      previousAudienceScene,
      restoreTimer,
      token,
    };

    try {
      const delivered = await options.hub.sendCommand({ role: 'driver' }, command);
      logger.info('Forwarded observer driver command to driver', {
        commandType: command.type,
        deliveredCount: delivered.length,
      });

      if (delivered.length === 0) {
        clearTimeout(restoreTimer);
        pendingFrozenDriverCommand = null;
        await restoreAudienceScene(previousAudienceScene);
      }
    } catch (error) {
      clearTimeout(restoreTimer);
      pendingFrozenDriverCommand = null;
      await restoreAudienceScene(previousAudienceScene).catch(() => {});
      logger.error('Failed to forward observer driver command', {
        commandType: command.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleObserverDriverCommand(payload) {
    return enqueueSlideOperation(() => processObserverDriverCommand(payload));
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
    const basePath = transitions.freezeImagePath ?? path.join(os.tmpdir(), DEFAULT_FREEZE_FILENAME);
    const parsed = path.parse(basePath);
    const extension = parsed.ext === '' ? '.png' : parsed.ext;
    return path.join(parsed.dir, `${parsed.name}-${nextFreezeFramePathIndex}${extension}`);
  }

  /**
   * Register a deferred that resolves when the presenter acks that it has
   * applied the window geometry for `seq` (the `windowSettled` hub message), or
   * after `timeoutMs` as a safety fallback. Resolves immediately when no
   * presenter is configured, since there are no physical windows to settle.
   *
   * The waiter is registered before the matching presentation state is
   * published, so a fast ack can never arrive before the listener exists.
   */
  function expectWindowSettle(seq, timeoutMs) {
    if (options.config.presenter === null) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const previous = windowSettleWaiters.get(seq);

      if (previous !== undefined) {
        clearTimeout(previous.timer);
        previous.resolve();
      }

      const timer = setTimeout(() => {
        windowSettleWaiters.delete(seq);
        logger.warn('Timed out waiting for presenter window-settle ack', { seq });
        resolve();
      }, timeoutMs);

      windowSettleWaiters.set(seq, {
        resolve: () => {
          clearTimeout(timer);
          windowSettleWaiters.delete(seq);
          resolve();
        },
        timer,
      });
    });
  }

  function handleObserverWindowSettled(payload) {
    const seq = payload?.seq;

    if (typeof seq !== 'number') {
      return;
    }

    logger.info('Received presenter window-settle ack', { seq });
    windowSettleWaiters.get(seq)?.resolve();
  }

  function expectDriverPositionSettle(eventId, timeoutMs) {
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return Promise.resolve();
    }

    if (completedDriverSettleEvents.has(eventId)) {
      completedDriverSettleEvents.delete(eventId);
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const previous = driverSettleWaiters.get(eventId);

      if (previous !== undefined) {
        clearTimeout(previous.timer);
        previous.resolve();
      }

      const timer = setTimeout(() => {
        driverSettleWaiters.delete(eventId);
        logger.warn('Timed out waiting for driver position-settle ack', { eventId });
        resolve();
      }, timeoutMs);

      driverSettleWaiters.set(eventId, {
        resolve: () => {
          clearTimeout(timer);
          driverSettleWaiters.delete(eventId);
          resolve();
        },
        timer,
      });
    });
  }

  function handleDriverPositionSettled(payload) {
    const eventId = payload?.eventId;

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return;
    }

    logger.info('Received driver position-settle ack', { eventId });
    const waiter = driverSettleWaiters.get(eventId);
    if (waiter !== undefined) {
      waiter.resolve();
      return;
    }

    const pending = pendingDriverPositions.get(eventId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pendingDriverPositions.delete(eventId);
      completedDriverSettleEvents.add(eventId);
      enqueueSlideOperation(() => processDriverPositionChanged(pending.position)).then(pending.resolve, pending.reject);
      return;
    }

    completedDriverSettleEvents.add(eventId);
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

    if (typeof options.obs.waitForSceneTransitionEnd !== 'function') {
      await delay(timeoutMs);
      return;
    }

    await options.obs.waitForSceneTransitionEnd({ timeoutMs });
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
      nextFreezeFramePathIndex = nextFreezeFramePathIndex === 0 ? 1 : 0;
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
    const transitions = options.config.obs.transitions ?? null;

    if (transitions === null
      || typeof options.obs.getStudioModeEnabled !== 'function'
      || typeof options.obs.setStudioModeEnabled !== 'function'
      || typeof options.obs.setPreviewScene !== 'function'
      || typeof options.obs.triggerStudioModeTransition !== 'function') {
      return;
    }

    try {
      originalStudioModeEnabled = await options.obs.getStudioModeEnabled();

      if (!originalStudioModeEnabled) {
        await options.obs.setStudioModeEnabled(true);
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
    if (!restoreStudioModeOnStop || typeof options.obs.setStudioModeEnabled !== 'function') {
      return;
    }

    restoreStudioModeOnStop = false;

    try {
      await options.obs.setStudioModeEnabled(originalStudioModeEnabled);
      logger.info('Restored OBS Studio Mode after Deckhand session', {
        studioModeEnabled: originalStudioModeEnabled,
      });
    } catch (error) {
      logger.warn('Failed to restore OBS Studio Mode after Deckhand session', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  options.hub.on('driverPositionChanged', handleDriverPositionChanged);
  options.hub.on('driverPositionSettled', handleDriverPositionSettled);
  options.hub.on('driverSlideManifest', handleDriverSlideManifest);
  options.hub.on('observerDriverCommand', handleObserverDriverCommand);
  options.hub.on('observerPresenterCommand', handleObserverPresenterCommand);
  options.hub.on('observerTranscript', handleObserverTranscript);
  options.hub.on('driverRegistered', () => logSnapshot('Driver client registered'));
  options.hub.on('observerRegistered', () => logSnapshot('Observer client registered'));
  options.hub.on('observerWindowBindings', handleObserverWindowBindings);
  options.hub.on('observerWindowSettled', handleObserverWindowSettled);
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
        await ensureStudioModeForSessionIfSupported();

        if (executor !== null) {
          await executor.start();
          executorStarted = true;
        }

        await options.hub.start();
        hubStarted = true;

        if (presenterSession !== null) {
          await pollPresenterStatus().catch((error) => {
            logger.warn('Initial presenter status poll failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
          presenterFollowTimer = setInterval(() => {
            if (!started) {
              return;
            }

            void (async () => {
              try {
                await maybePublishPresenterTick(Date.now());
              } catch (error) {
                logger.warn('Presenter follow publish failed', {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            })();
          }, PRESENTER_FOLLOW_TICK_MS);
          presenterFollowTimer.unref?.();
          presenterStatusTimer = setInterval(() => {
            pollPresenterStatus().catch((error) => {
              logger.warn('Presenter status poll failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }, PRESENTER_STATUS_POLL_MS);
          presenterStatusTimer.unref?.();
        }

        started = true;
        logger.info('Coordinator started', { driver: options.config.driver.type });
      } catch (error) {
        if (hubStarted) {
          await options.hub.stop().catch(() => {});
          hubStarted = false;
        }

        await restoreStudioModeIfManaged();

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
          if (presenterFollowTimer !== null) {
            clearInterval(presenterFollowTimer);
            presenterFollowTimer = null;
          }

          if (presenterStatusTimer !== null) {
            clearInterval(presenterStatusTimer);
            presenterStatusTimer = null;
          }

          await restoreStudioModeIfManaged();

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

    getCurrentPresenterState() {
      return presenterSession === null ? null : presenterSession.getState();
    },

    getRuntimeWindowBindings() {
      return { ...runtimeWindowBindings };
    },

    async refreshCurrentPresentationState(reason = 'refresh') {
      await republishCurrentPresentationState(reason);
    },

    async tickPresenterState(nowMs = Date.now()) {
      return maybePublishPresenterTick(nowMs);
    },

    getProgramPreviewSnapshot() {
      return createProgramPreviewSnapshot();
    },

    handleDriverPositionChanged,
  };
}
