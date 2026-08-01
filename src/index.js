import { access } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, ConfigError } from './config.js';
import { createCoordinator } from './coordinator.js';
import { createHub } from './hub.js';
import { createObsClient } from './obsClient.js';
import { createPresentationServer } from './presentationServer.js';
import { createPresenterHttpServer } from './presenterHttp.js';
import { reconcileObsPresentation } from './setupObs.js';
import { loadPresentationConfig } from './presentations.js';
import { parsePresentationCliArgs } from './presentations.js';
import { resolvePresentationPaths } from './presentations.js';
import { buildRuntimeStatus } from './runtimeStatus.js';
import { createCdpClient } from './cdpClient.js';
import { createBrowserSession, createBrowserCommandExecutor } from './browserSession.js';
import { createWsTransport, discoverCdpEndpoint, launchChromeSession } from './chromeLauncher.js';
import { enumerateWindowsByPid } from './macWindows.js';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const PRESENTATION_SERVER_HOST = '127.0.0.1';
const PRESENTATION_SERVER_PORT = Number(process.env.PORT ?? 3000);
const DRIVER_READY_TIMEOUT_MS = 10000;
const PRESENTER_OBSERVER_TIMEOUT_MS = 5000;
const WINDOW_BINDINGS_TIMEOUT_MS = 15000;

function hasBrowserSources(config) {
  return Object.values(config.sources).some((source) => source?.kind === 'browser');
}

function resolveProfileDir(config, presentationName) {
  if (config.chrome?.profileDir !== undefined) {
    return config.chrome.profileDir;
  }

  return path.join(os.tmpdir(), 'deckhand-chrome-profiles', presentationName, randomUUID());
}

function listBrowserSourceIds(config) {
  return Object.entries(config.sources)
    .filter(([, source]) => source?.kind === 'browser')
    .map(([id]) => id);
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
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  return resolvedBindings;
}

async function waitForWindowBindings({ hub, expectedSources, timeoutMs = WINDOW_BINDINGS_TIMEOUT_MS, logger }) {
  if (expectedSources.length === 0) {
    return;
  }

  const resolved = new Set();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      const missing = expectedSources.filter((source) => !resolved.has(source));
      reject(new Error(
        `Timed out waiting for Hammerspoon to resolve window bindings for: ${missing.join(', ')}. `
        + 'Check Hammerspoon is running, has Accessibility permission, and can see the Deckhand Chrome windows.',
      ));
    }, timeoutMs);

    function checkResolve() {
      if (resolved.size === expectedSources.length) {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve();
      }
    }

    hub.on('observerWindowBindings', (payload) => {
      for (const source of Object.keys(payload.bindings ?? {})) {
        const binding = payload.bindings[source];
        if (binding?.macWindowId !== undefined && expectedSources.includes(source)) {
          resolved.add(source);
          logger.info('Resolved exact window binding', {
            macWindowId: binding.macWindowId,
            pid: binding.pid,
            source,
          });
        }
      }

      checkResolve();
    });
  });
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
 * @param {{ cwd?: string, presentationName?: string, configPath?: string, consoleLike?: Console, createHubFn?: typeof createHub, createObsClientFn?: typeof createObsClient, createCoordinatorFn?: typeof createCoordinator, createPresenterHttpFn?: typeof createPresenterHttpServer, createPresentationServerFn?: typeof createPresentationServer, createBrowserSessionFn?: typeof createBrowserSession, createBrowserCommandExecutorFn?: typeof createBrowserCommandExecutor, createCdpClientFn?: typeof createCdpClient, launchChromeSessionFn?: typeof launchChromeSession, discoverCdpEndpointFn?: typeof discoverCdpEndpoint, reconcileObsFn?: typeof reconcileObsPresentation, waitForDriverPositionFn?: typeof waitForFirstDriverPosition, waitForPresentationObserverFn?: typeof waitForPresentationObserver, installSignalHandlers?: boolean, presenterAssetsPath?: string }} [options] Startup options.
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

  async function stopBrowserRuntime() {
    await coordinator?.stop().catch(() => {});
  }

  function installShutdownHandlers() {
    if (!installSignalHandlers) {
      return;
    }

    const shutdown = (signal) => {
      phase = 'shuttingDown';
      logger.info('Received shutdown signal', { signal });

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

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }

  try {
    hub = (options.createHubFn ?? createHub)({ ...config.hub, logger });
    obs = (options.createObsClientFn ?? createObsClient)({ ...config.obs, logger });
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
      getManagedBrowserBindings() {
        if (browserSession === null || config.presenter === null) {
          return {};
        }

        const chromePid = browserSession.getStatus().chromePid;
        const registry = browserSession.getRegistry().sources;

        return Object.fromEntries(
          Object.entries(registry).map(([sourceId, source]) => [
            sourceId,
            {
              app: config.presenter.windows[sourceId]?.app,
              pid: chromePid,
              titleIncludes: source.title,
            },
          ]),
        );
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
        const presenterUrl = `http://${config.presenter.http.host}:${config.presenter.http.port}/presenter/`;
        await browserSession.openWindow(presenterUrl).catch((error) => {
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

      const result = await windowResolutionFn({
        browserSession,
        browserSourceIds,
        config,
        logger,
      });

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

      const obsWindowBindings = {};
      for (const [sourceId, binding] of Object.entries(result)) {
        obsWindowBindings[sourceId] = {
          app: config.presenter.windows[sourceId]?.app ?? 'Google Chrome',
          pid: binding.pid,
          macWindowId: binding.macWindowId,
          strict: true,
        };
      }

      await (options.reconcileObsFn ?? reconcileObsPresentation)({
        config,
        logger,
        obs: typeof obs.getClient === 'function' ? obs.getClient() : obs,
        windowBindings: obsWindowBindings,
      });
    }

    phase = 'ready';
  } catch (error) {
    phase = 'failed';
    consoleLike.error(`Coordinator failed to start: ${error instanceof Error ? error.message : String(error)}`);
    await presenterHttp?.stop().catch(() => {});
    await stopBrowserRuntime();
    await stopLaunchedChrome();
    await presentationServer?.stop().catch(() => {});
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
