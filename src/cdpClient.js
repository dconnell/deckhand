function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Low-level Chrome DevTools Protocol transport for one Deckhand browser session.
 *
 * The discovery and transport factories are injectable so unit tests can drive
 * mocked WebSocket traffic without a real Chrome process.
 *
 * @param {{ discover(): Promise<{ webSocketDebuggerUrl: string, chromePid?: number | null }>, createTransport(url: string): { send(raw: string): void, close(): void, on(event: 'message' | 'close' | 'error', handler: (payload?: string) => void): void, waitUntilReady?(): Promise<void> }, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Client dependencies.
 * @returns {{ connect(): Promise<void>, disconnect(): Promise<void>, isConnected(): boolean, getChromePid(): number | null, on(event: 'disconnected', handler: () => void): void, createWindow(details: { url: string }): Promise<{ targetId: string, windowId: number }>, createTab(details: { url: string }): Promise<{ targetId: string, windowId: number }>, activateTab(details: { targetId: string }): Promise<void>, navigateTab(details: { targetId: string, url: string }): Promise<void>, getTargets(): Promise<Array<Record<string, unknown>>> }}
 */
export function createCdpClient(options) {
  const logger = options.logger ?? createNoopLogger();
  const pending = new Map();
  const sessions = new Map();
  const lifecycleHandlers = new Set();
  let transport = null;
  let connected = false;
  let chromePid = null;
  let nextId = 1;

  function rejectPendingRequests(message) {
    const error = new Error(message);

    for (const waiter of pending.values()) {
      waiter.reject(error);
    }

    pending.clear();
    sessions.clear();
  }

  function handleTransportClosed() {
    const shouldNotify = connected;

    connected = false;
    transport = null;
    rejectPendingRequests('CDP transport closed');
    logger.warn('CDP transport closed');

    if (shouldNotify) {
      lifecycleHandlers.forEach((handler) => handler());
    }
  }

  function handleMessage(raw) {
    let parsed;

    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (parsed?.id === undefined) {
      return;
    }

    const waiter = pending.get(parsed.id);

    if (waiter === undefined) {
      return;
    }

    pending.delete(parsed.id);

    if (parsed.error !== undefined) {
      waiter.reject(new Error(String(parsed.error?.message ?? 'CDP error')));
      return;
    }

    waiter.resolve(parsed.result);
  }

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (transport === null || !connected) {
        reject(new Error('CDP client is not connected'));
        return;
      }

      const id = nextId;
      nextId += 1;

      const message = { id, method, params };

      if (sessionId !== undefined) {
        message.sessionId = sessionId;
      }

      pending.set(id, { resolve, reject });

      try {
        transport.send(JSON.stringify(message));
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return {
    async connect() {
      if (connected) {
        return;
      }

      const info = await options.discover();

      if (!isPlainObject(info) || typeof info.webSocketDebuggerUrl !== 'string' || info.webSocketDebuggerUrl.trim() === '') {
        throw new Error('discover() must return a webSocketDebuggerUrl string');
      }

      chromePid = typeof info.chromePid === 'number' ? info.chromePid : null;
      const nextTransport = options.createTransport(info.webSocketDebuggerUrl);

      nextTransport.on('message', handleMessage);
      nextTransport.on('close', () => {
        if (transport !== nextTransport) {
          return;
        }

        handleTransportClosed();
      });
      nextTransport.on('error', (error) => {
        logger.error('CDP transport error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      transport = nextTransport;

      try {
        await nextTransport.waitUntilReady?.();
      } catch (error) {
        if (transport === nextTransport) {
          transport = null;
          rejectPendingRequests('CDP transport failed before becoming ready');
        }

        try {
          nextTransport.close();
        } catch {
          // ignore cleanup failures from a transport that never became ready
        }

        throw error;
      }

      connected = true;
      logger.info('Connected to CDP browser endpoint', { chromePid });
    },

    async disconnect() {
      const currentTransport = transport;

      connected = false;
      transport = null;
      rejectPendingRequests('CDP client disconnected');

      if (currentTransport !== null) {
        currentTransport.close();
      }
    },

    isConnected() {
      return connected;
    },

    getChromePid() {
      return chromePid;
    },

    on(event, handler) {
      if (event !== 'disconnected') {
        return;
      }

      lifecycleHandlers.add(handler);
    },

    async createWindow({ url }) {
      const createResult = await send('Target.createTarget', { url, newWindow: true });
      const targetId = createResult.targetId;
      const windowResult = await send('Browser.getWindowForTarget', { targetId });

      return {
        targetId,
        windowId: windowResult.windowId,
      };
    },

    async createTab({ url }) {
      const createResult = await send('Target.createTarget', { url, background: true });
      const targetId = createResult.targetId;
      const windowResult = await send('Browser.getWindowForTarget', { targetId });

      return {
        targetId,
        windowId: windowResult.windowId,
      };
    },

    async activateTab({ targetId }) {
      await send('Target.activateTarget', { targetId });
    },

    async navigateTab({ targetId, url }) {
      let sessionId = sessions.get(targetId);

      if (sessionId === undefined) {
        const attach = await send('Target.attachToTarget', { targetId, flatten: true });
        sessionId = attach.sessionId;
        sessions.set(targetId, sessionId);
      }

      await send('Page.navigate', { url }, sessionId);
    },

    async getTargets() {
      const result = await send('Target.getTargets', {});

      return Array.isArray(result?.targetInfos) ? result.targetInfos : [];
    },
  };
}
