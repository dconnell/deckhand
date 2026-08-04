import { diffNewWindows } from './macWindows.js';

function createNoopLogger() {
  return { info() {}, warn() {}, error() {} };
}

/**
 * Resolve exact `macWindowId` bindings for owned app-window sources.
 *
 * Each entry pairs a launch strategy (the per-app mechanism that opens the
 * window) with a snapshot function (how to enumerate that owner's windows) and
 * an optional title confirmation signal used to reject transient splash
 * windows. The resolver snapshots before launch, launches, then polls the
 * snapshot and diffs until exactly the new window appears - title-independent
 * identity for any app Deckhand launches (`plans/app-sources.md`).
 *
 * The launch and snapshot layers are injected so the diff/poll logic is
 * unit-testable without real windows; `src/index.js` wires the concrete
 * strategies per source kind.
 *
 * @param {{ entries: Array<{ sourceId: string, snapshot: () => Array<{ windowId: number, title?: string }>, launch: () => Promise<{ pid?: number }>, confirm?: { titleIncludes?: string, rejectEmptyTitle?: boolean, stableSamples?: number } }>, delay: (ms: number) => Promise<void>, maxAttempts?: number, retryDelayMs?: number, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Resolver options.
 * @returns {Promise<Record<string, { macWindowId: number, pid?: number }>>}
 */
export async function resolveOwnedWindowBindings(options) {
  const logger = options.logger ?? createNoopLogger();
  const maxAttempts = options.maxAttempts ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const results = {};

  for (const entry of options.entries) {
    try {
      const before = entry.snapshot();
      const launchResult = await entry.launch();
      let resolved = null;
      const stableSamples = Number.isInteger(entry.confirm?.stableSamples) && entry.confirm.stableSamples > 0
        ? entry.confirm.stableSamples
        : 1;
      const stableCounts = new Map();

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const after = entry.snapshot();
        const newWindows = diffNewWindows(before, after, entry.confirm);

        if (newWindows.length > 0) {
          // When an app launch creates multiple CGWindowID entries (Electron
          // apps create helper/toolbar windows alongside the main window),
          // pick the one with the largest bounds area — that is the real
          // editor/application window, not a 1800×39 toolbar strip.
          // For single-window results (iTerm2), newWindows[0] is sufficient.
          const best = newWindows.length === 1
            ? newWindows[0]
            : newWindows.reduce((a, b) => {
              const areaA = (a.width ?? 0) * (a.height ?? 0);
              const areaB = (b.width ?? 0) * (b.height ?? 0);
              if (areaB === areaA) {
                return b.windowId > a.windowId ? b : a;
              }
              return areaB > areaA ? b : a;
            });
          const nextStableCount = (stableCounts.get(best.windowId) ?? 0) + 1;
          stableCounts.set(best.windowId, nextStableCount);

          if (nextStableCount < stableSamples) {
            if (attempt < maxAttempts) {
              await delay(retryDelayMs);
            }
            continue;
          }

          resolved = { macWindowId: best.windowId };

          if (typeof best.pid === 'number') {
            resolved.pid = best.pid;
          }

          if (typeof best.ownerName === 'string') {
            resolved.ownerName = best.ownerName;
          }
          break;
        }

        if (attempt < maxAttempts) {
          await delay(retryDelayMs);
        }
      }

      if (resolved === null) {
        logger.warn('Owned source window did not appear; leaving binding unresolved', { source: entry.sourceId });
        continue;
      }

      if (resolved.pid === undefined && typeof launchResult?.pid === 'number') {
        resolved.pid = launchResult.pid;
      }

      if (resolved.sessionId === undefined && typeof launchResult?.sessionId === 'string') {
        resolved.sessionId = launchResult.sessionId;
      }

      results[entry.sourceId] = resolved;
      logger.info('Resolved owned source window binding', {
        macWindowId: resolved.macWindowId,
        pid: resolved.pid ?? null,
        source: entry.sourceId,
      });
    } catch (error) {
      logger.error('Owned source launch failed', {
        error: error instanceof Error ? error.message : String(error),
        source: entry.sourceId,
      });
    }
  }

  return results;
}
