import { resolveAppAdapter } from './apps/index.js';
import { launchAppWindow } from './launchers/app.js';
import { closeIterm2OwnedWindow, launchIterm2Window } from './launchers/iterm2.js';
import { delay } from './lifecycle/waitFor.js';
import { diffNewWindows, enumerateWindowsByOwnerName, enumerateWindowsByPid } from './macWindows.js';
import { resolveOwnedWindowBindings } from './ownedWindows.js';

const APP_SHUTDOWN_GRACE_MS = 2000;

function isMissingProcessError(error) {
  return error instanceof Error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ESRCH';
}

function isPromiseLike(value) {
  return value !== null
    && typeof value === 'object'
    && 'then' in value
    && typeof value.then === 'function';
}

async function terminateProcessGroup(pid, logger, sourceId, graceMs = APP_SHUTDOWN_GRACE_MS) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (!isMissingProcessError(error)) {
      logger.warn('Failed to send SIGTERM to owned app process group', {
        source: sourceId,
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  await delay(graceMs);

  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      logger.warn('Failed to probe owned app process group after SIGTERM', {
        source: sourceId,
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
    logger.warn('Escalated owned app process-group shutdown to SIGKILL', { source: sourceId, pid });
  } catch (error) {
    if (!isMissingProcessError(error)) {
      logger.warn('Failed to send SIGKILL to owned app process group', {
        source: sourceId,
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function hasBrowserSources(config) {
  return Object.values(config.sources).some((source) => source?.kind === 'browser');
}

function listBrowserSourceIds(config) {
  return Object.entries(config.sources)
    .filter(([, source]) => source?.kind === 'browser')
    .map(([id]) => id);
}

/**
 * Derive the macOS CGWindow owner name for a source.
 *
 * `app` sources resolve their owner through the adapter registry; browser
 * sources fall back to the configured app name (or Google Chrome).
 *
 * @param {{ sources: Record<string, { kind: string, app?: string }>, presenter?: null | { windows: Record<string, { app?: string }> } }} config Normalized config.
 * @param {string} sourceId Logical source ID.
 * @returns {string}
 */
function getSourceOwnerName(config, sourceId) {
  const source = config.sources[sourceId];

  if (source?.kind === 'app') {
    return resolveAppAdapter(source).cgWindowOwnerName(source);
  }

  return config.presenter?.windows?.[sourceId]?.app ?? 'Google Chrome';
}

/**
 * List owned app-window sources that Deckhand must launch.
 *
 * @param {{ sources: Record<string, { kind: string }> }} config Normalized config.
 * @returns {Array<[string, { kind: string, command?: string, cwd?: string, app?: string, args?: string[] }]>}
 */
function listOwnedAppSourceEntries(config) {
  return Object.entries(config.sources).filter(([, source]) => source?.kind === 'app');
}

function buildBootstrapBinding(source, configuredBinding = {}) {
  if (source.kind !== 'app') {
    return { ...configuredBinding };
  }

  return resolveAppAdapter(source).buildBootstrapBinding(source, configuredBinding);
}

/**
 * Build OBS window-capture bindings from all resolved macWindowId bindings.
 *
 * Every reconcile must carry the full set of resolved bindings so that
 * processing a scene item for one source never silently regresses the
 * macWindowId of another (browser sources losing their exact window when the
 * owned-source reconcile processes browser scenes with an empty overlay).
 *
 * @param {{ sources: Record<string, { kind: string, app?: string }>, presenter?: null | { windows: Record<string, { app?: string }> } }} config Normalized config.
 * @param {Record<string, { macWindowId: number, pid?: number }>} resolvedMacWindowBindings Accumulated mac-window bindings (browser + owned).
 * @returns {Record<string, { app: string, macWindowId: number, strict: true, pid?: number }>}
 */
function buildObsWindowBindings(config, resolvedMacWindowBindings) {
  const bindings = {};

  for (const [sourceId, binding] of Object.entries(resolvedMacWindowBindings)) {
    if (!Object.prototype.hasOwnProperty.call(config.sources, sourceId)) {
      continue;
    }

    const obsBinding = {
      app: binding.ownerName ?? getSourceOwnerName(config, sourceId),
      macWindowId: binding.macWindowId,
      strict: true,
    };

    if (binding.pid !== undefined) {
      obsBinding.pid = binding.pid;
    }

    bindings[sourceId] = obsBinding;
  }

  return bindings;
}

function createOwnedWindowResolutionEntries({
  config,
  logger,
  enumerateWindowsByOwnerNameFn = enumerateWindowsByOwnerName,
  launchAppWindowFn = launchAppWindow,
  launchIterm2WindowFn = launchIterm2Window,
}) {
  const entries = [];

  for (const [sourceId, source] of listOwnedAppSourceEntries(config)) {
    const adapter = resolveAppAdapter(source);

    entries.push({
      sourceId,
      snapshot: () => enumerateWindowsByOwnerNameFn(adapter.cgWindowOwnerName(source)),
      launch: () => (typeof adapter.launch === 'function'
        ? adapter.launch(source, { launchIterm2Window: launchIterm2WindowFn })
        : launchAppWindowFn({
            app: source.app,
            args: adapter.buildLaunchArgs ? adapter.buildLaunchArgs(source) : source.args,
            cwd: source.cwd,
          })),
      confirm: adapter.confirm,
    });
  }

  logger.info('Launching owned app-window sources', { sources: entries.map((entry) => entry.sourceId) });
  return entries;
}

/**
 * Default launch+diff resolver for owned app-window sources.
 *
 * Builds an adapter-driven launch strategy per source and resolves each via
 * the generic owned-window resolver. No-ops when there are no owned app
 * sources.
 *
 * @param {{ config: { sources: Record<string, { kind: string, command?: string, cwd?: string, app?: string, args?: string[] }> } }} options Resolver options.
 * @param {{ info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void }} logger Logger.
 * @returns {Promise<Record<string, { macWindowId: number, pid?: number }>>}
 */
async function defaultResolveOwnedWindowBindings({ config, logger }) {
  const entries = createOwnedWindowResolutionEntries({ config, logger });

  return resolveOwnedWindowBindings({
    entries,
    delay,
    maxAttempts: 30,
    logger,
  });
}

async function resolvePresenterTeleprompterBinding({ browserSession, config, logger }) {
  const chromePid = browserSession?.getStatus().chromePid ?? null;
  const selector = config.presenter?.teleprompter?.window ?? null;

  if (selector === null || !Number.isInteger(chromePid) || chromePid <= 0) {
    return null;
  }

  const before = enumerateWindowsByPid(chromePid);
  await browserSession.openWindow(`http://${config.presenter.http.host}:${config.presenter.http.port}/presenter/`);
  const after = enumerateWindowsByPid(chromePid);
  const matches = diffNewWindows(before, after, {
    rejectEmptyTitle: true,
    titleIncludes: selector.titleIncludes,
  });

  if (matches.length === 0) {
    logger.warn('Failed to resolve presenter teleprompter window binding at launch');
    return null;
  }

  const match = matches[0];
  return {
    macWindowId: match.windowId,
    pid: chromePid,
  };
}

async function defaultResolveMacWindowBindings({ browserSession, browserSourceIds, config, logger }) {
  logger.info('Resolving macOS window IDs for browser sources');

  const sourceTitles = Object.fromEntries(
    Object.entries(browserSession.getRegistry().sources)
      .filter(([id]) => browserSourceIds.includes(id))
      .map(([id, source]) => [id, { title: source.title }]),
  );

  const chromePid = browserSession.getStatus().chromePid;

  let resolvedBindings = {};
  const maxAttempts = 10;
  const retryDelayMs = 500;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    resolvedBindings = {};

    const macWindows = enumerateWindowsByPid(chromePid);
    const matchedWindowIds = new Set();
    const unmatchedSources = [];
    const unmatchedWindows = [];

    for (const sourceId of browserSourceIds) {
      const expectedTitle = sourceTitles[sourceId]?.title;
      const match = macWindows.find((w) => !matchedWindowIds.has(w.windowId) && w.title.includes(expectedTitle));

      if (match) {
        matchedWindowIds.add(match.windowId);
        resolvedBindings[sourceId] = { macWindowId: match.windowId, pid: chromePid };
      } else {
        unmatchedSources.push(sourceId);
      }
    }

    for (const w of macWindows) {
      if (matchedWindowIds.has(w.windowId)) {
        continue;
      }

      if (w.title.includes('Presenter') || w.title === 'New Tab - Google Chrome' || w.title === '') {
        continue;
      }

      unmatchedWindows.push(w);
    }

    unmatchedWindows.sort((a, b) => a.windowId - b.windowId);
    unmatchedSources.sort((a, b) => browserSourceIds.indexOf(a) - browserSourceIds.indexOf(b));

    for (let i = 0; i < unmatchedSources.length && i < unmatchedWindows.length; i += 1) {
      const sourceId = unmatchedSources[i];
      const macWindow = unmatchedWindows[i];
      resolvedBindings[sourceId] = { macWindowId: macWindow.windowId, pid: chromePid };
    }

    const allResolved = browserSourceIds.every((id) => resolvedBindings[id] !== undefined);
    if (allResolved) {
      break;
    }

    if (attempt < maxAttempts) {
      await delay(retryDelayMs);
    }
  }

  return resolvedBindings;
}

async function closeOwnedAppWindows({
  entries,
  logger,
  closeMacWindowFn,
  closeIterm2OwnedWindowFn = closeIterm2OwnedWindow,
}) {
  for (const entry of entries) {
    const { source, binding } = entry;
    const adapter = resolveAppAdapter(source);

    if (typeof adapter.close === 'function') {
      await Promise.resolve(adapter.close({ source, binding }, { closeIterm2OwnedWindow: closeIterm2OwnedWindowFn }));
      continue;
    }

    if (typeof binding.macWindowId === 'number' && typeof binding.pid === 'number') {
      const discardUnsavedChanges = binding.discardUnsavedChanges
        ?? (adapter.discardUnsavedChangesOnClose === true);
      const closed = closeMacWindowFn(binding.macWindowId, binding.pid, {
        discardUnsavedChanges,
      });

      if (!closed) {
        logger.warn('Owned app window close did not confirm closure; leaving app process running', {
          source: entry.sourceId,
          macWindowId: binding.macWindowId,
          pid: binding.pid,
        });
      }
    }
  }
}

function shouldDiscardUnsavedChanges(source) {
  if (source?.kind !== 'app') {
    return false;
  }

  return resolveAppAdapter(source).discardUnsavedChangesOnClose === true;
}

export {
  buildBootstrapBinding,
  buildObsWindowBindings,
  closeOwnedAppWindows,
  createOwnedWindowResolutionEntries,
  defaultResolveMacWindowBindings,
  defaultResolveOwnedWindowBindings,
  getSourceOwnerName,
  hasBrowserSources,
  isPromiseLike,
  listBrowserSourceIds,
  listOwnedAppSourceEntries,
  resolvePresenterTeleprompterBinding,
  shouldDiscardUnsavedChanges,
  terminateProcessGroup,
};
