const DRIVER_SETTLE_TIMEOUT_MS = 2000;

/**
 * Process a driver position through the coordinator's serialized slide
 * operation queue. Injected so the tracker owns settle state but never the
 * queue itself.
 *
 * @callback ProcessPosition
 * @param {Record<string, unknown>} position Driver position payload to process.
 * @returns {Promise<void>} Resolves when the position has been processed.
 */

/**
 * Hook run whenever a new driver position is staged: the coordinator uses it
 * to cancel the frozen-command restore timer for the position about to queue.
 *
 * @callback OnStagePosition
 * @returns {void}
 */

/**
 * The settle tracker surface used by `createCoordinator`.
 *
 * @typedef {object} SettleTracker
 * @property {(seq: number, timeoutMs: number) => Promise<void>} expectWindowSettle Register a deferred awaiting the presenter `windowSettled` ack for `seq`.
 * @property {(payload: Record<string, unknown>) => void} handleWindowSettled Resolve the window-settle waiter for an ack, warning once per placement skip and frame mismatch.
 * @property {(eventId: number | null, timeoutMs: number) => Promise<void>} expectDriverPositionSettle Register a deferred awaiting the driver position-settle ack.
 * @property {(payload: Record<string, unknown>) => void} handleDriverPositionSettled Resolve the driver settle waiter or run a staged position on ack.
 * @property {(eventId: number, position: Record<string, unknown>, hooks: { onStage?: OnStagePosition }) => Promise<void>} stageDriverPosition Stage a driver position until its settle ack (or timeout) arrives.
 */

/**
 * Create the settle tracker: one owner for the window-settle waiters, the
 * driver settle waiters, and the staged pending driver positions, including
 * their timers and warn-once diagnostics.
 *
 * @param {object} options Tracker dependencies.
 * @param {import('../logger.js').Logger} options.logger Shared logger.
 * @param {boolean} options.presenterEnabled Whether a presenter is configured; window-settle waits resolve immediately when false.
 * @param {ProcessPosition} options.processPosition Runs a staged driver position through the slide operation queue.
 * @param {number} [options.driverSettleTimeoutMs] Fallback budget for driver settle acks.
 * @returns {SettleTracker} The tracker.
 */
export function createSettleTracker(options) {
  const {
    logger,
    presenterEnabled,
    processPosition,
    driverSettleTimeoutMs = DRIVER_SETTLE_TIMEOUT_MS,
  } = options;
  // Seq-keyed deferreds awaiting the presenter's `windowSettled` ack, so a slide
  // change reveals only after the physical windows have actually moved/resized
  // instead of after a guessed fixed delay.
  const windowSettleWaiters = new Map();
  // Signatures of frame mismatches already warned about, so the same mismatch
  // (same source, requested, observed) warns only once per process: slide
  // changes re-apply identical rects and would otherwise repeat the warning
  // on every advance.
  const warnedFrameMismatches = new Set();
  // Whether the placement-skip warning already fired: the skip state persists
  // across slides (the arrangement only changes when displays change), so a
  // single warning per process is enough and per-slide repeats would be spam.
  let warnedPlacementSkip = false;
  const driverSettleWaiters = new Map();
  const completedDriverSettleEvents = new Set();
  const pendingDriverPositions = new Map();

  function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    return { promise, resolve, reject };
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
    if (!presenterEnabled) {
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

  function handleWindowSettled(payload) {
    const seq = payload?.seq;

    if (typeof seq !== 'number') {
      return;
    }

    logger.info('Received presenter window-settle ack', { seq });

    // Warn-only: a placement skip means the presenter left every window where
    // macOS launched it because the configured rects don't fit the current
    // displays. Never suppresses the ack or the waiter resolution.
    if (payload?.placementSkipped !== undefined && !warnedPlacementSkip) {
      warnedPlacementSkip = true;
      logger.warn('Window placement skipped: configured stage/overlay rects do not fit the current display arrangement; windows left as launched and presenter overlays kept back');
    }

    // Warn-only: frame mismatches (e.g. OBS clamping a configured rect) are
    // informational and never suppress the ack or the waiter resolution.
    for (const mismatch of payload?.frameMismatches ?? []) {
      const signature = `${mismatch.source}|${mismatch.requested.x},${mismatch.requested.y},${mismatch.requested.w}x${mismatch.requested.h}|${mismatch.observed.x},${mismatch.observed.y},${mismatch.observed.w}x${mismatch.observed.h}`;

      if (warnedFrameMismatches.has(signature)) {
        continue;
      }

      warnedFrameMismatches.add(signature);
      logger.warn('Window did not settle to configured rect', {
        source: mismatch.source,
        requested: mismatch.requested,
        observed: mismatch.observed,
      });
    }

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
      processPosition(pending.position).then(pending.resolve, pending.reject);
      return;
    }

    completedDriverSettleEvents.add(eventId);
  }

  function stageDriverPosition(eventId, position, { onStage } = {}) {
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

    onStage?.();

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
      processPosition(pending.position).then(pending.resolve, pending.reject);
    }, driverSettleTimeoutMs);

    pendingDriverPositions.set(eventId, {
      position,
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer,
    });
    return deferred.promise;
  }

  return {
    expectWindowSettle,
    handleWindowSettled,
    expectDriverPositionSettle,
    handleDriverPositionSettled,
    stageDriverPosition,
  };
}

export { DRIVER_SETTLE_TIMEOUT_MS };
