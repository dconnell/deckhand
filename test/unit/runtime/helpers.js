import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

/**
 * Shared fixtures for the `run()` runtime suites in this directory.
 *
 * These are leaf stubs whose shapes mirror the real hub/OBS/CDP seams. They
 * intentionally do NOT merge option objects: every test lists the factories it
 * injects explicitly, because `run()` falls back to real side-effecting
 * implementations for any option a test omits.
 */

/** Path of the checked-in example presentation config used by most suites. */
export const exampleConfigPath = fileURLToPath(
  new URL('../../../presentation/example/config.json', import.meta.url),
);

/**
 * Write a presentation config under `<tempDir>/presentation/<name>/config.json`.
 * @param {string} tempDir
 * @param {string} presentationName
 * @param {string} configText
 * @returns {Promise<void>}
 */
export async function writePresentationConfig(tempDir, presentationName, configText) {
  const presentationDir = path.join(tempDir, 'presentation', presentationName);
  await mkdir(presentationDir, { recursive: true });
  await writeFile(path.join(presentationDir, 'config.json'), configText, 'utf8');
}

/**
 * Copy the checked-in example presentation config into a temp presentation dir.
 * @param {string} tempDir
 * @param {string} presentationName
 * @returns {Promise<void>}
 */
export async function writeExamplePresentationConfig(tempDir, presentationName) {
  const config = await readFile(exampleConfigPath, 'utf8');
  await writePresentationConfig(tempDir, presentationName, config);
}

/**
 * Console stub that swallows output and optionally taps `error`/`warn` lines.
 * @param {{ onError?: (message: string) => void, onWarn?: (message: string) => void }} [taps]
 * @returns {{ error: (message: string) => void, info: () => void, log: () => void, warn: (message: string) => void }}
 */
export function createSilentConsole(taps = {}) {
  return {
    error(message) {
      taps.onError?.(message);
    },
    info() {},
    log() {},
    warn(message) {
      taps.onWarn?.(message);
    },
  };
}

function baseHubMembers() {
  return {
    async start() {},
    async stop() {},
    getAddress() {
      return { host: '127.0.0.1', port: 8765 };
    },
  };
}

/**
 * Hub stub without event dispatch, for tests that never rely on `emit`.
 * @param {{ snapshot?: object, sendCommand?: (target: unknown, command: unknown) => Promise<unknown> }} [options]
 * @returns {object} hub stub
 */
export function createHubStub({ snapshot = { activeDriver: null, observers: [], sticky: {} }, sendCommand } = {}) {
  return {
    on() {},
    ...baseHubMembers(),
    getSnapshot() {
      return snapshot;
    },
    async sendCommand(target, command) {
      return sendCommand?.(target, command);
    },
  };
}

/**
 * Hub stub that records `on` registrations (queued per event) and dispatches
 * `emit` through them, awaiting async handlers.
 * @param {{ snapshot?: object, sendCommand?: (target: unknown, command: unknown) => Promise<unknown> }} [options]
 * @returns {object} hub stub with `emit(eventName, payload)`
 */
export function createEmittingHubStub({
  snapshot = { activeDriver: null, observers: [], sticky: {} },
  sendCommand,
} = {}) {
  const handlers = new Map();

  return {
    on(eventName, handler) {
      const queue = handlers.get(eventName) ?? [];
      queue.push(handler);
      handlers.set(eventName, queue);
    },
    ...baseHubMembers(),
    getSnapshot() {
      return snapshot;
    },
    async emit(eventName, payload) {
      const queue = handlers.get(eventName) ?? [];
      for (const handler of queue) {
        await handler(payload);
      }
    },
    async sendCommand(target, command) {
      return sendCommand?.(target, command);
    },
  };
}

/**
 * OBS client stub covering the connect/scene/input surface `run()` touches.
 * @returns {object} obs client stub
 */
export function createObsClientStub() {
  return {
    async connect() {},
    async disconnect() {},
    async setScene() {},
    async applyInputSettings() {},
    getClient() {
      return this;
    },
    isConnected() {
      return false;
    },
  };
}

/**
 * CDP client stub whose connection is already established.
 * @param {number} chromePid
 * @returns {object} cdp client stub
 */
export function createCdpClientStub(chromePid) {
  return {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getChromePid() {
      return chromePid;
    },
    on() {},
    async createWindow() {},
    async createTab() {},
    async activateTab() {},
    async navigateTab() {},
    async closeTarget() {},
  };
}

/**
 * Browser-session stub with a registry of three browser sources (Slide,
 * BrowserA, BrowserB) carrying fixed macWindowIds.
 * @param {number} chromePid
 * @returns {object} browser session stub
 */
export function createBrowserSessionStub(chromePid) {
  return {
    async start() {},
    async stop() {},
    async openWindow() {
      return { windowId: 999 };
    },
    async openAuxWindow() {
      return { key: 'mock', targetId: 'TARGET_MOCK', cdpWindowId: 999, macWindowId: null, title: 'Mock', url: '' };
    },
    async measureMinimumWindowSize() {
      return null;
    },
    getStatus() {
      return { connected: true, chromePid, sources: {} };
    },
    getRegistry() {
      return {
        sources: {
          Slide: { title: 'Deckhand Deck', macWindowId: 11111 },
          BrowserA: { title: 'Deckhand Demo Primary', macWindowId: 12345 },
          BrowserB: { title: 'Deckhand Demo Secondary', macWindowId: 67890 },
        },
      };
    },
    async activateTab() {},
    async navigateTab() {},
  };
}

/**
 * Presenter HTTP server stub with no-ops for the lifecycle methods.
 * @returns {{ start: () => Promise<void>, stop: () => Promise<void> }}
 */
export function createPresenterHttpStub() {
  return {
    async start() {},
    async stop() {},
  };
}

/**
 * Presentation (audience) HTTP server stub bound to a fixed address.
 * @returns {object} presentation server stub
 */
export function createPresentationServerStub() {
  return {
    async start() {},
    async stop() {},
    getAddress() {
      return { host: '127.0.0.1', port: 3000 };
    },
  };
}
