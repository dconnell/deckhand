import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, ConfigError } from './config.js';
import { createCoordinator } from './coordinator.js';
import { createHotkeyAdapter } from './hotkeys.js';
import { createHub } from './hub.js';
import { createObsClient } from './obsClient.js';
import { createPresentationServer } from './presentationServer.js';
import { createPresenterHttpServer } from './presenterHttp.js';
import { loadPresentationConfig } from './presentations.js';
import { parsePresentationCliArgs } from './presentations.js';
import { resolvePresentationPaths } from './presentations.js';
import { buildRuntimeStatus } from './runtimeStatus.js';
import { createCdpClient } from './cdpClient.js';
import { createBrowserSession, createBrowserCommandExecutor } from './browserSession.js';
import { createWsTransport, discoverCdpEndpoint, launchChromeSession } from './chromeLauncher.js';
import os from 'node:os';

const PRESENTATION_SERVER_HOST = '127.0.0.1';
const PRESENTATION_SERVER_PORT = Number(process.env.PORT ?? 3000);
const DRIVER_READY_TIMEOUT_MS = 10000;
const PRESENTER_OBSERVER_TIMEOUT_MS = 5000;

function hasBrowserSources(config) {
  return Object.values(config.sources).some((source) => source?.kind === 'browser');
}

function resolveProfileDir(config, presentationName) {
  if (config.chrome?.profileDir !== undefined) {
    return config.chrome.profileDir;
  }

  return path.join(os.tmpdir(), 'deckhand-chrome-profiles', presentationName);
}

function hasPresentationObserver(hubSnapshot) {
  return hubSnapshot.observers.some((observer) => Array.isArray(observer.subscriptions) && observer.subscriptions.includes('presentationState'));
}

function waitForEvent(timeoutMs, timeoutMessage, register) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    register((payload) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function waitForFirstDriverPosition({ coordinator, hub, timeoutMs = DRIVER_READY_TIMEOUT_MS, presentationName }) {
  if (coordinator.getCurrentPresentationState() !== null) {
    return;
  }

  await waitForEvent(
    timeoutMs,
    `Timed out waiting for the first driver position for presentation ${presentationName}. Open the deck and confirm the driver connects.`,
    (resolve) => {
      hub.on('driverPositionChanged', resolve);
    },
  );
}

async function waitForPresentationObserver({ hub, timeoutMs = PRESENTER_OBSERVER_TIMEOUT_MS }) {
  if (hasPresentationObserver(hub.getSnapshot())) {
    return;
  }

  await waitForEvent(
    timeoutMs,
    'Timed out waiting for a presenter observer. Check Hammerspoon, reload its config, and confirm Accessibility permission.',
    (resolve) => {
      hub.on('observerRegistered', (observer) => {
        if (Array.isArray(observer.subscriptions) && observer.subscriptions.includes('presentationState')) {
          resolve(observer);
        }
      });
    },
  );
}

function sanitizeContext(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeContext(entry));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, key.toLowerCase().includes('password') ? '[redacted]' : sanitizeContext(entry)]),
    );
  }

  return value;
}

function createLogger(consoleLike) {
  function write(method, message, context) {
    const parts = [`[deckhand] ${message}`];

    if (context !== undefined) {
      parts.push(JSON.stringify(sanitizeContext(context)));
    }

    consoleLike[method](parts.join(' '));
  }

  return {
    error(message, context) {
      write('error', message, context);
    },
    info(message, context) {
      write('info', message, context);
    },
    warn(message, context) {
      write('warn', message, context);
    },
  };
}

function isMainModule(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;
}

/**
 * Load config, compose adapters, and start the coordinator process.
 *
 * @param {{ cwd?: string, presentationName?: string, configPath?: string, consoleLike?: Console, createHubFn?: typeof createHub, createObsClientFn?: typeof createObsClient, createHotkeysFn?: typeof createHotkeyAdapter, createCoordinatorFn?: typeof createCoordinator, createPresenterHttpFn?: typeof createPresenterHttpServer, createPresentationServerFn?: typeof createPresentationServer, createBrowserSessionFn?: typeof createBrowserSession, createBrowserCommandExecutorFn?: typeof createBrowserCommandExecutor, createCdpClientFn?: typeof createCdpClient, launchChromeSessionFn?: typeof launchChromeSession, discoverCdpEndpointFn?: typeof discoverCdpEndpoint, waitForDriverPositionFn?: typeof waitForFirstDriverPosition, waitForPresentationObserverFn?: typeof waitForPresentationObserver, installSignalHandlers?: boolean, presenterAssetsPath?: string }} [options] Startup options.
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

  async function stopLaunchedChrome() {
    if (chromeLaunch === null) {
      return;
    }

    const currentLaunch = chromeLaunch;
    chromeLaunch = null;
    await currentLaunch.stop().catch(() => {});
  }

  try {
    hub = (options.createHubFn ?? createHub)({ ...config.hub, logger });
    obs = (options.createObsClientFn ?? createObsClient)({ ...config.obs, logger });
    const hotkeys = (options.createHotkeysFn ?? createHotkeyAdapter)({ ...config.hotkeys, logger });
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
          debugPort: chromeOptions.debugPort,
          extraArgs: chromeOptions.extraArgs,
          logger,
        });
        return chromeLaunch;
      };

      const cdpClient = createCdpClientFn({
        discover: async () => {
          const info = await ensureLaunched();
          const discovered = await discoverCdpEndpointFn({ debugPort: info.debugPort, logger });
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
      hub,
      hotkeys,
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

  try {
    await presentationServer.start();
    await coordinator.start({ enableHotkeys: false });

    if (presenterHttp !== null) {
      await presenterHttp.start();
    }

    await (options.waitForDriverPositionFn ?? waitForFirstDriverPosition)({
      coordinator,
      hub,
      presentationName,
    });

    if (config.presenter !== null) {
      await (options.waitForPresentationObserverFn ?? waitForPresentationObserver)({ hub });
    }

    if (typeof coordinator.enableHotkeys === 'function') {
      await coordinator.enableHotkeys();
    }

    phase = 'ready';
  } catch (error) {
    phase = 'failed';
    consoleLike.error(`Coordinator failed to start: ${error instanceof Error ? error.message : String(error)}`);
    await presenterHttp?.stop().catch(() => {});
    await coordinator.stop().catch(() => {});
    await stopLaunchedChrome();
    await presentationServer?.stop().catch(() => {});
    return 1;
  }

  if (installSignalHandlers) {
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      phase = 'shuttingDown';
      logger.info('Received shutdown signal', { signal });

      try {
        await presenterHttp?.stop();
        await coordinator.stop();
        await stopLaunchedChrome();
        await presentationServer?.stop();
      } catch (error) {
        logger.error('Coordinator shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exitCode = 1;
      }
    };

    process.once('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
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
