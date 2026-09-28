import { createNoopLogger } from './logger.js';
import { buildPresentationState, shouldSkipAudienceTransition } from './scenes.js';
import { deckhandInputName, deckhandSceneName } from './obsNames.js';
import { buildMacWindowCaptureSettings } from './setupObs.js';
import { createPresenterPublisher } from './coordinator/presenterPublisher.js';
import { createSettleTracker, DRIVER_SETTLE_TIMEOUT_MS } from './coordinator/settleTracker.js';
import { createSlideTransitionRunner } from './coordinator/slideTransitionRunner.js';
import { createWindowBindingRegistry } from './coordinator/windowBindingRegistry.js';
import { computeSlideDirection, extractSlideIndex } from './coordinator/slideMath.js';

// Public slide math lives in ./coordinator/slideMath.js; re-exported so the
// facade's public imports stay stable.
export { computeSlideDirection, extractSlideIndex };

const DRIVER_COMMAND_POSITION_TIMEOUT_MS = 1500;

function isBrowserSource(config, sourceId) {
  return config.sources[sourceId]?.kind === 'browser';
}

/**
 * Create the coordinator orchestration layer.
 *
 * The coordinator resolves slide config into typed browser commands and
 * dispatches them through an injected executor. It does not own browser logic
 * directly; the executor seam keeps slide-event orchestration decoupled from the
 * Deckhand browser session runtime. Mutable state clusters live behind named
 * owners: `slideTransitionRunner` (freeze -> mutate -> reveal), `settleTracker`
 * (window/driver settle waiters and staged positions), `presenterPublisher`
 * (presenter session publishes, preview, and status timers), and
 * `windowBindings` (runtime window bindings and the applied-OBS-settings cache).
 *
 * @param {import('./contracts/coordinator.js').CoordinatorOptions} options Coordinator dependencies.
 * @returns {import('./contracts/coordinator.js').Coordinator}
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
  const presenterPublisher = options.config.presenter === null
    ? null
    : createPresenterPublisher({
        presenterConfig: options.config.presenter,
        hub: options.hub,
        obs: options.obs,
        logger,
      });
  let pendingFrozenDriverCommand = null;
  let previousSlideIndex = null;
  let slideOperation = Promise.resolve();
  const windowBindings = createWindowBindingRegistry({ config: options.config });
  const settleTracker = createSettleTracker({
    logger,
    presenterEnabled: options.config.presenter !== null,
    processPosition: (position) => enqueueSlideOperation(() => processDriverPositionChanged(position)),
  });
  const transitionRunner = createSlideTransitionRunner({
    config: options.config,
    obs: options.obs,
    executor,
    logger,
    getCurrentPresentationState: () => currentPresentationState,
  });

  function buildResolvedPresentationState(slideId, seq) {
    const bootstrapWindowBindings = options.getManagedWindowBindings?.() ?? {};

    return buildPresentationState(slideId, options.config, seq, {
      windowBindings: {
        ...bootstrapWindowBindings,
        ...windowBindings.snapshot(),
      },
    });
  }

  function enqueueSlideOperation(work) {
    const run = slideOperation.then(work, work);
    slideOperation = run.catch(() => {});
    return run;
  }

  function preparePresentationState(slideId) {
    presentationSeq += 1;
    const state = buildResolvedPresentationState(slideId, presentationSeq);
    currentPresentationState = state;
    return state;
  }

  async function syncPresenterStateFromPresentation(presentationState, nowMs = Date.now()) {
    if (presenterPublisher === null) {
      return null;
    }

    return presenterPublisher.syncFromPresentation(presentationState, nowMs);
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

  /**
   * Re-apply the current slide to every downstream surface after a transport
   * recovery. Used by the OBS `reconnected` and browser `recovered` hooks so a
   * mid-session bounce does not leave OBS pointing at a stale macWindowId or
   * tabs on the wrong URL. Idempotent: it invalidates the per-source OBS binding
   * cache so the next apply actually pushes, then re-runs the publish/bind/
   * dispatch pipeline. `rearmFreeze` additionally re-ensures the freeze assets
   * (OBS-reconnect only, since OBS may have dropped transient input state).
   *
   * @param {string} reason Why the reapply is running.
   * @param {{ rearmFreeze?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async function runReapplyCurrentSlide(reason, { rearmFreeze = false } = {}) {
    if (currentPresentationState === null) {
      return;
    }

    const slideId = currentPresentationState.slideId;
    const slideConfig = options.config.slides[slideId] ?? null;

    logger.info('Reapplying current slide after recovery', { reason, slideId });

    windowBindings.clearAppliedSettings();

    await republishCurrentPresentationState(reason);
    await applyObsWindowBindings(currentPresentationState);

    if (slideConfig !== null) {
      await transitionRunner.dispatchBrowserCommands(slideConfig, slideId);
    }

    if (rearmFreeze) {
      await transitionRunner.ensureFreezeAssetsIfConfigured();
    }
  }

  /**
   * Persist the active slide id so a mid-session restart can resume the deck
   * where the operator left off. Fire-and-log: a failed write must never break
   * a slide change. No-op when no `persistSlideId` callback was wired.
   *
   * @param {string} slideId The active slide id.
   * @param {unknown} index The extracted h/v index, for diagnostics.
   * @returns {Promise<void>}
   */
  async function recordResumePoint(slideId, index) {
    if (typeof options.persistSlideId !== 'function') {
      return;
    }

    try {
      await options.persistSlideId({ slideId, index });
    } catch (error) {
      logger.warn('Failed to persist resume slide id', {
        error: error instanceof Error ? error.message : String(error),
        slideId,
      });
    }
  }

  let recoveryWired = false;

  function wireRecoveryEvents() {
    if (recoveryWired) {
      return;
    }
    recoveryWired = true;

    if (options.obs && typeof options.obs.on === 'function') {
      options.obs.on('reconnected', () => {
        enqueueSlideOperation(() => runReapplyCurrentSlide('obsReconnected', { rearmFreeze: true }));
      });
    }

    if (options.browserSession && typeof options.browserSession.on === 'function') {
      options.browserSession.on('recovered', () => {
        enqueueSlideOperation(() => runReapplyCurrentSlide('browserRecovered'));
      });
    }
  }

  function handleDriverSlideManifest(payload) {
    if (presenterPublisher === null) {
      return Promise.resolve();
    }

    return presenterPublisher.applySlideManifest(payload);
  }

  function handleObserverTranscript(payload) {
    if (presenterPublisher === null) {
      return Promise.resolve();
    }

    return presenterPublisher.applyTranscript(payload);
  }

  async function processObserverPresenterCommand(payload) {
    if (presenterPublisher === null || payload?.command === undefined) {
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

    if (command.op === 'relaunchSource') {
      if (typeof options.relaunchSource !== 'function') {
        logger.warn('Source relaunch requested but no relaunch hook is available', {
          sourceId: command.sourceId,
        });
        return;
      }

      try {
        await options.relaunchSource({ sourceId: command.sourceId });
      } catch (error) {
        logger.error('Failed to relaunch source', {
          error: error instanceof Error ? error.message : String(error),
          sourceId: command.sourceId,
        });
      }
      return;
    }

    await presenterPublisher.applyCommand(command, Date.now());
  }

  function handleObserverPresenterCommand(payload) {
    return enqueueSlideOperation(() => processObserverPresenterCommand(payload));
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
      if (windowBindings.getAppliedSettingsKey(slot.source) === settingsKey) {
        continue;
      }

      await options.obs.applyInputSettings(deckhandInputName(slot.source), settings);
      windowBindings.setAppliedSettingsKey(slot.source, settingsKey);
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
      await transitionRunner.dispatchBrowserCommands(slideConfig, position.id);
      await recordResumePoint(position.id, currentIndex);
      return;
    }

    const skipAudienceTransition = shouldSkipAudienceTransition(previousPresentationState, presentationState, slideConfig);

    if (skipAudienceTransition && frozenDriverCommand === null) {
      logger.info('Same audience scene; updating presenter state only', {
        audienceScene: presentationState.audienceScene,
        slideId: position.id,
      });
      await publishAndApplyBindings(presentationState, position.id);
      await recordResumePoint(position.id, currentIndex);
      return;
    }

    if (skipAudienceTransition && frozenDriverCommand !== null) {
      // The observer command already froze the audience, but this advance
      // cannot change the audience frame (same scene, same slots, no
      // commands): cut straight back instead of running a pointless
      // directional reveal on top of the freeze.
      logger.info('Same audience scene behind command freeze; cutting back without slide transition', {
        audienceScene: presentationState.audienceScene,
        slideId: position.id,
      });
      try {
        await transitionRunner.restoreAudienceScene(frozenDriverCommand.previousAudienceScene);
      } catch (error) {
        // An OBS hiccup must not strand the presenter on the freeze scene:
        // log it and still publish the presenter state below.
        logger.error('Failed to cut back to the audience scene behind command freeze', {
          audienceScene: frozenDriverCommand.previousAudienceScene,
          error: error instanceof Error ? error.message : String(error),
          slideId: position.id,
        });
      }
      await publishAndApplyBindings(presentationState, position.id);
      await recordResumePoint(position.id, currentIndex);
      return;
    }

    await transitionRunner.runSlideTransition(transitions, presentationState, direction, position.id, slideConfig, async () => {
      // Register the settle waiter before publishing so a fast presenter ack
      // can never beat the listener.
      const windowSettled = settleTracker.expectWindowSettle(presentationState.seq, transitions.windowSettleMs);
      const driverSettled = settleTracker.expectDriverPositionSettle(driverEventId, DRIVER_SETTLE_TIMEOUT_MS);
      await publishAndApplyBindings(presentationState, position.id);
      // Every mutable surface must be truly settled before the reveal: driver
      // deck paint, presenter window geometry, and any browser commands.
      logger.info('Waiting for transition dependencies to settle', {
        driverEventId,
        seq: presentationState.seq,
        slideId: position.id,
      });
      await Promise.all([
        transitionRunner.dispatchBrowserCommands(slideConfig, position.id),
        windowSettled,
        driverSettled,
      ]);
    }, {
      baselineSourceData: frozenDriverCommand?.baselineSourceData ?? null,
      freezeAlreadyVisible: frozenDriverCommand !== null,
      previousPresentationState,
    });

    await recordResumePoint(position.id, currentIndex);
  }

  function handleDriverPositionChanged(position) {
    const eventId = Number.isInteger(position?.meta?.driverEventId) ? position.meta.driverEventId : null;

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return enqueueSlideOperation(() => processDriverPositionChanged(position));
    }

    return settleTracker.stageDriverPosition(eventId, position, {
      onStage: () => {
        if (pendingFrozenDriverCommand !== null) {
          clearTimeout(pendingFrozenDriverCommand.restoreTimer);
          pendingFrozenDriverCommand.restoreTimer = null;
        }
      },
    });
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
      await transitionRunner.showFreezeScene(transitions);
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
      transitionRunner.restoreAudienceScene(previousAudienceScene).catch((restoreError) => {
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
        await transitionRunner.restoreAudienceScene(previousAudienceScene);
      }
    } catch (error) {
      clearTimeout(restoreTimer);
      pendingFrozenDriverCommand = null;
      await transitionRunner.restoreAudienceScene(previousAudienceScene).catch(() => {});
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
    if (!windowBindings.mergeObserverBindings(payload)) {
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

  function handleObserverWindowSettled(payload) {
    settleTracker.handleWindowSettled(payload);
  }

  function handleDriverPositionSettled(payload) {
    settleTracker.handleDriverPositionSettled(payload);
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

      wireRecoveryEvents();

      logger.info('Starting coordinator', { driver: options.config.driver.type });

      try {
        await options.obs.connect();
        obsStarted = true;

        await transitionRunner.ensureFreezeAssetsIfConfigured();
        await transitionRunner.ensureStudioModeForSessionIfSupported();

        if (executor !== null) {
          await executor.start();
          executorStarted = true;
        }

        await options.hub.start();
        hubStarted = true;

        if (presenterPublisher !== null) {
          await presenterPublisher.pollStatus().catch((error) => {
            logger.warn('Initial presenter status poll failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
          presenterPublisher.startTimers({ isRunning: () => started });
        }

        started = true;
        logger.info('Coordinator started', { driver: options.config.driver.type });
      } catch (error) {
        if (hubStarted) {
          await options.hub.stop().catch(() => {});
          hubStarted = false;
        }

        await transitionRunner.restoreStudioModeIfManaged();

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
          presenterPublisher?.stopTimers();

          await transitionRunner.restoreStudioModeIfManaged();

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
      return presenterPublisher === null ? null : presenterPublisher.getState();
    },

    getRuntimeWindowBindings() {
      return windowBindings.snapshot();
    },

    async refreshCurrentPresentationState(reason = 'refresh') {
      await republishCurrentPresentationState(reason);
    },

    async reapplyCurrentSlide(reason, reapplyOptions) {
      return runReapplyCurrentSlide(reason, reapplyOptions);
    },

    awaitSlideOperations() {
      return slideOperation.catch(() => {});
    },

    async tickPresenterState(nowMs = Date.now()) {
      if (presenterPublisher === null) {
        return null;
      }

      return presenterPublisher.publishOnTick(nowMs);
    },

    getProgramPreviewSnapshot() {
      return presenterPublisher === null ? null : presenterPublisher.createProgramPreviewSnapshot();
    },

    handleDriverPositionChanged,
  };
}
