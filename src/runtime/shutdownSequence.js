import {
  closeOwnedAppWindows,
  getSourceOwnerName,
  isPromiseLike,
  shouldDiscardUnsavedChanges,
} from '../appRuntime.js';

/**
 * Await a teardown step but give up on it after `timeoutMs`, reporting whether
 * the budget elapsed. A rejection from the step still propagates once the
 * pending timer is cleared, so callers decide whether a rejection is fatal.
 *
 * @param {Promise<unknown>} promise Teardown step to wait for.
 * @param {number} timeoutMs Timeout budget in milliseconds.
 * @returns {Promise<boolean>} Whether the timeout elapsed before the step settled.
 */
async function awaitWithTimeout(promise, timeoutMs) {
  let timedOut = false;
  let timer = null;

  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    // A step that settles (or rejects) before the timeout must not leak the
    // pending timer into the rest of shutdown.
    clearTimeout(timer);
  }

  return timedOut;
}

/**
 * Default owned-window closer: forwards each shutdown binding to the shared
 * `closeOwnedAppWindows` helper with the configured source and mac-close
 * override.
 *
 * @param {{
 *   config: Record<string, any>,
 *   logger: Record<string, any>,
 *   closeMacWindowFn: (macWindowId: number, pid?: number, options?: object) => boolean | Promise<boolean>,
 * }} input
 * @returns {(input: { bindings: Array<object> }) => Promise<void>} closer
 */
function createDefaultCloseOwnedWindows({ config, logger, closeMacWindowFn }) {
  return async ({ bindings }) => {
    await closeOwnedAppWindows({
      entries: bindings.map((binding) => ({
        sourceId: binding.sourceId,
        source: config.sources[binding.sourceId],
        binding,
      })),
      logger,
      closeMacWindowFn,
    });
  };
}

/**
 * Stop a Chrome session this run launched, bounded by the stop timeout. A
 * stop that rejects after the timeout wins the race must not surface as an
 * unhandled rejection; a stop that rejects before it is swallowed as
 * best-effort cleanup.
 *
 * @param {{
 *   launch: { stop: () => Promise<void> } | null,
 *   timeoutMs: number,
 *   logger: Record<string, any>,
 * }} input
 * @returns {Promise<void>}
 */
export async function stopLaunchedChromeSession({ launch, timeoutMs, logger }) {
  if (launch === null || launch === undefined) {
    return;
  }

  try {
    const stopPromise = Promise.resolve(launch.stop());
    stopPromise.catch(() => {});

    const timedOut = await awaitWithTimeout(stopPromise, timeoutMs);

    if (timedOut) {
      logger.warn('Timed out stopping launched Chrome; continuing shutdown', { timeoutMs });
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Owns the runtime's ordered teardown. On SIGINT/SIGTERM/SIGHUP it runs the
 * fixed sequence — stop coordinator/browser runtime, kill the launched Chrome
 * process group, reap deckhand Chrome profiles, remove temp profile dirs, then
 * close owned app windows — with per-step timeout budgets, and exits.
 *
 * Why window closing runs LAST: closing an owned app window can kill
 * deckhand's own host process — deckhand often runs inside a VS Code
 * integrated terminal that is itself an owned app window. Once that window
 * closes, this process can die mid-teardown, so everything else (coordinator
 * stop with its OBS studio-mode restore, the Chrome kill) must complete BEFORE
 * any window is touched. The later steps read nothing from the window state,
 * so closing windows first was never a dependency — only a hazard.
 *
 * @param {{
 *   config: Record<string, any>,
 *   logger: Record<string, any>,
 *   registry: ReturnType<import('./windowBindingRegistry.js').createWindowBindingRegistry>,
 *   installSignalHandlers: boolean,
 *   stopTimeoutMs: number,
 *   closeTimeoutMs: number,
 *   closeMacWindowFn: (macWindowId: number, pid?: number, options?: object) => boolean | Promise<boolean>,
 *   closeOwnedWindowsFn?: (input: { bindings: Array<object> }) => Promise<void> | void,
 *   killProcessGroupFn: (pgid: number) => void,
 *   reapChromeProfilesFn: (command: string) => void,
 *   stopRuntime: () => Promise<void>,
 *   getChromePid: () => number | undefined,
 *   removeTempProfileDirs: () => Promise<void>,
 *   onShutdownStart: () => void,
 * }} input
 * @returns {{ install: () => void }} shutdown sequence
 */
export function createShutdownSequence({
  config,
  logger,
  registry,
  installSignalHandlers,
  stopTimeoutMs,
  closeTimeoutMs,
  closeMacWindowFn,
  closeOwnedWindowsFn,
  killProcessGroupFn,
  reapChromeProfilesFn,
  stopRuntime,
  getChromePid,
  removeTempProfileDirs,
  onShutdownStart,
}) {
  const closeOwnedWindows = closeOwnedWindowsFn
    ?? createDefaultCloseOwnedWindows({ config, logger, closeMacWindowFn });

  let shuttingDown = false;

  /**
   * Run the ordered teardown for one shutdown signal. Idempotent: the
   * `shuttingDown` flag keeps this to a single pass when several signals
   * arrive during one teardown.
   *
   * @param {string} signal Signal that triggered the shutdown.
   * @returns {Promise<void>} Resolves only via `process.exit`.
   */
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    onShutdownStart();
    logger.info('Received shutdown signal', { signal });

    const stopPromise = Promise.resolve(stopRuntime());
    // A stop that rejects after the timeout wins the race must not surface
    // as an unhandled rejection.
    stopPromise.catch(() => {});

    const stopTimedOut = await awaitWithTimeout(stopPromise, stopTimeoutMs);

    if (stopTimedOut) {
      logger.warn('Timed out stopping coordinator/browser runtime; continuing shutdown', { timeoutMs: stopTimeoutMs });
    }

    const chromePid = getChromePid();

    if (typeof chromePid === 'number' && chromePid > 0) {
      try {
        killProcessGroupFn(chromePid);
      } catch {
        // process group may have already exited
      }
    }

    try {
      reapChromeProfilesFn('pkill -9 -f "deckhand-chrome-profiles"');
    } catch {
      // no matching processes
    }

    try {
      reapChromeProfilesFn('pkill -9 -f "deckhand-profile-"');
    } catch {
      // no matching processes
    }

    // Chrome is dead by now, so the temp profile dirs can be removed. This
    // runs before the window teardown below, which may kill this very
    // process when it closes deckhand's own host terminal.
    await removeTempProfileDirs();

    // Windows last (see the why-comment at the top of this module): a close
    // that kills the host terminal must not be able to preempt the OBS
    // restore or the Chrome kill above.
    for (const [sourceId, source] of Object.entries(config.sources)) {
      if (source.kind !== 'app') {
        continue;
      }

      const cached = registry.getForShutdown(sourceId);
      if (cached?.macWindowId === undefined && cached?.sessionId === undefined && cached?.pid === undefined) {
        logger.warn('No window binding available for owned app source; leaving its window open', { source: sourceId });
        continue;
      }

      try {
        const closeResult = closeOwnedWindows({
          bindings: [{
            kind: source.kind,
            sourceId,
            discardUnsavedChanges: shouldDiscardUnsavedChanges(source),
            macWindowId: cached?.macWindowId,
            ownerName: getSourceOwnerName(config, sourceId),
            pid: cached?.pid,
            sessionId: cached?.sessionId,
          }],
        });

        if (isPromiseLike(closeResult)) {
          const timedOut = await awaitWithTimeout(closeResult, closeTimeoutMs);

          if (timedOut) {
            logger.warn('Timed out closing owned app window; continuing shutdown', { source: sourceId, timeoutMs: closeTimeoutMs });
            continue;
          }
        }

        logger.info('Closed owned app window', { source: sourceId });
      } catch (error) {
        logger.warn('Failed to close owned app window', {
          source: sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    process.exit(0);
  }

  function bindShutdownSignal(signal) {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        logger.error('Shutdown sequence failed', {
          signal,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  return {
    /** Bind the shutdown signals when signal handling is enabled for this run. */
    install() {
      if (!installSignalHandlers) {
        return;
      }

      bindShutdownSignal('SIGINT');
      bindShutdownSignal('SIGTERM');
      // SIGHUP: the host terminal died (e.g. its window was closed) — run the
      // same teardown flow.
      bindShutdownSignal('SIGHUP');
    },
  };
}
