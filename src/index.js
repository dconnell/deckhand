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
  buildObsWindowBindings,
  defaultResolveOwnedWindowBindings,
  hasBrowserSources,
  listBrowserSourceIds,
  listOwnedAppSourceEntries,
  resolvePresenterTeleprompterBinding,
  seedBrowserMacWindowBindings,
} from './appRuntime.js';
import { createCdpClient } from './cdpClient.js';
import { createBrowserSession, createBrowserCommandExecutor } from './browserSession.js';
import { createWsTransport, discoverCdpEndpoint, launchChromeSession } from './chromeLauncher.js';
import { waitForFirstDriverPosition, waitForPresentationObserver } from './lifecycle/waitFor.js';
import { closeMacWindow, enumerateWindowsByOwnerName, getWindowIdsViaCGList } from './macWindows.js';
import { collectOwnedAppInstanceConflicts } from './preflightOwnedApps.js';
import { runSttObserver } from './presenter/stt/runner.js';
import { buildManagedWindowBindings, createWindowBindingRegistry } from './runtime/windowBindingRegistry.js';
import { createPresenterWindowBootstrap } from './runtime/presenterWindows.js';
import { createShutdownSequence, stopLaunchedChromeSession } from './runtime/shutdownSequence.js';
import { createSourceRelauncher } from './runtime/sourceRelaunch.js';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const PRESENTATION_SERVER_HOST = '127.0.0.1';
const PRESENTATION_SERVER_PORT_DEFAULT = 3000;

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
 * Load config, compose adapters, and start the coordinator process.
 *
 * `run()` is the runtime composition layer: it wires dependencies, drives the
 * startup sequence, and returns an exit code. The mutable state it used to own
 * inline lives with explicit owners now:
 *
 * 1. `createWindowBindingRegistry()` — live managed-window bindings plus the
 *    stale bindings stashed for shutdown (`src/runtime/windowBindingRegistry.js`);
 * 2. `createPresenterWindowBootstrap()` — teleprompter focus/reopen and the
 *    presenter console window bootstrap (`src/runtime/presenterWindows.js`);
 * 3. `createShutdownSequence()` — ordered signal teardown and its timeout
 *    policy (`src/runtime/shutdownSequence.js`);
 * 4. `createSourceRelauncher()` — per-source window relaunch and rebinding
 *    (`src/runtime/sourceRelaunch.js`).
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

  const registry = createWindowBindingRegistry();
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

  const presenterWindows = createPresenterWindowBootstrap({
    config,
    logger,
    registry,
    getBrowserSession: () => browserSession,
    getCoordinator: () => coordinator,
  });

  const relaunchSource = createSourceRelauncher({
    config,
    logger,
    registry,
    getBrowserSession: () => browserSession,
    getCoordinator: () => coordinator,
    relaunchAppSourceFn: options.relaunchAppSourceFn,
  });

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

  async function stopLaunchedChrome() {
    const currentLaunch = chromeLaunch;
    chromeLaunch = null;

    await stopLaunchedChromeSession({ launch: currentLaunch, timeoutMs: shutdownStopTimeoutMs, logger });
  }

  const shutdownSequence = createShutdownSequence({
    config,
    logger,
    registry,
    installSignalHandlers,
    stopTimeoutMs: shutdownStopTimeoutMs,
    closeTimeoutMs: shutdownCloseTimeoutMs,
    closeMacWindowFn,
    closeOwnedWindowsFn: options.closeOwnedWindowsFn,
    killProcessGroupFn,
    reapChromeProfilesFn,
    stopRuntime: stopBrowserRuntime,
    getChromePid: () => chromeLaunch?.chromePid,
    removeTempProfileDirs,
    onShutdownStart: () => {
      phase = 'shuttingDown';
    },
  });

  try {
    hub = (options.createHubFn ?? createHub)({ ...config.hub, logger });
    obs = (options.createObsClientFn ?? createObsClient)({
      ...config.obs,
      logger,
      reconnect: config.recovery.obsReconnect,
    });

    hub.on('observerWindowBindings', (payload) => {
      for (const source of payload?.cleared ?? []) {
        if (registry.stashForShutdown(source)) {
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
      focusPresenterTeleprompter: presenterWindows.focusTeleprompter,
      relaunchSource,
      getManagedWindowBindings() {
        return buildManagedWindowBindings({ config, registry, browserSession });
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

  shutdownSequence.install();

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
        await presenterWindows.resolveStartupTeleprompterBinding({
          resolveFn: options.resolvePresenterTeleprompterBindingFn ?? resolvePresenterTeleprompterBinding,
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

        await presenterWindows.openConsoleWindow();
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

      registry.setMany(result);

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
        windowBindings: buildObsWindowBindings(config, registry.snapshot()),
      });
    }

    const ownedEntries = listOwnedAppSourceEntries(config);
    if (ownedEntries.length > 0 && config.presenter !== null) {
      const ownedResolutionFn = options.resolveOwnedWindowBindingsFn ?? defaultResolveOwnedWindowBindings;

      const ownedResult = (await ownedResolutionFn({ config, logger })) ?? {};

      registry.setMany(ownedResult);

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
          windowBindings: buildObsWindowBindings(config, registry.snapshot()),
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
