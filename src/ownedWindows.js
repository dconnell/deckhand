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
 * @param {{ entries: Array<{ sourceId: string, snapshot: () => Array<{ windowId: number, title?: string }>, launch: () => Promise<{ pid?: number }>, confirm?: { titleIncludes?: string, rejectEmptyTitle?: boolean } }>, delay: (ms: number) => Promise<void>, maxAttempts?: number, retryDelayMs?: number, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Resolver options.
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

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const after = entry.snapshot();
        const newWindows = diffNewWindows(before, after, entry.confirm);

        if (newWindows.length > 0) {
          resolved = { macWindowId: newWindows[0].windowId };
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

      if (typeof launchResult?.pid === 'number') {
        resolved.pid = launchResult.pid;
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
