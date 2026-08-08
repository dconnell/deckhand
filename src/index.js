import { access } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, ConfigError } from './config.js';
import { createCoordinator } from './coordinator.js';
import { createHub } from './hub.js';
import { createLogger } from './logger.js';
import { createObsClient } from './obsClient.js';
import { createPresentationServer } from './presentationServer.js';
import { createPresenterHttpServer } from './presenterHttp.js';
import { reconcileObsPresentation } from './setupObs.js';
import { loadPresentationConfig } from './presentations.js';
import { parsePresentationCliArgs } from './presentations.js';
import { resolvePresentationPaths } from './presentations.js';
import { buildRuntimeStatus } from './runtimeStatus.js';
import {
  buildBootstrapBinding,
  buildObsWindowBindings,
  closeOwnedAppWindows,
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
} from './appRuntime.js';
import { createCdpClient } from './cdpClient.js';
import { createBrowserSession, createBrowserCommandExecutor } from './browserSession.js';
import { createWsTransport, discoverCdpEndpoint, launchChromeSession } from './chromeLauncher.js';
import { waitForFirstDriverPosition, waitForPresentationObserver } from './lifecycle/waitFor.js';
import { closeMacWindow } from './macWindows.js';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const PRESENTATION_SERVER_HOST = '127.0.0.1';
const PRESENTATION_SERVER_PORT = Number(process.env.PORT ?? 3000);
const PRESENTER_SOURCE_ID = 'Presenter';

function resolveProfileDir(config, presentationName) {
  if (config.chrome?.profileDir !== undefined) {
    return config.chrome.profileDir;
  }

  return path.join(os.tmpdir(), 'deckhand-chrome-profiles', presentationName, randomUUID());
}

function isMainModule(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;
}

/**
 * Load config, compose adapters, and start the coordinator process.
 *
 * @param {{ cwd?: string, presentationName?: string, configPath?: string, consoleLike?: Console, createHubFn?: typeof createHub, createObsClientFn?: typeof createObsClient, createCoordinatorFn?: typeof createCoordinator, createPresenterHttpFn?: typeof createPresenterHttpServer, createPresentationServerFn?: typeof createPresentationServer, createBrowserSessionFn?: typeof createBrowserSession, createBrowserCommandExecutorFn?: typeof createBrowserCommandExecutor, createCdpClientFn?: typeof createCdpClient, launchChromeSessionFn?: typeof launchChromeSession, discoverCdpEndpointFn?: typeof discoverCdpEndpoint, reconcileObsFn?: typeof reconcileObsPresentation, waitForDriverPositionFn?: typeof waitForFirstDriverPosition, waitForPresentationObserverFn?: typeof waitForPresentationObserver, installSignalHandlers?: boolean, presenterAssetsPath?: string, closeMacWindowFn?: typeof closeMacWindow, terminateProcessGroupFn?: typeof terminateProcessGroup }} [options] Startup options.
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
  let coordinator;
  let presenterHttp = null;
  let hub;
  let obs;
  let browserSession = null;
  let chromeLaunch = null;
  let presentationServer = null;
  let phase = 'starting';
  const resolvedMacWindowBindings = {};

  async function stopLaunchedChrome() {
    if (chromeLaunch === null) {
      return;
    }

    const currentLaunch = chromeLaunch;
    chromeLaunch = null;

    try {
      await Promise.resolve(currentLaunch.stop());
    } catch {
      // best-effort cleanup
    }
  }

  async function stopBrowserRuntime() {
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

      for (const [sourceId, source] of Object.entries(config.sources)) {
        if (source.kind !== 'app') {
          continue;
        }

        const cached = resolvedMacWindowBindings[sourceId];
        if (cached?.macWindowId === undefined && cached?.sessionId === undefined && cached?.pid === undefined) {
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
            await closeResult;
          }

          logger.info('Closed owned app window', { source: sourceId });
        } catch (error) {
          logger.warn('Failed to close owned app window', {
            source: sourceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await stopBrowserRuntime();

      const chromePid = chromeLaunch?.chromePid;

      if (typeof chromePid === 'number' && chromePid > 0) {
        try {
          process.kill(-chromePid, 'SIGKILL');
        } catch {
          // process group may have already exited
        }
      }

      try {
        execSync('pkill -9 -f "deckhand-chrome-profiles"', { stdio: 'ignore' });
      } catch {
        // no matching processes
      }

      try {
        execSync('pkill -9 -f "deckhand-profile-"', { stdio: 'ignore' });
      } catch {
        // no matching processes
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
  }

  try {
    hub = (options.createHubFn ?? createHub)({ ...config.hub, logger });
    obs = (options.createObsClientFn ?? createObsClient)({ ...config.obs, logger });

    hub.on('observerWindowBindings', (payload) => {
      for (const source of payload?.cleared ?? []) {
        if (resolvedMacWindowBindings[source] !== undefined) {
          delete resolvedMacWindowBindings[source];
          logger.info('Invalidated cached macWindowId', { source });
        }
      }
    });
    presentationServer = (options.createPresentationServerFn ?? createPresentationServer)({
      cwd,
      host: PRESENTATION_SERVER_HOST,
      logger,
      port: PRESENTATION_SERVER_PORT,
      presentationName,
    });

    let executor = null;

    if (hasBrowserSources(config)) {
      const createCdpClientFn = options.createCdpClientFn ?? createCdpClient;
      const launchChromeSessionFn = options.launchChromeSessionFn ?? launchChromeSession;
      const discoverCdpEndpointFn = options.discoverCdpEndpointFn ?? discoverCdpEndpoint;
      const profileDir = resolveProfileDir(config, presentationName);
      const chromeOptions = config.chrome ?? {};

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
        logger,
      });

      executor = (options.createBrowserCommandExecutorFn ?? createBrowserCommandExecutor)({
        browserSession,
        logger,
      });
    }

    coordinator = (options.createCoordinatorFn ?? createCoordinator)({
      config,
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

        return result;
      },
      getManagedBrowserPid() {
        return browserSession?.getStatus().chromePid ?? null;
      },
      hub,
      executor,
      logger,
      obs,
    });

    if (config.presenter !== null) {
      presenterHttp = (options.createPresenterHttpFn ?? createPresenterHttpServer)({
        assetsRoot: presenterAssetsPath,
        getStatus() {
          return buildRuntimeStatus({
            phase,
            currentPresentationState: coordinator.getCurrentPresentationState(),
            hubAddress: hub.getAddress(),
            hubSnapshot: hub.getSnapshot(),
            browserSessionStatus: browserSession === null
              ? { connected: false, chromePid: null, sources: {} }
              : browserSession.getStatus(),
            obsConnected: typeof obs.isConnected === 'function' ? obs.isConnected() : false,
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

    if (config.presenter !== null) {
      await (options.waitForPresentationObserverFn ?? waitForPresentationObserver)({ hub });
    }

    const browserSourceIds = listBrowserSourceIds(config);
    if (browserSourceIds.length > 0 && config.presenter !== null) {
      const windowResolutionFn = options.resolveMacWindowBindingsFn ?? defaultResolveMacWindowBindings;

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
    const { presentationName } = parsePresentationCliArgs({
      args: process.argv.slice(2),
      options: {},
    });
    exitCode = await run({ presentationName });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  }

  process.exitCode = exitCode;
}
