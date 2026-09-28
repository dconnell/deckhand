import { createPresenterSession } from '../presenter/session.js';
import { reduceStreamHealth } from '../presenter/reduceStreamHealth.js';

const PRESENTER_FOLLOW_TICK_MS = 250;
const PRESENTER_STATUS_POLL_MS = 5000;

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
 * The presenter publisher surface used by `createCoordinator`.
 *
 * @typedef {object} PresenterPublisher
 * @property {(nowMs?: number) => Promise<Record<string, unknown>>} publishPresenterState Tick the session and publish sticky presenter state.
 * @property {(nowMs?: number) => Promise<Record<string, unknown> | null>} publishOnTick Tick the session; publish only when the tick reports a change.
 * @property {(nowMs?: number) => Promise<Record<string, unknown> | null>} pollStatus Refresh preview + stream health, then publish presenter state.
 * @property {(presentationState: Record<string, unknown>, nowMs?: number) => Promise<Record<string, unknown>>} syncFromPresentation Apply a presentation state and publish presenter state.
 * @property {(payload: { manifest?: Record<string, unknown> }) => Promise<void>} applySlideManifest Reduce a driver slide manifest into presenter state and publish.
 * @property {(payload: { transcript?: Record<string, unknown> }) => Promise<void>} applyTranscript Reduce an observer transcript into presenter state and publish.
 * @property {(command: Record<string, unknown>, nowMs?: number) => Promise<Record<string, unknown>>} applyCommand Apply a presenter command and publish presenter state.
 * @property {() => { body: Buffer, etag: string, lastModified: string } | null} createProgramPreviewSnapshot Latest program preview for HTTP serving.
 * @property {(options: { isRunning: () => boolean }) => void} startTimers Start the sticky follow and status poll intervals.
 * @property {() => void} stopTimers Clear any running intervals.
 * @property {() => Record<string, unknown>} getState Current presenter session state.
 */

/**
 * Create the presenter publisher: one owner for the presenter session, its
 * sticky publishes, the program preview cache, stream-health reduction, and
 * the follow/status interval timers.
 *
 * @param {object} options Publisher dependencies.
 * @param {Record<string, unknown>} options.presenterConfig The `presenter` block of the normalized config (non-null).
 * @param {import('../contracts/coordinator.js').CoordinatorHub} options.hub Hub used for sticky presenter publishes.
 * @param {import('../contracts/coordinator.js').CoordinatorObsClient} options.obs OBS client probed for preview and stream status.
 * @param {import('../logger.js').Logger} options.logger Shared logger.
 * @param {number} [options.followTickMs] Sticky follow tick interval.
 * @param {number} [options.statusPollMs] Status poll interval.
 * @returns {PresenterPublisher} The publisher.
 */
export function createPresenterPublisher(options) {
  const { presenterConfig, hub, obs, logger, followTickMs = PRESENTER_FOLLOW_TICK_MS, statusPollMs = PRESENTER_STATUS_POLL_MS } = options;
  const presenterSession = createPresenterSession({
    followEnabledByDefault: presenterConfig.teleprompter.followEnabledByDefault,
    predictionLeadMs: resolvePresenterPredictionLeadMs(presenterConfig.stt),
    tracking: presenterConfig.teleprompter.tracking,
  });
  let presenterFollowTimer = null;
  let presenterStatusTimer = null;
  let presenterPreview = null;
  let previousStreamStatus = null;

  async function publishPresenterState(nowMs = Date.now()) {
    presenterSession.tick(nowMs);
    const presenterState = presenterSession.getState();
    await hub.publishSticky('presenterState', presenterState);
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
    if (typeof obs.getProgramScreenshotBuffer !== 'function') {
      return;
    }

    try {
      const body = await obs.getProgramScreenshotBuffer();
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
    if (typeof obs.getStreamStatus !== 'function') {
      return;
    }

    try {
      const status = await obs.getStreamStatus();
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

  async function pollStatus(nowMs = Date.now()) {
    await Promise.all([
      refreshProgramPreview(nowMs),
      refreshStreamHealth(nowMs),
      presenterSession.tick(nowMs),
    ]);

    return publishPresenterState(nowMs);
  }

  async function publishOnTick(nowMs = Date.now()) {
    if (!presenterSession.tick(nowMs)) {
      return presenterSession.getState();
    }

    const presenterState = presenterSession.getState();
    await hub.publishSticky('presenterState', presenterState);
    return presenterState;
  }

  async function syncFromPresentation(presentationState, nowMs = Date.now()) {
    presenterSession.applyPresentationState(presentationState, nowMs);
    await hub.publishSticky('presenterState', presenterSession.getState());
    return presenterSession.getState();
  }

  async function applySlideManifest(payload) {
    if (!payload?.manifest) {
      return;
    }

    try {
      presenterSession.applySlideManifest(payload.manifest, Date.now());
      await hub.publishSticky('presenterState', presenterSession.getState());
      logger.info('Updated presenter state from driver slide manifest', {
        slideCount: payload.manifest.slides.length,
      });
    } catch (error) {
      logger.error('Failed to reduce driver slide manifest into presenter state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function applyTranscript(payload) {
    if (payload?.transcript === undefined) {
      return;
    }

    presenterSession.applyTranscript(payload.transcript, Date.now());
    await hub.publishSticky('presenterState', presenterSession.getState());
  }

  async function applyCommand(command, nowMs = Date.now()) {
    presenterSession.applyCommand(command, nowMs);
    await hub.publishSticky('presenterState', presenterSession.getState());
    return presenterSession.getState();
  }

  function startTimers({ isRunning }) {
    presenterFollowTimer = setInterval(() => {
      if (!isRunning()) {
        return;
      }

      void (async () => {
        try {
          await publishOnTick(Date.now());
        } catch (error) {
          logger.warn('Presenter follow publish failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, followTickMs);
    presenterFollowTimer.unref?.();
    presenterStatusTimer = setInterval(() => {
      pollStatus().catch((error) => {
        logger.warn('Presenter status poll failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, statusPollMs);
    presenterStatusTimer.unref?.();
  }

  function stopTimers() {
    if (presenterFollowTimer !== null) {
      clearInterval(presenterFollowTimer);
      presenterFollowTimer = null;
    }

    if (presenterStatusTimer !== null) {
      clearInterval(presenterStatusTimer);
      presenterStatusTimer = null;
    }
  }

  function getState() {
    return presenterSession.getState();
  }

  return {
    publishPresenterState,
    publishOnTick,
    pollStatus,
    syncFromPresentation,
    applySlideManifest,
    applyTranscript,
    applyCommand,
    createProgramPreviewSnapshot,
    startTimers,
    stopTimers,
    getState,
  };
}
