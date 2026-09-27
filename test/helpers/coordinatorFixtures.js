import { createCaptureLogger } from './logger.js';

/**
 * Logger fake that records every message with its context so tests can assert
 * on the exact warnings and errors the coordinator emits. Delegates to the
 * shared capture logger; kept as `createLogger` for the coordinator suites.
 *
 * @returns {{ errors: Array<{ message: string, context: unknown }>, infos: Array<{ message: string, context: unknown }>, warns: Array<{ message: string, context: unknown }>, error(message: string, context?: unknown): void, info(message: string, context?: unknown): void, warn(message: string, context?: unknown): void }}
 */
export function createLogger() {
  return createCaptureLogger();
}

/**
 * Minimal coordinator config covering two browser sources, two layouts, and
 * two slides (`intro`, `demo`). Tests mutate the returned object freely.
 *
 * @returns {Record<string, unknown>} A fresh coordinator config.
 */
export function createConfig() {
  return {
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { host: '127.0.0.1', port: 8765 },
    sources: {
      Slide: { id: 'Slide', kind: 'browser', browser: { windowLabel: null, tabs: { deck: { url: 'http://deck/', preload: true } }, initialTab: 'deck' } },
      BrowserA: {
        id: 'BrowserA',
        kind: 'browser',
        browser: {
          windowLabel: 'browser-a',
          tabs: {
            home: { url: 'https://example.com/home', preload: true },
            checkout: { url: 'https://example.com/checkout', preload: true },
          },
          initialTab: 'home',
        },
      },
      BrowserB: { id: 'BrowserB', kind: 'browser', browser: { windowLabel: 'browser-b', tabs: { main: { url: 'https://example.com/other', preload: true } }, initialTab: 'main' } },
    },
    layouts: {
      'full-slide': {
        id: 'full-slide',
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full' }],
        sources: ['Slide'],
      },
      'dual-browser': {
        id: 'dual-browser',
        audienceScene: 'Dual Browser',
        slots: [
          { source: 'BrowserA', position: 'left' },
          { source: 'BrowserB', position: 'right' },
        ],
        sources: ['BrowserA', 'BrowserB'],
      },
    },
    slides: {
      intro: {
        layoutId: 'full-slide',
        focus: null,
        script: null,
        commands: [],
      },
      demo: {
        layoutId: 'dual-browser',
        focus: 'BrowserB',
        script: 'Demo script',
        commands: [
          { type: 'activateTab', source: 'BrowserA', tab: 'checkout' },
          { type: 'navigate', source: 'BrowserB', tab: 'main', url: 'https://example.com/other-app' },
        ],
      },
    },
    presenter: {
      platform: 'macos',
      stage: { x: 0, y: 0, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Google Chrome' },
        BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
        BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
      },
      stt: null,
      teleprompter: { followEnabledByDefault: true },
      http: { host: '127.0.0.1', port: 3001 },
    },
  };
}

/**
 * Extend the base config with a fully configured transitions block. The short
 * settle windows keep transition suites fast without changing behavior.
 *
 * @param {Record<string, unknown>} overrides Applied on top of the defaults.
 * @returns {Record<string, unknown>} A fresh coordinator config with transitions enabled.
 */
export function createTransitionsConfig(overrides = {}) {
  const config = createConfig();
  config.obs.transitions = {
    forward: 'Slide Right',
    backward: 'Slide Left',
    freezeScene: 'Freeze',
    freezeImage: 'Freeze Frame',
    freezeImagePath: null,
    settleMs: 1,
    navigationWaitMs: 1,
    windowSettleMs: 1,
    durationMs: 50,
    freezeDimPercent: 10,
    ...overrides,
  };
  return config;
}

/**
 * Publish-signal store shared by the hub fakes. Records every sticky publish
 * and lets tests await a specific publish instead of sleeping for an arbitrary
 * number of milliseconds. The coordinator registers its settle waiters before
 * publishing, so resolving a `waitForPublish` guarantees any waiter for that
 * seq is armed.
 *
 * @param {Array<{ channel: string, payload: Record<string, unknown> }>} [publishes] Caller-owned array to record into.
 * @returns {{ publishes: Array<{ channel: string, payload: Record<string, unknown> }>, record(channel: string, payload: Record<string, unknown>): void, waitForPublish(channel: string, predicate?: (entry: { channel: string, payload: Record<string, unknown> }) => boolean, timeoutMs?: number): Promise<{ channel: string, payload: Record<string, unknown> }> }}
 */
function createPublishSignal(publishes = []) {
  const waiters = [];

  function record(channel, payload) {
    const entry = { channel, payload };
    publishes.push(entry);

    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.channel === channel && waiter.predicate(entry)) {
        waiters.splice(index, 1);
        waiter.resolve(entry);
      }
    }
  }

  function waitForPublish(channel, predicate = () => true, timeoutMs = 2000) {
    const existing = publishes.find((entry) => entry.channel === channel && predicate(entry));
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const waiter = { channel, predicate, resolve: null, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a '${channel}' publish`));
      }, timeoutMs);
      waiter.resolve = (entry) => {
        clearTimeout(waiter.timer);
        resolve(entry);
      };
      waiters.push(waiter);
    });
  }

  return { publishes, record, waitForPublish };
}

/**
 * Stateful hub fake used by the sticky-state suites: records driver commands
 * and sticky publishes, and exposes `waitForPublish` for deterministic
 * synchronization on a published payload.
 *
 * @returns {Record<string, unknown>} A fake hub with a publish signal.
 */
export function createFakeHub() {
  const handlers = new Map();
  const signal = createPublishSignal();
  const state = {
    sentDriverCommands: [],
    stickyPublishes: signal.publishes,
    started: false,
    stopped: false,
  };

  return {
    state,
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    emit(eventName, payload) {
      const handler = handlers.get(eventName);
      if (handler) {
        return handler(payload);
      }

      return undefined;
    },
    async start() {
      state.started = true;
    },
    async stop() {
      state.stopped = true;
    },
    async sendCommand(target, command) {
      state.sentDriverCommands.push({ target, command });
    },
    async publishSticky(channel, payload) {
      signal.record(channel, payload);
    },
    waitForPublish: signal.waitForPublish,
    getSnapshot() {
      return { activeDriver: null, observers: [], sticky: {} };
    },
  };
}

/**
 * Executor fake that records dispatched commands and can fail exactly once via
 * `state.nextError`.
 *
 * @returns {Record<string, unknown>} A fake executor.
 */
export function createFakeExecutor() {
  const state = { started: false, stopped: false, executedCommands: [], nextError: null };

  return {
    state,
    async start() {
      state.started = true;
    },
    async stop() {
      state.stopped = true;
    },
    async execute(command) {
      state.executedCommands.push(command);

      if (state.nextError !== null) {
        const error = state.nextError;
        state.nextError = null;
        throw error;
      }
    },
  };
}

/**
 * OBS client fake recording scenes, input settings, and lifecycle state, with
 * canned screenshot and stream-status payloads for the status polling suites.
 *
 * @returns {Record<string, unknown>} A fake OBS client.
 */
export function createFakeObs() {
  const state = { connected: false, disconnected: false, scenes: [], inputSettings: [] };

  return {
    state,
    async connect() {
      state.connected = true;
    },
    async disconnect() {
      state.disconnected = true;
    },
    async setScene(sceneName) {
      state.scenes.push(sceneName);
    },
    async applyInputSettings(inputName, inputSettings) {
      state.inputSettings.push({ inputName, inputSettings });
    },
    async getProgramScreenshotBuffer() {
      return Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    },
    async getStreamStatus() {
      return {
        outputActive: true,
        outputBytes: 4_250_000,
        outputDuration: 10_000,
        outputSkippedFrames: 0,
      };
    },
    isConnected() {
      return state.connected;
    },
  };
}

/**
 * Trace-based hub fake used by the transition and settle suites. Pushes
 * `'publishSticky'` onto the trace for ordering assertions and records the
 * published payloads so tests can await a specific seq deterministically.
 *
 * @param {string[]} trace Shared call-order trace.
 * @param {{ activeDriver?: Record<string, unknown> | null, publishes?: Array<{ channel: string, payload: Record<string, unknown> }> }} [options] Snapshot active driver and a caller-owned publish record.
 * @returns {Record<string, unknown>} A tracing hub with a publish signal.
 */
export function createTracingHub(trace, { activeDriver = null, publishes = [] } = {}) {
  const handlers = new Map();
  const signal = createPublishSignal(publishes);

  return {
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    emit(eventName, payload) {
      return handlers.get(eventName)?.(payload);
    },
    async start() {},
    async stop() {},
    async sendCommand() {},
    async publishSticky(channel, payload) {
      trace.push('publishSticky');
      signal.record(channel, payload);
    },
    waitForPublish: signal.waitForPublish,
    getSnapshot() {
      return { activeDriver, observers: [], sticky: {} };
    },
  };
}

/**
 * Trace-based OBS client fake covering the full transition surface: scene
 * switches, transitions, freeze assets, and screenshot capture.
 *
 * @param {string[]} trace Shared call-order trace.
 * @param {{ failCapture?: boolean }} [options] Make `captureProgramScreenshot` throw.
 * @returns {Record<string, unknown>} A tracing OBS client.
 */
export function createTracingObs(trace, { failCapture = false } = {}) {
  return {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    async setScene(name) {
      trace.push(`setScene:${name}`);
    },
    async applyInputSettings(name) {
      trace.push(`applyInputSettings:${name}`);
    },
    async getCurrentTransitionName() {
      trace.push('getCurrentTransitionName');
      return 'Fade';
    },
    async captureProgramScreenshot() {
      trace.push('captureProgramScreenshot');

      if (failCapture) {
        throw new Error('screenshot failed');
      }
    },
    async setCurrentTransition(name) {
      trace.push(`setCurrentTransition:${name}`);
    },
    async switchProgramScene(name) {
      trace.push(`switchProgramScene:${name}`);
    },
    async waitForSceneTransitionEnd() {
      trace.push('waitForSceneTransitionEnd');
    },
    async ensureFreezeAssets(options) {
      trace.push(`ensureFreezeAssets:${options?.dimPercent ?? 'none'}`);
    },
  };
}

/**
 * Trace-based executor fake recording dispatched command types.
 *
 * @param {string[]} trace Shared call-order trace.
 * @returns {Record<string, unknown>} A tracing executor.
 */
export function createTracingExecutor(trace) {
  return {
    async start() {},
    async stop() {},
    async execute(command) {
      trace.push(`execute:${command.type}`);
    },
  };
}

/**
 * Filter a hub's recorded sticky publishes down to one channel.
 *
 * @param {{ state: { stickyPublishes: Array<{ channel: string, payload: Record<string, unknown> }> }}} hub A hub fake created by `createFakeHub`.
 * @param {string} channel Sticky channel to filter on.
 * @returns {Array<{ channel: string, payload: Record<string, unknown> }>} Publishes for the channel in order.
 */
export function listPublishesByChannel(hub, channel) {
  return hub.state.stickyPublishes.filter((entry) => entry.channel === channel);
}
