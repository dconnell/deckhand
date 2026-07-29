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
  return { sources: {} };
}

/**
 * Own the Deckhand browser session and the authoritative source/tab registry.
 *
 * The cdp client factory is injectable so the registry, preload ordering, and
 * command routing can be tested without a real Chrome process. Identity is
 * always a runtime handle created by Deckhand, never URL or title lookup.
 *
 * @param {{ sources: Record<string, { id: string, kind: string, browser?: { windowLabel: string | null, tabs: Record<string, { url: string, preload: boolean }>, initialTab: string } }>, createCdpClient(): { connect(): Promise<void>, disconnect(): Promise<void>, isConnected(): boolean, getChromePid(): number | null, on(event: 'disconnected', handler: () => void): void, createWindow(details: { url: string }): Promise<{ targetId: string, windowId: number }>, createTab(details: { url: string }): Promise<{ targetId: string, windowId: number }>, activateTab(details: { targetId: string }): Promise<void>, navigateTab(details: { targetId: string, url: string }): Promise<void> }, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Session dependencies.
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, activateTab(sourceId: string, tabAlias: string): Promise<void>, navigateTab(sourceId: string, tabAlias: string, url: string): Promise<void>, getStatus(): { connected: boolean, chromePid: number | null, sources: Record<string, { ready: boolean, activeTab: string | null, tabs: string[] }> }, getRegistry(): { sources: Record<string, { cdpWindowId: number | null, mainTargetId: string | null, tabs: Record<string, { targetId: string, initialUrl: string }>, activeTab: string | null }> } }}
 */
export function createBrowserSession(options) {
  const logger = options.logger ?? createNoopLogger();
  let cdpClient = null;
  let registry = createEmptyRegistry();
  let stopping = false;

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

    const windowResult = await cdpClient.createWindow({ url: initialTab.url });

    const sourceRegistry = {
      cdpWindowId: windowResult.windowId,
      mainTargetId: windowResult.targetId,
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

      cdpClient.on('disconnected', () => {
        if (stopping) {
          return;
        }

        logger.warn('Browser session disconnected unexpectedly');
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
      if (cdpClient === null) {
        return;
      }

      stopping = true;
      await cdpClient.disconnect().catch(() => {});
      stopping = false;
      cdpClient = null;
      registry = createEmptyRegistry();
      logger.info('Browser session stopped');
    },

    async activateTab(sourceId, tabAlias) {
      if (cdpClient === null) {
        throw new Error('browser session is not started');
      }

      const source = requireSource(sourceId);
      const tab = requireTab(source, tabAlias);

      await cdpClient.activateTab({ targetId: tab.targetId });
      source.activeTab = tabAlias;
    },

    async navigateTab(sourceId, tabAlias, url) {
      if (cdpClient === null) {
        throw new Error('browser session is not started');
      }

      const source = requireSource(sourceId);
      const tab = requireTab(source, tabAlias);

      await cdpClient.navigateTab({ targetId: tab.targetId, url });
    },

    getStatus() {
      const connected = cdpClient !== null && cdpClient.isConnected();

      return {
        connected,
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
