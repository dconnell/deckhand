import { resolveAppAdapter } from './apps/index.js';
import { launchAlacrittyWindow } from './launchers/alacritty.js';
import { closeTerminalOwnedWindow, launchTerminalWindow } from './launchers/appleTerminal.js';
import { launchAppWindow } from './launchers/app.js';
import { launchChromeWindowWithUrl } from './launchers/chrome.js';
import { closeGhosttyOwnedWindow, launchGhosttyWindow } from './launchers/ghostty.js';
import { closeIterm2OwnedWindow, launchIterm2Window } from './launchers/iterm2.js';
import { closeKittyOwnedWindow, launchKittyWindow } from './launchers/kitty.js';
import { delay } from './lifecycle/time.js';
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
  launchTerminalWindowFn = launchTerminalWindow,
  launchGhosttyWindowFn = launchGhosttyWindow,
  launchKittyWindowFn = launchKittyWindow,
  launchAlacrittyWindowFn = launchAlacrittyWindow,
  launchChromeWindowWithUrlFn = launchChromeWindowWithUrl,
}) {
  const entries = [];

  for (const [sourceId, source] of listOwnedAppSourceEntries(config)) {
    const adapter = resolveAppAdapter(source);

    entries.push({
      sourceId,
      snapshot: () => enumerateWindowsByOwnerNameFn(adapter.cgWindowOwnerName(source)),
      launch: () => (typeof adapter.launch === 'function'
        ? adapter.launch(source, {
          launchIterm2Window: launchIterm2WindowFn,
          launchTerminalWindow: launchTerminalWindowFn,
          launchGhosttyWindow: launchGhosttyWindowFn,
          launchKittyWindow: launchKittyWindowFn,
          launchAlacrittyWindow: launchAlacrittyWindowFn,
          launchChromeWindowWithUrl: launchChromeWindowWithUrlFn,
          launchAppWindow: launchAppWindowFn,
        })
        : launchAppWindowFn(source.openArgs
          ? { app: source.app, cwd: source.cwd, openArgs: source.openArgs }
          : {
              app: source.app,
              args: adapter.buildLaunchArgs ? adapter.buildLaunchArgs(source) : source.args,
              cwd: source.cwd,
              files: source.files,
            })),
      confirm: adapter.confirm,
      skipDiff: typeof adapter.ownsWindow === 'function' && adapter.ownsWindow(source) === false,
    });
  }

  logger.info('Launching owned app-window sources', { sources: entries.map((entry) => entry.sourceId) });
  return entries;
}

/**
 * Default launch+diff resolver for owned app-window sources.
 *
 * Builds an adapter-driven launch strategy per source and resolves each via
 * the generic owned-window resolver. Sources whose adapter declares
 * `ownsWindow(source) === false` (currently only Slack in navigation mode)
 * are launched but skipped by the diff resolver — they cannot produce a
 * bindable window so polling for one would just emit misleading warnings.
 *
 * @param {{ config: { sources: Record<string, { kind: string, command?: string, cwd?: string, app?: string, args?: string[] }> } }} options Resolver options.
 * @param {{ info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void }} logger Logger.
 * @returns {Promise<Record<string, { macWindowId: number, pid?: number }>>}
 */
async function defaultResolveOwnedWindowBindings({ config, logger }) {
  const entries = createOwnedWindowResolutionEntries({ config, logger });

  const navigationEntries = entries.filter((entry) => entry.skipDiff);
  const diffEntries = entries.filter((entry) => !entry.skipDiff);

  if (navigationEntries.length > 0) {
    logger.info('Launching navigation-only sources without window ownership', {
      sources: navigationEntries.map((entry) => entry.sourceId),
    });

    await Promise.all(navigationEntries.map(async (entry) => {
      try {
        await entry.launch();
      } catch (error) {
        logger.warn('Navigation-only source launch failed', {
          source: entry.sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  }

  return resolveOwnedWindowBindings({
    entries: diffEntries,
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

  const auxWindow = await browserSession.openAuxWindow({
    key: 'presenter-teleprompter',
    title: selector.titleIncludes ?? 'Deckhand Presenter',
    url: `http://${config.presenter.http.host}:${config.presenter.http.port}/presenter/teleprompter.html`,
  });

  if (typeof auxWindow?.macWindowId !== 'number') {
    logger.warn('Failed to resolve presenter teleprompter window binding at launch');
    return null;
  }

  return {
    macWindowId: auxWindow.macWindowId,
    pid: chromePid,
  };
}

/**
 * Seed macOS window bindings for browser sources from the browser-session
 * registry.
 *
 * The registry carries the `macWindowId` each browser source resolved at window
 * creation (by CGWindowID diff, see `browserSession.js`). This copies those
 * resolved ids into the runtime binding cache, which is the single live source
 * of truth that Hammerspoon can later update or invalidate. No title matching,
 * no Accessibility API, no Chrome-specific window-title heuristics.
 *
 * Sources whose registry entry lacks a numeric `macWindowId` (resolution
 * failed, or enumeration was not wired) are omitted so the caller can detect
 * and warn about unresolved sources.
 *
 * @param {{ browserSession?: { getStatus(): { chromePid: number | null }, getRegistry(): { sources: Record<string, { macWindowId?: number | null }> } } | null, browserSourceIds: string[] }} options Seed options.
 * @returns {Record<string, { macWindowId: number, pid?: number }>}
 */
function seedBrowserMacWindowBindings({ browserSession, browserSourceIds }) {
  const chromePid = browserSession?.getStatus().chromePid ?? null;
  const registrySources = browserSession?.getRegistry().sources ?? {};
  const result = {};

  for (const sourceId of browserSourceIds) {
    const macWindowId = registrySources[sourceId]?.macWindowId;

    if (typeof macWindowId === 'number') {
      result[sourceId] = {
        macWindowId,
        ...(Number.isInteger(chromePid) && chromePid > 0 ? { pid: chromePid } : {}),
      };
    }
  }

  return result;
}

async function closeOwnedAppWindows({
  entries,
  logger,
  closeMacWindowFn,
  closeIterm2OwnedWindowFn = closeIterm2OwnedWindow,
  closeTerminalOwnedWindowFn = closeTerminalOwnedWindow,
  closeGhosttyOwnedWindowFn = closeGhosttyOwnedWindow,
  closeKittyOwnedWindowFn = closeKittyOwnedWindow,
}) {
  for (const entry of entries) {
    const { source, binding } = entry;
    const adapter = resolveAppAdapter(source);

    if (typeof adapter.ownsWindow === 'function' && adapter.ownsWindow(source) === false) {
      continue;
    }

    if (typeof adapter.close === 'function') {
      await Promise.resolve(adapter.close({ source, binding }, {
        closeIterm2OwnedWindow: closeIterm2OwnedWindowFn,
        closeTerminalOwnedWindow: closeTerminalOwnedWindowFn,
        closeGhosttyOwnedWindow: closeGhosttyOwnedWindowFn,
        closeKittyOwnedWindow: closeKittyOwnedWindowFn,
      }));
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
  defaultResolveOwnedWindowBindings,
  getSourceOwnerName,
  hasBrowserSources,
  isPromiseLike,
  listBrowserSourceIds,
  listOwnedAppSourceEntries,
  resolvePresenterTeleprompterBinding,
  seedBrowserMacWindowBindings,
  shouldDiscardUnsavedChanges,
  terminateProcessGroup,
};
