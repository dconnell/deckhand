import { createOwnedWindowResolutionEntries } from '../appRuntime.js';
import { resolveOwnedWindowBindings } from '../ownedWindows.js';

/**
 * Relaunch a single owned app source (`open -a`) and re-resolve its macOS
 * window id by diffing CGWindowList around the launch. This is the default
 * implementation of `options.relaunchAppSourceFn`; inject a stub in tests.
 *
 * @param {{ config: Record<string, unknown>, logger: Record<string, unknown>, sourceId: string }} input
 * @returns {Promise<{ macWindowId?: number, pid?: number } | null>}
 */
export async function defaultRelaunchAppSource({ config, logger, sourceId }) {
  const entries = createOwnedWindowResolutionEntries({ config, logger });
  const entry = entries.find((candidate) => candidate.sourceId === sourceId);

  if (entry === undefined) {
    return null;
  }

  const result = await resolveOwnedWindowBindings({ entries: [entry], maxAttempts: 30, logger });
  return result[sourceId] ?? null;
}

/**
 * Owns per-source window relaunch on operator demand (the presenter console's
 * per-source "relaunch" button). Dispatches by source kind: browser sources
 * are rebuilt inside the Chrome session; app sources are re-launched via
 * `open -a` and re-resolved. After the fresh macWindowId lands the current
 * slide's OBS bindings are re-applied. Relaunch is non-destructive: it does
 * not close the old window first, matching the chosen "relaunch + rebind
 * only" behavior.
 *
 * The browser session and coordinator are read through accessors because
 * they are created after this module in `run()`'s wiring order.
 *
 * @param {{
 *   config: Record<string, any>,
 *   logger: Record<string, any>,
 *   registry: ReturnType<import('./windowBindingRegistry.js').createWindowBindingRegistry>,
 *   getBrowserSession: () => Record<string, any> | null,
 *   getCoordinator: () => Record<string, any> | null | undefined,
 *   relaunchAppSourceFn?: (input: { config: Record<string, unknown>, logger: Record<string, unknown>, sourceId: string }) => Promise<{ macWindowId?: number, pid?: number } | null>,
 * }} input
 * @returns {(input: { sourceId: string }) => Promise<{ sourceId: string, macWindowId: number | null, binding: object | null }>} relaunchSource
 */
export function createSourceRelauncher({
  config,
  logger,
  registry,
  getBrowserSession,
  getCoordinator,
  relaunchAppSourceFn,
}) {
  /**
   * Relaunch one managed source window and rebind it.
   *
   * @param {{ sourceId: string }} input The source id to relaunch.
   * @returns {Promise<{ sourceId: string, macWindowId: number | null, binding: object | null }>}
   */
  return async function relaunchSource({ sourceId }) {
    const source = config.sources[sourceId];

    if (source === undefined) {
      throw new Error(`unknown source: ${sourceId}`);
    }

    if (source.kind === 'browser') {
      const browserSession = getBrowserSession();

      if (browserSession === null) {
        throw new Error('browser session is not started');
      }

      const result = await browserSession.relaunchBrowserSource(sourceId);
      registry.set(sourceId, {
        macWindowId: result.macWindowId,
        pid: browserSession.getStatus().chromePid ?? undefined,
      });
    } else if (source.kind === 'app') {
      const relaunchAppSource = relaunchAppSourceFn ?? defaultRelaunchAppSource;
      const result = await relaunchAppSource({ config, logger, sourceId });

      if (result?.macWindowId === undefined) {
        // The launch may have succeeded but the window could not be resolved.
        // Drop any stale binding: it points at the closed window and would
        // misdirect both the OBS capture binding and the shutdown close.
        // Only stash a live binding: when the observer `cleared` event already
        // stashed the last-known binding, assigning undefined here would
        // clobber it and shutdown would leak the still-open original window.
        registry.stashForShutdown(sourceId);
        logger.warn('Relaunched app source window could not be resolved; cleared stale binding', { sourceId });
      } else {
        // The fresh resolution is authoritative. Adapter identity fields
        // (sessionId for iTerm2, terminalWindowId for Terminal.app) must
        // replace — not merge with — the old ones, or shutdown would close
        // the dead pre-relaunch session and leak the new window.
        registry.set(sourceId, { ...result });
      }
    } else {
      throw new Error(`source ${sourceId} (kind ${source.kind}) cannot be relaunched`);
    }

    const coordinator = getCoordinator();
    if (coordinator && typeof coordinator.reapplyCurrentSlide === 'function') {
      await coordinator.reapplyCurrentSlide('sourceRelaunched');
    }

    const binding = registry.get(sourceId) ?? null;
    const macWindowId = binding?.macWindowId ?? null;
    logger.info('Relaunched source window', { sourceId, macWindowId });

    return { sourceId, macWindowId, binding };
  };
}
