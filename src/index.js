import { access, rm } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, ConfigError } from './config.js';
import { createCoordinator } from './coordinator.js';
import { createHub } from './hub.js';
import { errorMessage } from './lib/errors.js';
import { createLogger } from './logger.js';
import { createObsClient } from './obsClient.js';
import { createPresentationServer } from './presentationServer.js';
import { createPresenterHttpServer } from './presenterHttp.js';
import { reconcileObsPresentation } from './setupObs.js';
import { loadPresentationConfig } from './presentations.js';
import { parsePresentationCliArgs } from './presentations.js';
import { resolvePresentationPaths } from './presentations.js';
import { buildRuntimeStatus } from './runtimeStatus.js';
import { findBelowMinimumOverlayRects } from './scenes.js';
import { normalizePort } from './net/ports.js';
import { loadResumableSlide, persistSlideId } from './recovery/slideResume.js';
import {
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
} from './appRuntime.js';
import { createCdpClient } from './cdpClient.js';
import { createBrowserSession, createBrowserCommandExecutor } from './browserSession.js';
import { createWsTransport, discoverCdpEndpoint, launchChromeSession } from './chromeLauncher.js';
import { waitForFirstDriverPosition, waitForPresentationObserver } from './lifecycle/waitFor.js';
import { closeMacWindow, enumerateWindowsByOwnerName, getWindowIdsViaCGList } from './macWindows.js';
import { collectOwnedAppInstanceConflicts } from './preflightOwnedApps.js';
import { resolveOwnedWindowBindings } from './ownedWindows.js';
import { runSttObserver } from './presenter/stt/runner.js';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const PRESENTATION_SERVER_HOST = '127.0.0.1';
const PRESENTATION_SERVER_PORT_DEFAULT = 3000;
const PRESENTER_SOURCE_ID = 'Presenter';
const CONSOLE_SOURCE_ID = 'Console';

/**
 * Resolve the Chrome profile directory for this run.
 *
 * When `chrome.profileDir` is configured it is used verbatim and is treated as
 * operator-owned (never cleaned up). Otherwise a unique directory under the OS
 * temp root is generated for this run and flagged as temporary so shutdown can
 * remove it.
 *
 * @param {{ chrome?: null | { profileDir?: string } }} config Normalized config.
 * @param {string} presentationName Presentation name scoping the temp dir.
 * @returns {{ profileDir: string, isTempProfileDir: boolean }} Resolved dir plus whether this run owns it.
 */
function resolveProfileDir(config, presentationName) {
  if (config.chrome?.profileDir !== undefined) {
    return { profileDir: config.chrome.profileDir, isTempProfileDir: false };
  }

  return {
    profileDir: path.join(os.tmpdir(), 'deckhand-chrome-profiles', presentationName, randomUUID()),
    isTempProfileDir: true,
  };
}

function isMainModule(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;
}

/**
 * Relaunch a single owned app source (`open -a`) and re-resolve its macOS
 * window id by diffing CGWindowList around the launch. This is the default
 * implementation of `options.relaunchAppSourceFn`; inject a stub in tests.
 *
 * @param {{ config: Record<string, unknown>, logger: Record<string, unknown>, sourceId: string }} input
 * @returns {Promise<{ macWindowId?: number, pid?: number } | null>}
 */
async function defaultRelaunchAppSource({ config, logger, sourceId }) {
  const entries = createOwnedWindowResolutionEntries({ config, logger });
  const entry = entries.find((candidate) => candidate.sourceId === sourceId);

  if (entry === undefined) {
    return null;
  }

  const result = await resolveOwnedWindowBindings({ entries: [entry], maxAttempts: 30, logger });
  return result[sourceId] ?? null;
}

/**
 * Load config, compose adapters, and start the coordinator process.
 *
 * @param {import('./contracts/runtime.js').RunOptions} [options] Startup options.
 * @returns {Promise<number>}
 */
export async function run(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const presentationName = options.presentationName ?? 'example';
  const presentation = resolvePresentationPaths({ cwd, presentationName });
  const configPath = options.configPath ?? presentation.configPath;
  const consoleLike = options.consoleLike ?? console;
  const installSignalHandlers = options.installSignalHandlers ?? true;
  const presenterAssetsPath = options.presenterAssetsPath ?? path.join(cwd, 'presenter-web');
  const closeMacWindowFn = options.closeMacWindowFn ?? closeMacWindow;
  const terminateProcessGroupFn = options.terminateProcessGroupFn ?? terminateProcessGroup;
  // Injectable kill/reap hooks so tests can stub the SIGKILL and `pkill`
  // side effects and never fire them against the developer's machine.
  const killProcessGroupFn = options.killProcessGroupFn ?? ((pgid) => { process.kill(-pgid, 'SIGKILL'); });
  const reapChromeProfilesFn = options.reapChromeProfilesFn ?? ((command) => { execSync(command, { stdio: 'ignore' }); });
  const shutdownCloseTimeoutMs = options.shutdownCloseTimeoutMs ?? 15000;
  const shutdownStopTimeoutMs = options.shutdownStopTimeoutMs ?? 10000;
  const statePath = presentation.statePath;

  // Read per-run (not at import) so a malformed `PORT` fails this run with a
  // plain message instead of an opaque listen error later.
  let presentationServerPort;

  try {
    presentationServerPort = normalizePort(process.env.PORT, {
      fallback: PRESENTATION_SERVER_PORT_DEFAULT,
      label: 'PORT environment variable',
    });
  } catch (error) {
    consoleLike.error(errorMessage(error));
    return 1;
  }

  try {
    await access(configPath);
  } catch {
    consoleLike.error(`Missing configuration file: ${configPath}. Create presentation/${presentationName}/config.json for this presentation.`);
    return 1;
  }

  let config;

  try {
    if (options.configPath === undefined) {
      config = (await loadPresentationConfig({ cwd, presentationName })).config;
    } else {
      config = await loadConfig({ filePath: configPath });
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      consoleLike.error(`Invalid configuration at ${error.path}: ${error.message}`);
      return 1;
    }

    consoleLike.error(`Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const logger = createLogger(consoleLike);

  // Hard preflight gate: Electron-family owned apps (`open -n` + a fresh app
  // instance) cannot be captured reliably while the operator already has the
  // app open, so refuse to start BEFORE any side effect — no presentation
  // server, hub, OBS reconcile, Chrome, or owned windows.
  if (process.platform === 'darwin') {
    const ownedAppConflicts = collectOwnedAppInstanceConflicts({
      config,
      enumerateWindowsByOwnerNameFn: options.preflightEnumerateWindowsFn ?? enumerateWindowsByOwnerName,
      logger,
    });

    if (ownedAppConflicts.length > 0) {
      const conflictLines = ownedAppConflicts.map((conflict) => {
        if (conflict.match !== null && conflict.windowCount === null) {
          // Probe-scoped conflict (`code --status`): the workspace answer is
          // authoritative but carries no window count to report.
          return `  - ${conflict.sourceId}: "${conflict.app}" already has "${conflict.match}" open`;
        }

        return conflict.match !== null
          ? `  - ${conflict.sourceId}: "${conflict.app}" already has "${conflict.match}" open (${conflict.windowCount} window${conflict.windowCount === 1 ? '' : 's'})`
          : `  - ${conflict.sourceId}: "${conflict.app}" already has ${conflict.windowCount} window(s) open`;
      });
      consoleLike.error([
        'Refusing to start: owned app already running',
        'Deckhand launches its own instance of these apps and cannot reliably capture',
        'windows while they are already open. Quit them completely and start again:',
        ...conflictLines,
      ].join('\n'));
      return 1;
    }
  }
  const resumeSlideEnabled = config.recovery.resumeSlide.enabled && options.noResume !== true;
  const persistSlideIdCallback = resumeSlideEnabled
    ? ({ slideId, index }) => persistSlideId({ statePath, slideId, index, nowMs: Date.now() })
    : null;
  let coordinator;
  let presenterHttp = null;
  let hub;
  let obs;
  let browserSession = null;
  let chromeLaunch = null;
  let presentationServer = null;
  let sttAbortController = null;
  let phase = 'starting';
  const resolvedMacWindowBindings = {};
  // Last-known bindings for windows whose live cache entry was invalidated
  // mid-run (e.g. Hammerspoon reported the window unfindable). Shutdown still
  // needs the stale identity to close windows deckhand itself opened.
  const shutdownWindowBindings = {};
  // Explicit temp-resource registry: every profile directory this run created
  // under the OS temp root is registered here and removed on shutdown or on
  // the startup-failure path. Configured `chrome.profileDir` values are
  // operator-owned and never registered.
  const tempProfileDirs = new Set();

  /**
   * Best-effort removal of every registered temp profile directory. Called
   * only after the Chrome process group has been killed, so no live Chrome
   * can still be writing into them.
   *
   * @returns {Promise<void>}
   */
  async function removeTempProfileDirs() {
    for (const dir of tempProfileDirs) {
      tempProfileDirs.delete(dir);

      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        logger.warn('Failed to remove temp Chrome profile directory', {
          dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function focusPresenterTeleprompter({ reopen = false } = {}) {
    if (config.presenter === null || browserSession === null || config.presenter.teleprompter.window === null) {
      return null;
    }

    const auxWindow = await browserSession.openAuxWindow({
      key: 'presenter-teleprompter',
      title: config.presenter.teleprompter.window.titleIncludes ?? 'Deckhand Presenter',
      url: `http://${config.presenter.http.host}:${config.presenter.http.port}/presenter/teleprompter.html`,
      reopen,
    });
    const chromePid = browserSession.getStatus().chromePid;

    if (typeof auxWindow?.macWindowId === 'number') {
      resolvedMacWindowBindings[PRESENTER_SOURCE_ID] = {
        macWindowId: auxWindow.macWindowId,
        ...(Number.isInteger(chromePid) && chromePid > 0 ? { pid: chromePid } : {}),
      };
    } else {
      delete resolvedMacWindowBindings[PRESENTER_SOURCE_ID];
    }

    if (coordinator !== undefined && coordinator !== null && typeof coordinator.refreshCurrentPresentationState === 'function') {
      await coordinator.refreshCurrentPresentationState(reopen ? 'teleprompterReopened' : 'teleprompterFocused');
    }

    return auxWindow;
  }

  /**
   * Relaunch a single managed source window on operator demand (the presenter
   * console's per-source "relaunch" button). Dispatches by source kind:
   * browser sources are rebuilt inside the Chrome session; app sources are
   * re-launched via `open -a` and re-resolved. After the fresh macWindowId lands
   * the current slide's OBS bindings are re-applied. Relaunch is non-destructive:
   * it does not close the old window first, matching the chosen "relaunch +
   * rebind only" behavior.
   *
   * @param {{ sourceId: string }} input The source id to relaunch.
   * @returns {Promise<{ sourceId: string, macWindowId: number | null }>}
   */
  async function relaunchSource({ sourceId }) {
    const source = config.sources[sourceId];

    if (source === undefined) {
      throw new Error(`unknown source: ${sourceId}`);
    }

    if (source.kind === 'browser') {
      if (browserSession === null) {
        throw new Error('browser session is not started');
      }

      const result = await browserSession.relaunchBrowserSource(sourceId);
      resolvedMacWindowBindings[sourceId] = {
        macWindowId: result.macWindowId,
        pid: browserSession.getStatus().chromePid ?? undefined,
      };
    } else if (source.kind === 'app') {
      const relaunchAppSource = options.relaunchAppSourceFn ?? defaultRelaunchAppSource;
      const result = await relaunchAppSource({ config, logger, sourceId });

      if (result?.macWindowId === undefined) {
        // The launch may have succeeded but the window could not be resolved.
        // Drop any stale binding: it points at the closed window and would
        // misdirect both the OBS capture binding and the shutdown close.
        // Only stash a live binding: when the observer `cleared` event already
        // stashed the last-known binding, assigning undefined here would
        // clobber it and shutdown would leak the still-open original window.
        if (resolvedMacWindowBindings[sourceId] !== undefined) {
          shutdownWindowBindings[sourceId] = resolvedMacWindowBindings[sourceId];
        }
        delete resolvedMacWindowBindings[sourceId];
        logger.warn('Relaunched app source window could not be resolved; cleared stale binding', { sourceId });
      } else {
        // The fresh resolution is authoritative. Adapter identity fields
        // (sessionId for iTerm2, terminalWindowId for Terminal.app) must
        // replace — not merge with — the old ones, or shutdown would close
        // the dead pre-relaunch session and leak the new window.
        resolvedMacWindowBindings[sourceId] = { ...result };
      }
    } else {
      throw new Error(`source ${sourceId} (kind ${source.kind}) cannot be relaunched`);
    }

    if (coordinator && typeof coordinator.reapplyCurrentSlide === 'function') {
      await coordinator.reapplyCurrentSlide('sourceRelaunched');
    }

    const binding = resolvedMacWindowBindings[sourceId] ?? null;
    const macWindowId = binding?.macWindowId ?? null;
    logger.info('Relaunched source window', { sourceId, macWindowId });

    return { sourceId, macWindowId, binding };
  }

  async function stopLaunchedChrome() {
    if (chromeLaunch === null) {
      return;
    }

    const currentLaunch = chromeLaunch;
    chromeLaunch = null;

    try {
      const stopPromise = Promise.resolve(currentLaunch.stop());
      // A stop that rejects after the timeout wins the race must not surface
      // as an unhandled rejection.
      stopPromise.catch(() => {});

      let timedOut = false;
      let timer = null;
      try {
        await Promise.race([
          stopPromise,
          new Promise((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve(undefined);
            }, shutdownStopTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }

      if (timedOut) {
        logger.warn('Timed out stopping launched Chrome; continuing shutdown', { timeoutMs: shutdownStopTimeoutMs });
      }
    } catch {
      // best-effort cleanup
    }
  }

  async function stopBrowserRuntime() {
    sttAbortController?.abort();
    sttAbortController = null;

    if (coordinator === undefined || coordinator === null || typeof coordinator.stop !== 'function') {
      return;
    }

    try {
      await Promise.resolve(coordinator.stop());
    } catch {
      // best-effort cleanup
    }
  }

  function installShutdownHandlers() {
    if (!installSignalHandlers) {
      return;
    }

    const closeOwnedWindowsFn = options.closeOwnedWindowsFn ?? (async ({ bindings }) => {
      await closeOwnedAppWindows({
        entries: bindings.map((binding) => ({
          sourceId: binding.sourceId,
          source: config.sources[binding.sourceId],
          binding,
        })),
        logger,
        closeMacWindowFn,
      });
    });

    let shuttingDown = false;

    const shutdown = async (signal) => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      phase = 'shuttingDown';
      logger.info('Received shutdown signal', { signal });

      // Why window closing runs LAST: closing an owned app window can kill
      // deckhand's own host process — deckhand often runs inside a VS Code
      // integrated terminal that is itself an owned app window. Once that
      // window closes, this process can die mid-teardown, so everything else
      // (coordinator stop with its OBS studio-mode restore, the Chrome kill)
      // must complete BEFORE any window is touched. The later steps read
      // nothing from the window state, so closing windows first was never a
      // dependency — only a hazard.

      const stopPromise = Promise.resolve(stopBrowserRuntime());
      // A stop that rejects after the timeout wins the race must not surface
      // as an unhandled rejection.
      stopPromise.catch(() => {});

      let stopTimedOut = false;
      let stopTimer = null;
      try {
        await Promise.race([
          stopPromise,
          new Promise((resolve) => {
            stopTimer = setTimeout(() => {
              stopTimedOut = true;
              resolve(undefined);
            }, shutdownStopTimeoutMs);
          }),
        ]);
      } finally {
        // A stop that settles before the timeout must not leak the pending
        // timer into the rest of shutdown.
        clearTimeout(stopTimer);
      }

      if (stopTimedOut) {
        logger.warn('Timed out stopping coordinator/browser runtime; continuing shutdown', { timeoutMs: shutdownStopTimeoutMs });
      }

      const chromePid = chromeLaunch?.chromePid;

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

      // Windows last (see the why-comment at the top of this handler): a
      // close that kills the host terminal must not be able to preempt the
      // OBS restore or the Chrome kill above.
      for (const [sourceId, source] of Object.entries(config.sources)) {
        if (source.kind !== 'app') {
          continue;
        }

        const cached = resolvedMacWindowBindings[sourceId] ?? shutdownWindowBindings[sourceId];
        if (cached?.macWindowId === undefined && cached?.sessionId === undefined && cached?.pid === undefined) {
          logger.warn('No window binding available for owned app source; leaving its window open', { source: sourceId });
          continue;
        }

        try {
          const closeResult = closeOwnedWindowsFn({
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
            let timedOut = false;
            let timer = null;
            try {
              await Promise.race([
                closeResult,
                new Promise((resolve) => {
                  timer = setTimeout(() => {
                    timedOut = true;
                    resolve(undefined);
                  }, shutdownCloseTimeoutMs);
                }),
              ]);
            } finally {
              // A close that rejects before the timeout must not leak the
              // pending timer into the rest of shutdown.
              clearTimeout(timer);
            }

            if (timedOut) {
              logger.warn('Timed out closing owned app window; continuing shutdown', { source: sourceId, timeoutMs: shutdownCloseTimeoutMs });
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
    };

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

    bindShutdownSignal('SIGINT');
    bindShutdownSignal('SIGTERM');
    // SIGHUP: the host terminal died (e.g. its window was closed) — run the
    // same teardown flow. The `shuttingDown` flag at the top of `shutdown`
    // keeps this idempotent when several signals arrive during one teardown.
    bindShutdownSignal('SIGHUP');
  }

  try {
    hub = (options.createHubFn ?? createHub)({ ...config.hub, logger });
    obs = (options.createObsClientFn ?? createObsClient)({
      ...config.obs,
      logger,
      reconnect: config.recovery.obsReconnect,
    });

    hub.on('observerWindowBindings', (payload) => {
      for (const source of payload?.cleared ?? []) {
        if (resolvedMacWindowBindings[source] !== undefined) {
          shutdownWindowBindings[source] = resolvedMacWindowBindings[source];
          delete resolvedMacWindowBindings[source];
          logger.info('Invalidated cached macWindowId', { source });
        }
      }
    });
    presentationServer = (options.createPresentationServerFn ?? createPresentationServer)({
      cwd,
      host: PRESENTATION_SERVER_HOST,
      logger,
      port: presentationServerPort,
      presentationName,
    });

    let executor = null;

    if (hasBrowserSources(config)) {
      const createCdpClientFn = options.createCdpClientFn ?? createCdpClient;
      const launchChromeSessionFn = options.launchChromeSessionFn ?? launchChromeSession;
      const discoverCdpEndpointFn = options.discoverCdpEndpointFn ?? discoverCdpEndpoint;
      const { profileDir, isTempProfileDir } = resolveProfileDir(config, presentationName);
      const chromeOptions = config.chrome ?? {};

      if (isTempProfileDir) {
        tempProfileDirs.add(profileDir);
      }

      const ensureLaunched = async () => {
        if (chromeLaunch !== null) {
          return chromeLaunch;
        }

        chromeLaunch = await launchChromeSessionFn({
          executablePath: chromeOptions.executablePath,
          profileDir,
          profileName: chromeOptions.profileName,
          debugPort: chromeOptions.debugPort,
          extraArgs: chromeOptions.extraArgs,
          logger,
        });

        // A named-profile launch always runs from a fresh mkdtemp working
        // copy (see chromeLauncher.prepareProfileDir), so the launch result's
        // profileDir is temporary even when the configured parent dir is not.
        if (chromeLaunch.profileName !== null && typeof chromeLaunch.profileDir === 'string') {
          tempProfileDirs.add(chromeLaunch.profileDir);
        }

        return chromeLaunch;
      };

      const cdpClient = createCdpClientFn({
        discover: async () => {
          const info = await ensureLaunched();
          const discovered = await discoverCdpEndpointFn({ debugPort: info.debugPort, profileDir: info.profileDir, logger });
          return { webSocketDebuggerUrl: discovered.webSocketDebuggerUrl, chromePid: info.chromePid };
        },
        createTransport: (url) => createWsTransport({ url }),
        logger,
      });

      browserSession = (options.createBrowserSessionFn ?? createBrowserSession)({
        sources: config.sources,
        createCdpClient: () => cdpClient,
        enumerateWindowIdsByPidFn: options.enumerateWindowIdsByPidFn ?? getWindowIdsViaCGList,
        recovery: config.recovery,
        logger,
      });

      // When the CDP transport drops, the browser session recovers by
      // reconnecting Chrome. A Chrome-process death leaves `chromeLaunch`
      // pointing at a stale PID, so `ensureLaunched` would short-circuit and
      // never respawn. Clear the handle (and best-effort reap the old process
      // group) on transport loss so the next discover relaunches Chrome.
      if (typeof browserSession.on === 'function') {
        browserSession.on('transportLost', () => {
          const stalePid = chromeLaunch?.chromePid;

          chromeLaunch = null;

          if (typeof stalePid === 'number' && stalePid > 0) {
            try {
              killProcessGroupFn(stalePid);
            } catch {
              // process group may have already exited
            }
          }

          logger.warn('Browser transport lost; cleared Chrome launch handle for relaunch on recovery');
        });
      }

      executor = (options.createBrowserCommandExecutorFn ?? createBrowserCommandExecutor)({
        browserSession,
        logger,
      });
    }

    coordinator = (options.createCoordinatorFn ?? createCoordinator)({
      config,
      focusPresenterTeleprompter,
      relaunchSource,
      getManagedWindowBindings() {
        if (config.presenter === null) {
          return {};
        }

        const chromePid = browserSession?.getStatus().chromePid ?? null;
        const registrySources = browserSession?.getRegistry().sources ?? {};
        const result = {};

        for (const [sourceId, source] of Object.entries(config.sources)) {
          const configured = config.presenter.windows?.[sourceId];
          const cached = resolvedMacWindowBindings[sourceId];
          const binding = {};

          if (source.kind === 'browser') {
            binding.app = configured?.app ?? getSourceOwnerName(config, sourceId);
            binding.titleIncludes = registrySources[sourceId]?.title;
            if (typeof chromePid === 'number') {
              binding.pid = chromePid;
            }
          } else {
            Object.assign(binding, buildBootstrapBinding(source, configured));
            if (typeof cached?.pid === 'number') {
              binding.pid = cached.pid;
            }
          }

          if (cached?.macWindowId !== undefined) {
            binding.macWindowId = cached.macWindowId;
          }

          result[sourceId] = binding;
        }

        if (config.presenter.teleprompter.window !== null) {
          result[PRESENTER_SOURCE_ID] = {
            ...config.presenter.teleprompter.window,
          };

          const cached = resolvedMacWindowBindings[PRESENTER_SOURCE_ID];
          if (typeof chromePid === 'number') {
            result[PRESENTER_SOURCE_ID].pid = chromePid;
          }
          if (cached?.pid !== undefined) {
            result[PRESENTER_SOURCE_ID].pid = cached.pid;
          }
          if (cached?.macWindowId !== undefined) {
            result[PRESENTER_SOURCE_ID].macWindowId = cached.macWindowId;
          }
        }

        // Unlike the teleprompter there is no config selector gate: the Console
        // window only exists when deckhand opened it, which is exactly when the
        // cached binding exists.
        const consoleCached = resolvedMacWindowBindings[CONSOLE_SOURCE_ID];
        if (consoleCached !== undefined) {
          result[CONSOLE_SOURCE_ID] = {
            app: getSourceOwnerName(config, CONSOLE_SOURCE_ID),
            titleIncludes: 'Deckhand Console',
          };

          if (typeof chromePid === 'number') {
            result[CONSOLE_SOURCE_ID].pid = chromePid;
          }
          if (consoleCached.pid !== undefined) {
            result[CONSOLE_SOURCE_ID].pid = consoleCached.pid;
          }

          result[CONSOLE_SOURCE_ID].macWindowId = consoleCached.macWindowId;
        }

        return result;
      },
      getManagedBrowserPid() {
        return browserSession?.getStatus().chromePid ?? null;
      },
      hub,
      executor,
      logger,
      obs,
      browserSession,
      persistSlideId: persistSlideIdCallback,
    });

    if (config.presenter !== null) {
      presenterHttp = (options.createPresenterHttpFn ?? createPresenterHttpServer)({
        assetsRoot: presenterAssetsPath,
        getProgramPreview() {
          return typeof coordinator.getProgramPreviewSnapshot === 'function'
            ? coordinator.getProgramPreviewSnapshot()
            : null;
        },
        getStatus() {
          return buildRuntimeStatus({
            phase,
            sourceCatalog: Object.values(config.sources).map((source) => ({
              id: source.id,
              kind: source.kind,
            })),
            currentPresentationState: coordinator.getCurrentPresentationState(),
            currentPresenterState: typeof coordinator.getCurrentPresenterState === 'function'
              ? coordinator.getCurrentPresenterState()
              : null,
            hubAddress: hub.getAddress(),
            hubSnapshot: hub.getSnapshot(),
            browserSessionStatus: browserSession === null
              ? { connected: false, chromePid: null, sources: {} }
              : browserSession.getStatus(),
            obsConnected: typeof obs.isConnected === 'function' ? obs.isConnected() : false,
            obsReconnecting: typeof obs.isReconnecting === 'function' ? obs.isReconnecting() : false,
            presenterEnabled: true,
          });
        },
        host: config.presenter.http.host,
        logger,
        presenterBootstrap: {
          followEnabledByDefault: config.presenter.teleprompter.followEnabledByDefault,
          hubUrl: `ws://${config.hub.host}:${config.hub.port}`,
        },
        port: config.presenter.http.port,
      });
    }
  } catch (error) {
    consoleLike.error(`Failed to build application dependencies: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  installShutdownHandlers();

  try {
    await presentationServer.start();
    await coordinator.start();

    if (config.presenter !== null && config.presenter.stt !== null) {
      sttAbortController = new AbortController();
      const runSttObserverFn = options.runSttObserverFn ?? runSttObserver;
      runSttObserverFn({
        hubUrl: `ws://${config.hub.host}:${config.hub.port}`,
        logger,
        restartDelayMs: 1000,
        signal: sttAbortController.signal,
        stt: config.presenter.stt,
      }).catch((error) => {
        logger.warn('STT observer exited', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      logger.info('Auto-started presenter STT observer');
    }

    if (presenterHttp !== null) {
      await presenterHttp.start();

      if (browserSession !== null) {
        const resolvePresenterTeleprompterBindingFn = options.resolvePresenterTeleprompterBindingFn ?? resolvePresenterTeleprompterBinding;

        await resolvePresenterTeleprompterBindingFn({
          browserSession,
          config,
          logger,
        }).then((binding) => {
          if (binding !== null) {
            resolvedMacWindowBindings[PRESENTER_SOURCE_ID] = binding;
          }
        }).catch((error) => {
          logger.warn('Failed to open presenter window', {
            error: error instanceof Error ? error.message : String(error),
          });
        });

        // Warn-only probe: Chrome silently clamps Deckhand-owned overlay
        // windows to its enforced minimum, so a configured rect below that
        // minimum can never be honored. This runs before the console-open
        // refresh below, i.e. before any presentation-state publish, so the
        // warning precedes Hammerspoon's first positioning pass and the
        // probed window is immediately repositioned by that first apply.
        // Must never fail startup: measureMinimumWindowSize returns null
        // instead of throwing.
        const chromeMinimum = await browserSession.measureMinimumWindowSize();

        if (chromeMinimum !== null) {
          for (const finding of findBelowMinimumOverlayRects(config, chromeMinimum)) {
            logger.warn('Configured overlay rect is below Chrome minimum window size', {
              source: finding.source,
              origin: finding.origin,
              rect: finding.rect,
              minimum: chromeMinimum,
            });
          }
        }

        try {
          const auxWindow = await browserSession.openAuxWindow({
            key: 'presenter-console',
            title: 'Deckhand Console',
            url: `http://${config.presenter.http.host}:${config.presenter.http.port}/presenter/`,
          });
          const chromePid = browserSession.getStatus().chromePid;

          if (typeof auxWindow?.macWindowId === 'number') {
            resolvedMacWindowBindings[CONSOLE_SOURCE_ID] = {
              macWindowId: auxWindow.macWindowId,
              ...(Number.isInteger(chromePid) && chromePid > 0 ? { pid: chromePid } : {}),
            };
          } else {
            delete resolvedMacWindowBindings[CONSOLE_SOURCE_ID];
          }

          // The window is already open at this point, so a refresh failure must
          // not be reported as a failure to open it. Binding registration above
          // cannot throw, so this catch only sees the refresh.
          try {
            if (coordinator !== undefined && coordinator !== null && typeof coordinator.refreshCurrentPresentationState === 'function') {
              await coordinator.refreshCurrentPresentationState('consoleOpened');
            }
          } catch (error) {
            logger.warn('Failed to refresh presentation state after console open', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } catch (error) {
          logger.warn('Failed to open presenter console window', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const bootstrapWindowBindings = browserSession === null
      ? {}
      : Object.fromEntries(
          Object.entries(config.sources)
            .filter(([, source]) => source.kind === 'browser')
            .map(([sourceId]) => [sourceId, { pid: browserSession.getStatus().chromePid }]),
        );

    await (options.reconcileObsFn ?? reconcileObsPresentation)({
      config,
      logger,
      obs: typeof obs.getClient === 'function' ? obs.getClient() : obs,
      windowBindings: bootstrapWindowBindings,
    });

    await (options.waitForDriverPositionFn ?? waitForFirstDriverPosition)({
      coordinator,
      hub,
      presentationName,
    });

    // Resume-from-slide: if a prior run persisted a slide id for this
    // presentation and the deck did not already report it on registration,
    // drive the deck back to that slide so a mid-talk restart needs no manual
    // navigation. The deck's resulting positionChanged flows through the
    // coordinator normally and rebuilds OBS/browser state for the slide.
    if (resumeSlideEnabled) {
      const resumePoint = await (options.loadResumableSlideFn ?? loadResumableSlide)({ statePath });
      const currentSlideId = coordinator.getCurrentPresentationState()?.slideId ?? null;

      if (resumePoint !== null && resumePoint.slideId !== currentSlideId) {
        logger.info('Resuming deck at persisted slide', {
          slideId: resumePoint.slideId,
          currentSlideId,
        });

        try {
          await hub.sendCommand({ role: 'driver' }, { type: 'goTo', id: resumePoint.slideId });
        } catch (error) {
          logger.warn('Failed to resume deck at persisted slide', {
            error: error instanceof Error ? error.message : String(error),
            slideId: resumePoint.slideId,
          });
        }
      }
    }

    if (config.presenter !== null) {
      await (options.waitForPresentationObserverFn ?? waitForPresentationObserver)({ hub });
    }

    const browserSourceIds = listBrowserSourceIds(config);
    if (browserSourceIds.length > 0 && config.presenter !== null) {
      const windowResolutionFn = options.resolveMacWindowBindingsFn ?? seedBrowserMacWindowBindings;

      const result = (await windowResolutionFn({
        browserSession,
        browserSourceIds,
        config,
        logger,
      })) ?? {};

      for (const [sourceId, binding] of Object.entries(result)) {
        resolvedMacWindowBindings[sourceId] = binding;
      }

      const allResolved = browserSourceIds.every((id) => result[id] !== undefined);
      if (allResolved) {
        logger.info('Resolved browser window bindings', {
          sources: Object.keys(result),
        });
      } else {
        logger.warn('Not all browser sources resolved; OBS may show blank captures for missing sources', {
          resolved: Object.keys(result),
          missing: browserSourceIds.filter((id) => !result[id]),
        });
      }

      await (options.reconcileObsFn ?? reconcileObsPresentation)({
        config,
        logger,
        obs: typeof obs.getClient === 'function' ? obs.getClient() : obs,
        windowBindings: buildObsWindowBindings(config, resolvedMacWindowBindings),
      });
    }

    const ownedEntries = listOwnedAppSourceEntries(config);
    if (ownedEntries.length > 0 && config.presenter !== null) {
      const ownedResolutionFn = options.resolveOwnedWindowBindingsFn ?? defaultResolveOwnedWindowBindings;

      const ownedResult = (await ownedResolutionFn({ config, logger })) ?? {};

      for (const [sourceId, binding] of Object.entries(ownedResult)) {
        resolvedMacWindowBindings[sourceId] = binding;
      }

      const resolvedOwnedIds = Object.keys(ownedResult);
      if (resolvedOwnedIds.length > 0) {
        logger.info('Resolved owned app-window bindings', { sources: resolvedOwnedIds });
      }

      const missingOwned = ownedEntries.map(([id]) => id).filter((id) => ownedResult[id] === undefined);
      if (missingOwned.length > 0) {
        logger.warn('Not all owned app sources resolved; OBS may show blank captures for missing sources', {
          resolved: resolvedOwnedIds,
          missing: missingOwned,
        });
      }

      if (resolvedOwnedIds.length > 0) {
        await (options.reconcileObsFn ?? reconcileObsPresentation)({
          config,
          logger,
          obs: typeof obs.getClient === 'function' ? obs.getClient() : obs,
          windowBindings: buildObsWindowBindings(config, resolvedMacWindowBindings),
        });
      }
    }

    phase = 'ready';
  } catch (error) {
    phase = 'failed';
    consoleLike.error(`Coordinator failed to start: ${error instanceof Error ? error.message : String(error)}`);

    if (presenterHttp !== null && typeof presenterHttp.stop === 'function') {
      try {
        await Promise.resolve(presenterHttp.stop());
      } catch {
        // best-effort cleanup
      }
    }

    await stopBrowserRuntime();
    await stopLaunchedChrome();
    await removeTempProfileDirs();

    if (presentationServer !== null && typeof presentationServer.stop === 'function') {
      try {
        await Promise.resolve(presentationServer.stop());
      } catch {
        // best-effort cleanup
      }
    }

    return 1;
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  let exitCode;

  try {
    const { presentationName, values } = parsePresentationCliArgs({
      args: process.argv.slice(2),
      options: {
        'no-resume': { type: 'boolean', default: false },
      },
    });
    exitCode = await run({ presentationName, noResume: values['no-resume'] === true });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  }

  process.exitCode = exitCode;
}
