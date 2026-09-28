import path from 'node:path';

import { resolveAppAdapter } from './apps/index.js';
import { listOwnedAppSourceEntries } from './appRuntime.js';
import { enumerateWindowsByOwnerName } from './macWindows.js';

function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

/**
 * Whether a window entry carries a usable (non-empty) title.
 *
 * @param {Record<string, unknown>} window Raw window entry.
 * @returns {boolean} True when `title` is a non-whitespace-only string.
 */
function hasNonEmptyTitle(window) {
  return typeof window?.title === 'string' && window.title.trim() !== '';
}

/**
 * Drop Electron helper/utility window entries from a CGWindowList enumeration.
 *
 * Why: Electron apps register untitled helper/utility entries alongside real
 * windows, so a raw entry count inflates the preflight report (observed: "6
 * window(s) open" for 2 real VS Code windows). Heuristic, with a defined
 * failure mode: if ANY entry carries a non-empty title, only titled entries
 * are kept (helpers are untitled in practice); if NO entry has a title —
 * typically because Screen Recording permission is missing and
 * `kCGWindowName` is unreadable — fall back to a size filter that drops
 * toolbar strips (`width`/`height` below 300). The dimension-less branch is
 * effectively unreachable with the real enumerator, which always attaches
 * numeric `width`/`height` (Swift defaults 0, so 0×0 entries are dropped by
 * the size fallback); it only applies to injected/test enumerators whose
 * entries lack dimensions, where there is no basis to call them helpers and
 * they are kept.
 *
 * @param {unknown} windows Raw window entries from the enumerator (may not be an array).
 * @returns {Array<Record<string, unknown>>} Entries that look like real windows.
 */
export function filterRealWindows(windows) {
  if (!Array.isArray(windows)) {
    return [];
  }

  if (windows.some(hasNonEmptyTitle)) {
    return windows.filter(hasNonEmptyTitle);
  }

  return windows.filter((window) => {
    if (typeof window?.width !== 'number' || typeof window?.height !== 'number') {
      return true;
    }

    return window.width >= 300 && window.height >= 300;
  });
}

/**
 * Derive the workspace folder name a gated source is configured to open.
 *
 * Why: VS Code window titles contain the workspace folder name ("postinstall.js
 * — dc-enclave"), so the preflight gate can check whether THAT project is open
 * instead of blocking on any window of the app. This is a substring heuristic
 * and deliberately fails safe: when no window title mentions the workspace,
 * the gate stays quiet — the operator's unrelated projects must not block
 * startup.
 *
 * Scans `source.args` (in order), then `source.files` (in order), then
 * `source.cwd`, returning `path.basename` of the first value that is a string
 * starting with `/` and has a non-empty basename (e.g. `/` is skipped — an
 * empty hint would match every titled window). Recall is deliberately
 * limited: `files` entries are often files rather than workspace roots, so
 * the hint becomes a file name that only matches when that file is the
 * focused tab. A missed match fails open — the gate stays quiet.
 *
 * @param {unknown} source Normalized owned app source (or anything else).
 * @returns {string | null} Workspace folder name to match in window titles; `null` when nothing extractable.
 */
export function resolveWorkspaceHint(source) {
  const candidates = [];

  if (Array.isArray(source?.args)) {
    candidates.push(...source.args);
  }

  if (Array.isArray(source?.files)) {
    candidates.push(...source.files);
  }

  if (typeof source?.cwd === 'string') {
    candidates.push(source.cwd);
  }

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.startsWith('/')) {
      const base = path.basename(candidate);

      if (base !== '') {
        return base;
      }
    }
  }

  return null;
}

/**
 * Collect owned-app conflicts that must block startup.
 *
 * Deckhand launches Electron-family owned apps via `open -n` (a fresh app
 * instance) + `--new-window`. When the operator already has that app open,
 * offscreen capture of the deckhand-owned window degrades silently (observed:
 * black freeze frames), so an adapter declaring
 * `requiresExclusiveInstance: true` must find zero open windows before
 * deckhand touches OBS, Chrome, or any server. Terminal-family adapters do
 * not declare the flag — deckhand deliberately adds windows to the
 * already-running instance there.
 *
 * Two refinements keep the gate proportionate: helper noise is filtered out of
 * the enumeration (`filterRealWindows`), and when the source names a
 * workspace (`resolveWorkspaceHint`) only windows whose title mentions that
 * workspace conflict — the operator's unrelated windows of the same app do
 * not block startup.
 *
 * For workspace-scoped sources a CLI probe is preferred over enumeration when
 * the adapter exposes `listOpenWorkspaceNames` (VS Code's `code --status`):
 * it needs no Screen Recording permission and sees multi-root folders, so its
 * answer is authoritative — a match conflicts with `windowCount: null`, a
 * miss proceeds, and enumeration never runs. Only a failed probe falls back
 * to the enumeration path. The adapter method is awaited (the real probe runs
 * `code --status` as an async subprocess) and called directly rather than
 * through an extra injected executor option: the collector already takes
 * `resolveAppAdapterFn`, so tests stub fake adapters with their own
 * `listOpenWorkspaceNames`.
 *
 * This module is pure: dependency-injected enumeration and adapter
 * resolution, no process exits, no console output. The caller renders the
 * returned conflicts.
 *
 * @param {{ config: Record<string, unknown>, enumerateWindowsByOwnerNameFn?: (ownerName: string) => Array<unknown> | Promise<Array<unknown>>, resolveAppAdapterFn?: typeof resolveAppAdapter, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Collector options. `enumerateWindowsByOwnerNameFn` defaults to the real (async) CGWindowList enumerator, `resolveAppAdapterFn` to the real adapter registry.
 * @returns {Promise<Array<{ sourceId: string, app: string, ownerName: string, windowCount: number | null, match: string | null }>>} One conflict per gated source with conflicting windows (`match` holds the workspace folder name when the conflict was scoped by title or probe, `null` for any-window conflicts; `windowCount` is `null` for probe-scoped conflicts, which know workspaces rather than windows); empty when startup may proceed.
 */
export async function collectOwnedAppInstanceConflicts({
  config,
  enumerateWindowsByOwnerNameFn = enumerateWindowsByOwnerName,
  resolveAppAdapterFn = resolveAppAdapter,
  logger = createNoopLogger(),
}) {
  const conflicts = [];

  for (const [sourceId, source] of listOwnedAppSourceEntries(config)) {
    const adapter = resolveAppAdapterFn(source);

    if (adapter.requiresExclusiveInstance !== true) {
      continue;
    }

    const ownerName = adapter.cgWindowOwnerName(source);
    const workspaceHint = resolveWorkspaceHint(source);

    // Probe-authoritative: when the adapter can list open workspaces via the
    // app's CLI (VS Code's `code --status`), that answer decides the gate for
    // workspace-scoped sources — a match blocks, no match proceeds, and
    // window enumeration is never consulted. Why: the CLI probe needs no
    // Screen Recording permission (titles come back empty without it) and
    // sees multi-root folders that titles never show. Only a failed probe
    // (null/throw/non-array contract violation) falls back to enumeration,
    // which then keeps the fail-open title semantics below. The probe is
    // awaited because it shells out to `code --status` asynchronously; an
    // unawaited promise would read as a contract violation and silently
    // drop the authoritative answer.
    if (workspaceHint !== null && typeof adapter.listOpenWorkspaceNames === 'function') {
      let probeResult = null;

      try {
        probeResult = await adapter.listOpenWorkspaceNames();
      } catch {
        probeResult = null;
      }

      if (Array.isArray(probeResult)) {
        if (probeResult.some((name) => typeof name === 'string'
          && name.toLowerCase() === workspaceHint.toLowerCase())) {
          conflicts.push({
            sourceId,
            app: source.app,
            ownerName,
            // The probe knows about workspaces, not windows — there is no
            // meaningful window count to report.
            windowCount: null,
            match: workspaceHint,
          });
        }

        continue;
      }
    }

    let windows;
    try {
      // Awaited so the real async CGWindowList enumerator works alongside the
      // sync fakes used in tests; a rejection lands in the catch below just
      // like a synchronous throw.
      windows = await enumerateWindowsByOwnerNameFn(ownerName);
    } catch (error) {
      // A broken preflight check must never block the show: log and let the
      // source proceed to the normal launch path.
      logger.warn('Failed to enumerate windows for owned app during preflight; skipping check', {
        source,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const realWindows = filterRealWindows(windows);

    const conflictingWindows = workspaceHint === null
      ? realWindows
      : realWindows.filter((window) => typeof window?.title === 'string'
        && window.title.toLowerCase().includes(workspaceHint.toLowerCase()));

    // In hint mode, real windows with zero non-empty titles mean the title
    // check verified nothing (typically no Screen Recording permission). Keep
    // the fail-open behavior, but say so in the log.
    if (workspaceHint !== null && realWindows.length > 0 && !realWindows.some(hasNonEmptyTitle)) {
      logger.warn('Could not read window titles; unable to verify whether the workspace is already open', {
        source: sourceId,
        app: source.app,
      });
    }

    if (conflictingWindows.length > 0) {
      conflicts.push({
        sourceId,
        app: source.app,
        ownerName,
        windowCount: conflictingWindows.length,
        match: workspaceHint,
      });
    }
  }

  return conflicts;
}
