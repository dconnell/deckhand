import { diffNewWindows } from './macWindows.js';
import { delay } from './lifecycle/waitFor.js';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

function listBrowserSources(sources) {
  return Object.values(sources).filter((source) => source?.kind === 'browser');
}

function createEmptyRegistry() {
  return { sources: {}, auxWindows: {} };
}

function defaultWindowTitle(sourceId) {
  if (sourceId === 'Slide') {
    return 'Deckhand Example Deck';
  }

  return `Deckhand ${sourceId}`;
}

const DEFAULT_MAC_WINDOW_MAX_ATTEMPTS = 30;
const DEFAULT_MAC_WINDOW_RETRY_MS = 500;
const TELEPROMPTER_AUX_WINDOW_KEY = 'presenter-teleprompter';
const TELEPROMPTER_AUX_WINDOW_SIZE = Object.freeze({ width: 500, height: 700 });

function distanceFromBounds(window, expectedBounds) {
  if (expectedBounds === null || typeof window.width !== 'number' || typeof window.height !== 'number') {
    return Number.POSITIVE_INFINITY;
  }

  return Math.abs(window.width - expectedBounds.width) + Math.abs(window.height - expectedBounds.height);
}

function boundsArea(window) {
  return (typeof window.width === 'number' ? window.width : 0)
    * (typeof window.height === 'number' ? window.height : 0);
}

/**
 * Pick the window with the largest bounds area from a non-empty set.
 *
 * Mirrors the heuristic in {@link resolveOwnedWindowBindings}: when a launch
 * surfaces several new CGWindowID entries (transient helper/toolbar windows),
 * the largest-bounds entry is the real application window. Ties break toward
 * the higher `windowId` (the more recently created window).
 *
 * @param {Array<{ windowId: number, width?: number, height?: number }>} windows Non-empty candidate list.
 * @returns {{ windowId: number, width?: number, height?: number }}
 */
function pickLargestBoundsWindow(windows) {
  return windows.reduce((best, candidate) => {
    const candidateArea = boundsArea(candidate);
    const bestArea = boundsArea(best);

    if (candidateArea === bestArea) {
      return candidate.windowId > best.windowId ? candidate : best;
    }

    return candidateArea > bestArea ? candidate : best;
  });
}

function pickClosestBoundsWindow(windows, expectedBounds) {
  return windows.reduce((best, candidate) => {
    const bestDistance = distanceFromBounds(best, expectedBounds);
    const candidateDistance = distanceFromBounds(candidate, expectedBounds);

    if (candidateDistance === bestDistance) {
      return pickLargestBoundsWindow([best, candidate]);
    }

    return candidateDistance < bestDistance ? candidate : best;
  });
}

/**
 * Resolve the macOS `CGWindowID` of a browser window Deckhand just created.
 *
 * Snapshots are taken by the caller (before creation) and here (after, polled):
 * the diff finds the new window purely by CGWindowID, with no dependence on
 * window titles or the Accessibility API. Returns `null` (with a warning) when
 * no new window appears within the attempt budget, so the caller can fall back
 * to title-based resolution.
 *
 * @param {{ pid: number, before: Array<{ windowId: number }>, enumerateFn: (pid: number) => Array<{ windowId: number, width?: number, height?: number }>, delayFn: (ms: number) => Promise<void>, logger: { warn(message: string, context?: Record<string, unknown>): void }, sourceId: string, maxAttempts: number, retryDelayMs: number, expectedBounds?: { width: number, height: number } | null }} options Resolution options.
 * @returns {Promise<number | null>}
 */
async function resolveNewMacWindowId({ pid, before, enumerateFn, delayFn, logger, sourceId, maxAttempts, retryDelayMs, expectedBounds = null }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const after = enumerateFn(pid);
    const newWindows = diffNewWindows(before, after);

    if (newWindows.length > 0) {
      const resolvedWindow = expectedBounds === null
        ? pickLargestBoundsWindow(newWindows)
        : pickClosestBoundsWindow(newWindows, expectedBounds);
      return resolvedWindow.windowId;
    }

    if (attempt < maxAttempts) {
      await delayFn(retryDelayMs);
    }
  }

  logger.warn('Browser source window did not appear in CGWindowList; leaving macWindowId unresolved', { source: sourceId });
  return null;
}

/**
 * Own the Deckhand browser session and the authoritative source/tab registry.
 *
 * The cdp client factory is injectable so the registry, preload ordering, and
 * command routing can be tested without a real Chrome process. Identity is
 * always a runtime handle created by Deckhand, never URL or title lookup.
 *
 * @param {{ sources: Record<string, { id: string, kind: string, browser?: { windowLabel: string | null, tabs: Record<string, { url: string, preload: boolean }>, initialTab: string } }>, createCdpClient(): { connect(): Promise<void>, disconnect(): Promise<void>, isConnected(): boolean, getChromePid(): number | null, on(event: 'disconnected', handler: () => void): void, createWindow(details: { url: string, width?: number, height?: number }): Promise<{ targetId: string, windowId: number }>, createTab(details: { url: string }): Promise<{ targetId: string, windowId: number }>, activateTab(details: { targetId: string }): Promise<void>, navigateTab(details: { targetId: string, url: string, loadTimeoutMs?: number }): Promise<void>, waitForTabPaint(details: { targetId: string, paintTimeoutMs?: number }): Promise<void>, setWindowTitle(details: { targetId: string, title: string }): Promise<void>, closeTarget(details: { targetId: string }): Promise<void> }, enumerateWindowIdsByPidFn?: (pid: number) => Array<{ windowId: number, width?: number, height?: number }>, recovery?: { browserRecover?: { enabled?: boolean, initialDelayMs?: number, maxDelayMs?: number } }, timer?: { setTimeout(fn: () => void, ms: number): unknown, clearTimeout(handle: unknown): void }, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Session dependencies.
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, openWindow(url: string): Promise<void>, openAuxWindow(details: { key: string, title: string, url: string, reopen?: boolean }): Promise<{ key: string, targetId: string, cdpWindowId: number, macWindowId: number | null, title: string, url: string }>, activateTab(sourceId: string, tabAlias: string): Promise<void>, navigateTab(sourceId: string, tabAlias: string, url: string): Promise<void>, relaunchBrowserSource(sourceId: string): Promise<{ macWindowId: number | null }>, on(event: 'recovered' | 'transportLost', handler: () => void): void, getStatus(): { connected: boolean, phase: 'connected' | 'reconnecting' | 'recovering' | 'disconnected', chromePid: number | null, sources: Record<string, { ready: boolean, activeTab: string | null, tabs: string[] }> }, getRegistry(): { sources: Record<string, { cdpWindowId: number | null, mainTargetId: string | null, title: string, tabs: Record<string, { targetId: string, initialUrl: string }>, activeTab: string | null }>, auxWindows: Record<string, { key: string, targetId: string, cdpWindowId: number, macWindowId: number | null, title: string, url: string }> } }}
 */
export function createBrowserSession(options) {
  const logger = options.logger ?? createNoopLogger();
  const enumerateWindowIdsByPidFn = typeof options.enumerateWindowIdsByPidFn === 'function'
    ? options.enumerateWindowIdsByPidFn
    : null;
  const delayFn = options.delayFn ?? delay;
  const macWindowMaxAttempts = options.resolveMacWindowMaxAttempts ?? DEFAULT_MAC_WINDOW_MAX_ATTEMPTS;
  const macWindowRetryMs = options.resolveMacWindowRetryMs ?? DEFAULT_MAC_WINDOW_RETRY_MS;
  const timer = options.timer ?? {
    setTimeout(fn, ms) {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimeout(handle) {
      clearTimeout(handle);
    },
  };
  const browserRecover = options.recovery?.browserRecover ?? { enabled: true, initialDelayMs: 500, maxDelayMs: 10000 };
  let cdpClient = null;
  let registry = createEmptyRegistry();
  let stopping = false;
  let stopped = true;
  let recovering = false;
  let rebuilding = false;
  let recoverAttempt = 0;
  let recoverTimer = null;
  let transportLostFired = false;
  const lifecycleHandlers = new Map();

  function emitLifecycle(event) {
    const handlers = lifecycleHandlers.get(event);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      try {
        handler();
      } catch (error) {
        logger.warn('Browser session lifecycle handler threw', {
          event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function computeRecoverDelay(attempt) {
    const base = browserRecover.initialDelayMs * (2 ** attempt);
    return Math.min(base, browserRecover.maxDelayMs);
  }

  function scheduleRecover() {
    if (!browserRecover.enabled || stopped || stopping) {
      return;
    }

    const delay = computeRecoverDelay(recoverAttempt);
    recoverAttempt += 1;
    recoverTimer = timer.setTimeout(attemptRecover, delay);
  }

  function handleUnexpectedDisconnect() {
    if (!transportLostFired) {
      transportLostFired = true;
      emitLifecycle('transportLost');
    }

    if (!browserRecover.enabled || recovering) {
      return;
    }

    recovering = true;
    rebuilding = false;
    recoverAttempt = 0;
    scheduleRecover();
  }

  async function attemptRecover() {
    if (stopped || stopping || !recovering) {
      return;
    }

    try {
      registry = createEmptyRegistry();
      rebuilding = true;
      await cdpClient.connect();

      for (const source of listBrowserSources(options.sources)) {
        await buildSource(source);
      }

      recovering = false;
      rebuilding = false;
      recoverAttempt = 0;
      transportLostFired = false;
      logger.info('Browser session recovered after unexpected disconnect', {
        chromePid: cdpClient.getChromePid(),
      });
      emitLifecycle('recovered');
    } catch (error) {
      rebuilding = false;
      logger.warn('Browser session recover attempt failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleRecover();
    }
  }

  function requireSource(sourceId) {
    const source = registry.sources[sourceId];

    if (source === undefined) {
      throw new Error(`unknown source: ${sourceId}`);
    }

    return source;
  }

  function requireTab(source, tabAlias) {
    const tab = source.tabs[tabAlias];

    if (tab === undefined) {
      throw new Error(`unknown tab: ${tabAlias}`);
    }

    return tab;
  }

  function listTrackedTargetIds() {
    const targetIds = new Set();

    for (const source of Object.values(registry.sources)) {
      for (const tab of Object.values(source.tabs)) {
        targetIds.add(tab.targetId);
      }
    }

    for (const window of Object.values(registry.auxWindows)) {
      targetIds.add(window.targetId);
    }

    return [...targetIds];
  }

  async function resolveAuxWindowMacWindowId() {
    const chromePid = cdpClient.getChromePid();

    if (enumerateWindowIdsByPidFn === null || !Number.isInteger(chromePid) || chromePid <= 0) {
      return null;
    }

    const before = enumerateWindowIdsByPidFn(chromePid);

    return {
      before,
      chromePid,
    };
  }

  async function buildSource(source) {
    const browser = source.browser;
    const initialAlias = browser.initialTab;
    const initialTab = browser.tabs[initialAlias];

    if (initialTab === undefined) {
      throw new Error(`initial tab "${initialAlias}" is not declared on source ${source.id}`);
    }

    for (const [alias, tab] of Object.entries(browser.tabs)) {
      if (tab.preload === false) {
        throw new Error(`source ${source.id} tab ${alias} disables preload, but Deckhand currently preloads all declared tabs`);
      }
    }

    const chromePid = cdpClient.getChromePid();
    const canResolveMacWindow = enumerateWindowIdsByPidFn !== null
      && Number.isInteger(chromePid) && chromePid > 0;
    const before = canResolveMacWindow ? enumerateWindowIdsByPidFn(chromePid) : [];

    const windowResult = await cdpClient.createWindow({ url: initialTab.url });

    const macWindowId = canResolveMacWindow
      ? await resolveNewMacWindowId({
        pid: chromePid,
        before,
        enumerateFn: enumerateWindowIdsByPidFn,
        delayFn,
        logger,
        sourceId: source.id,
        maxAttempts: macWindowMaxAttempts,
        retryDelayMs: macWindowRetryMs,
      })
      : null;

    const sourceRegistry = {
      cdpWindowId: windowResult.windowId,
      macWindowId,
      mainTargetId: windowResult.targetId,
      title: defaultWindowTitle(source.id),
      tabs: {
        [initialAlias]: {
          targetId: windowResult.targetId,
          initialUrl: initialTab.url,
        },
      },
      activeTab: initialAlias,
    };

    for (const [alias, tab] of Object.entries(browser.tabs)) {
      if (alias === initialAlias) {
        continue;
      }

      const tabResult = await cdpClient.createTab({ url: tab.url });

      if (tabResult.windowId !== sourceRegistry.cdpWindowId) {
        throw new Error(`source ${source.id} tab ${alias} did not open in the same Chrome window as its source`);
      }

      sourceRegistry.tabs[alias] = {
        targetId: tabResult.targetId,
        initialUrl: tab.url,
      };
    }

    await cdpClient.setWindowTitle({
      targetId: sourceRegistry.mainTargetId,
      title: sourceRegistry.title,
    }).catch((error) => {
      logger.warn('Failed to set window title', {
        error: error instanceof Error ? error.message : String(error),
        source: source.id,
      });
    });

    for (const [alias, tab] of Object.entries(sourceRegistry.tabs)) {
      if (alias === initialAlias) {
        continue;
      }

      await cdpClient.setWindowTitle({
        targetId: tab.targetId,
        title: sourceRegistry.title,
      }).catch(() => {});
    }

    await cdpClient.activateTab({ targetId: sourceRegistry.mainTargetId }).catch(() => {});

    registry.sources[source.id] = sourceRegistry;
  }

  return {
    async start() {
      if (cdpClient !== null) {
        return;
      }

      cdpClient = options.createCdpClient();

      try {
        await cdpClient.connect();
      } catch (error) {
        cdpClient = null;
        throw error;
      }

      stopped = false;
      transportLostFired = false;

      cdpClient.on('disconnected', () => {
        if (stopping || stopped) {
          return;
        }

        logger.warn('Browser session disconnected unexpectedly');
        handleUnexpectedDisconnect();
      });

      const browserSources = listBrowserSources(options.sources);

      try {
        for (const source of browserSources) {
          await buildSource(source);
        }
      } catch (error) {
        stopping = true;
        await cdpClient.disconnect().catch(() => {});
        stopping = false;
        stopped = true;
        cdpClient = null;
        registry = createEmptyRegistry();
        throw error;
      }

      logger.info('Browser session ready', {
        sourceCount: browserSources.length,
        chromePid: cdpClient.getChromePid(),
      });
    },

    async stop() {
      stopped = true;
      recovering = false;
      rebuilding = false;

      if (recoverTimer !== null) {
        timer.clearTimeout(recoverTimer);
        recoverTimer = null;
      }

      if (cdpClient === null) {
        return;
      }

      stopping = true;

      for (const auxWindow of Object.values(registry.auxWindows)) {
        try {
          await cdpClient.closeTarget({ targetId: auxWindow.targetId });
        } catch (error) {
          logger.warn('Failed to close tracked auxiliary window', {
            error: error instanceof Error ? error.message : String(error),
            key: auxWindow.key,
          });
        }
      }

      await cdpClient.disconnect().catch(() => {});
      stopping = false;
      cdpClient = null;
      registry = createEmptyRegistry();
      logger.info('Browser session stopped');
    },

    async openWindow(url) {
      if (cdpClient === null) {
        throw new Error('browser session is not started');
      }

      await cdpClient.createWindow({ url });
      logger.info('Opened unmanaged window', { url });
    },

    async openAuxWindow(details) {
      if (cdpClient === null) {
        throw new Error('browser session is not started');
      }

      if (recovering) {
        throw new Error('browser session is recovering');
      }

      const existing = registry.auxWindows[details.key];

      if (existing !== undefined && details.reopen !== true) {
        try {
          await cdpClient.activateTab({ targetId: existing.targetId });
          return existing;
        } catch (error) {
          logger.warn('Failed to focus tracked auxiliary window; reopening', {
            error: error instanceof Error ? error.message : String(error),
            key: details.key,
          });
          delete registry.auxWindows[details.key];
        }
      }

      if (existing !== undefined && details.reopen === true) {
        await cdpClient.closeTarget({ targetId: existing.targetId }).catch((error) => {
          logger.warn('Failed to close tracked auxiliary window before reopen', {
            error: error instanceof Error ? error.message : String(error),
            key: details.key,
          });
        });
        delete registry.auxWindows[details.key];
      }

      const resolution = await resolveAuxWindowMacWindowId();
      const windowSize = details.key === TELEPROMPTER_AUX_WINDOW_KEY
        ? TELEPROMPTER_AUX_WINDOW_SIZE
        : null;
      const windowResult = await cdpClient.createWindow({
        url: details.url,
        ...(windowSize ?? {}),
      });
      await cdpClient.setWindowTitle({ targetId: windowResult.targetId, title: details.title }).catch(() => {});
      await cdpClient.activateTab({ targetId: windowResult.targetId }).catch(() => {});

      const macWindowId = resolution === null
        ? null
        : await resolveNewMacWindowId({
            pid: resolution.chromePid,
            before: resolution.before,
            enumerateFn: enumerateWindowIdsByPidFn,
            delayFn,
            expectedBounds: windowSize,
            logger,
            sourceId: details.key,
            maxAttempts: macWindowMaxAttempts,
            retryDelayMs: macWindowRetryMs,
          });

      const auxWindow = {
        key: details.key,
        targetId: windowResult.targetId,
        cdpWindowId: windowResult.windowId,
        macWindowId,
        title: details.title,
        url: details.url,
      };
      registry.auxWindows[details.key] = auxWindow;
      return auxWindow;
    },

    async activateTab(sourceId, tabAlias) {
      if (cdpClient === null) {
        throw new Error('browser session is not started');
      }

      if (recovering) {
        throw new Error('browser session is recovering');
      }

      const source = requireSource(sourceId);
      const tab = requireTab(source, tabAlias);

      await cdpClient.activateTab({ targetId: tab.targetId });
      source.activeTab = tabAlias;
      await cdpClient.waitForTabPaint({ targetId: tab.targetId });
    },

    async navigateTab(sourceId, tabAlias, url) {
      if (cdpClient === null) {
        throw new Error('browser session is not started');
      }

      if (recovering) {
        throw new Error('browser session is recovering');
      }

      const source = requireSource(sourceId);
      const tab = requireTab(source, tabAlias);

      await cdpClient.navigateTab({ targetId: tab.targetId, url });

      if (source.activeTab === tabAlias) {
        await cdpClient.waitForTabPaint({ targetId: tab.targetId });
      }
    },

    async relaunchBrowserSource(sourceId) {
      if (cdpClient === null) {
        throw new Error('browser session is not started');
      }

      if (recovering) {
        throw new Error('browser session is recovering');
      }

      const descriptor = options.sources[sourceId];

      if (descriptor === undefined || descriptor.kind !== 'browser') {
        throw new Error(`unknown browser source: ${sourceId}`);
      }

      logger.info('Relaunching browser source window', { source: sourceId });
      await buildSource(descriptor);

      return { macWindowId: registry.sources[sourceId]?.macWindowId ?? null };
    },

    getStatus() {
      const connected = cdpClient !== null && cdpClient.isConnected();
      let phase;

      if (rebuilding) {
        phase = 'recovering';
      } else if (recovering) {
        phase = 'reconnecting';
      } else if (connected) {
        phase = 'connected';
      } else {
        phase = 'disconnected';
      }

      return {
        connected,
        phase,
        chromePid: cdpClient === null ? null : cdpClient.getChromePid(),
        sources: Object.fromEntries(
          Object.entries(registry.sources).map(([id, source]) => [
            id,
            {
              ready: connected,
              activeTab: source.activeTab,
              tabs: Object.keys(source.tabs),
            },
          ]),
        ),
      };
    },

    getRegistry() {
      return registry;
    },

    on(event, handler) {
      if (event !== 'recovered' && event !== 'transportLost') {
        return;
      }

      const handlers = lifecycleHandlers.get(event) ?? new Set();
      handlers.add(handler);
      lifecycleHandlers.set(event, handlers);
    },
  };
}

/**
 * Create the command executor that maps typed slide commands onto the browser
 * session runtime. This is the seam the coordinator dispatches through; it keeps
 * browser routing logic out of the coordinator itself.
 *
 * @param {{ browserSession: { start(): Promise<void>, stop(): Promise<void>, activateTab(sourceId: string, tabAlias: string): Promise<void>, navigateTab(sourceId: string, tabAlias: string, url: string): Promise<void> }, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Executor dependencies.
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, execute(command: { type: 'activateTab' | 'navigate', source: string, tab: string, url?: string }): Promise<void> }}
 */
export function createBrowserCommandExecutor(options) {
  const logger = options.logger ?? createNoopLogger();
  const browserSession = options.browserSession;

  return {
    async start() {
      await browserSession.start();
    },

    async stop() {
      await browserSession.stop();
    },

    async execute(command) {
      if (command.type === 'activateTab') {
        await browserSession.activateTab(command.source, command.tab);
        logger.info('Activated browser tab', { source: command.source, tab: command.tab });
        return;
      }

      if (command.type === 'navigate') {
        await browserSession.navigateTab(command.source, command.tab, command.url);
        logger.info('Navigated browser tab', {
          source: command.source,
          tab: command.tab,
          url: command.url,
        });
        return;
      }

      throw new Error(`Unsupported browser command type: ${command.type}`);
    },
  };
}
