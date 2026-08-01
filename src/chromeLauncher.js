import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import WebSocket from 'ws';

const DEFAULT_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const DEFAULT_DEBUG_PORT_RANGE = { min: 9222, max: 9322 };

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

const MAC_CHROME_USER_DATA_DIR = path.join('Library', 'Application Support', 'Google', 'Chrome');

async function resolveNamedProfilePath(profileName, envFn) {
  const homeDir = envFn().HOME;

  if (typeof homeDir !== 'string' || homeDir.trim() === '') {
    throw new Error('HOME must be set to resolve chrome.profileName');
  }

  const userDataRoot = path.join(homeDir, MAC_CHROME_USER_DATA_DIR);
  const localStatePath = path.join(userDataRoot, 'Local State');
  const localState = JSON.parse(await readFile(localStatePath, 'utf8'));
  const entries = localState?.profile?.info_cache;

  if (entries === undefined || entries === null || typeof entries !== 'object') {
    throw new Error(`Could not resolve Chrome profile named "${profileName}" from ${localStatePath}`);
  }

  for (const [directoryName, entry] of Object.entries(entries)) {
    if (entry?.name === profileName) {
      return path.join(userDataRoot, directoryName);
    }
  }

  throw new Error(`Could not find Chrome profile named "${profileName}"`);
}

async function prepareProfileDir(profileDir, profileName, envFn) {
  if (profileName === undefined) {
    await mkdir(profileDir, { recursive: true });
    return { profileName: null, profilePath: null, profileDir };
  }

  const sourceProfilePath = await resolveNamedProfilePath(profileName, envFn);
  const parentDir = path.dirname(profileDir);
  await mkdir(parentDir, { recursive: true });
  const workingProfileDir = await mkdtemp(path.join(parentDir, 'deckhand-profile-'));
  await cp(sourceProfilePath, path.join(workingProfileDir, path.basename(sourceProfilePath)), { recursive: true });

  return {
    profileName,
    profilePath: sourceProfilePath,
    profileDir: workingProfileDir,
  };
}

async function readDevToolsPort(profileDir) {
  const filePath = path.join(profileDir, 'DevToolsActivePort');

  try {
    const text = await readFile(filePath, 'utf8');
    const [portLine] = text.split(/\r?\n/);
    const port = Number(portLine?.trim());

    if (Number.isInteger(port) && port > 0) {
      return port;
    }
  } catch {
    // fall back to the requested port when Chrome has not written the file yet
  }

  return null;
}

async function resolveChromeExecutable(executablePath, envFn) {
  if (typeof executablePath === 'string' && executablePath.trim() !== '') {
    return executablePath.trim();
  }

  const env = envFn();
  const envPath = typeof env?.DECKHAND_CHROME_PATH === 'string' ? env.DECKHAND_CHROME_PATH.trim() : '';

  if (envPath !== '') {
    return envPath;
  }

  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // continue searching
    }
  }

  throw new Error('Could not locate Google Chrome. Set chrome.executablePath in config or the DECKHAND_CHROME_PATH environment variable.');
}

function buildChromeArgs({ profileDir, debugPort, extraArgs }) {
  return [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-popup-blocking',
    ...(Array.isArray(extraArgs) ? extraArgs : []),
  ];
}

/**
 * Launch a dedicated Deckhand Chrome session with its own profile.
 *
 * The spawned process owns its own user-data directory so it never touches the
 * operator's ordinary Chrome profile.
 *
 * @param {{ executablePath?: string, profileDir: string, profileName?: string, debugPort?: number, extraArgs?: string[], spawnFn?: typeof spawn, envFn?: () => NodeJS.ProcessEnv, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Launch options.
 * @returns {Promise<{ chromePid: number, debugPort: number, executable: string, profileDir: string, profileName: string | null, profilePath: string | null, stop(): Promise<void> }>}
 */
export async function launchChromeSession(options) {
  const logger = options.logger ?? createNoopLogger();
  const spawnFn = options.spawnFn ?? spawn;
  const envFn = options.envFn ?? (() => process.env);
  const executable = await resolveChromeExecutable(options.executablePath, envFn);
  const debugPort = options.debugPort ?? randomInt(DEFAULT_DEBUG_PORT_RANGE.min, DEFAULT_DEBUG_PORT_RANGE.max + 1);
  const preparedProfile = await prepareProfileDir(options.profileDir, options.profileName, envFn);

  const args = buildChromeArgs({
    profileDir: preparedProfile.profileDir,
    debugPort,
    extraArgs: options.extraArgs,
  });

  logger.info('Launching Deckhand Chrome session', {
    debugPort,
    executable,
    profileDir: preparedProfile.profileDir,
    profileName: preparedProfile.profileName,
  });

  const child = spawnFn(executable, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...envFn(), DECKHAND_OWNED: '1' },
  });

  const chromePid = typeof child.pid === 'number' ? child.pid : -1;

  child.on?.('error', (error) => {
    logger.error('Deckhand Chrome session error', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return {
    chromePid,
    debugPort,
    executable,
    profileDir: preparedProfile.profileDir,
    profileName: preparedProfile.profileName,
    profilePath: preparedProfile.profilePath,
    stop() {
      try {
        child.kill('SIGKILL');
      } catch {
        // process may have already exited
      }
    },
  };
}

/**
 * Discover the CDP browser WebSocket endpoint for an already-launched Chrome.
 *
 * @param {{ debugPort: number, profileDir?: string, fetchFn?: typeof fetch, retries?: number, retryDelayMs?: number, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Discovery options.
 * @returns {Promise<{ webSocketDebuggerUrl: string, chromePid: null }>} 
 */
export async function discoverCdpEndpoint(options) {
  const fetchFn = options.fetchFn ?? fetch;
  const retries = options.retries ?? 50;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const url = `http://127.0.0.1:${options.debugPort}/json/version`;

  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const activePort = options.profileDir === undefined ? null : await readDevToolsPort(options.profileDir);
      const url = `http://127.0.0.1:${activePort ?? options.debugPort}/json/version`;
      const response = await fetchFn(url);

      if (!response.ok) {
        throw new Error(`unexpected status ${response.status}`);
      }

      const body = await response.json();

      if (typeof body?.webSocketDebuggerUrl !== 'string' || body.webSocketDebuggerUrl.trim() === '') {
        throw new Error('response missing webSocketDebuggerUrl');
      }

      return { webSocketDebuggerUrl: body.webSocketDebuggerUrl, chromePid: null };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(`Could not reach Chrome DevTools endpoint at http://127.0.0.1:${options.debugPort}/json/version: ${lastError?.message ?? 'unknown error'}`);
}

/**
 * Create a CDP transport backed by a real WebSocket connection.
 *
 * @param {{ url: string, WebSocketClass?: typeof WebSocket }} options Transport options.
 * @returns {{ send(raw: string): void, close(): void, on(event: 'message' | 'close' | 'error', handler: (payload?: string) => void): void, waitUntilReady(): Promise<void> }}
 */
export function createWsTransport(options) {
  const WebSocketClass = options.WebSocketClass ?? WebSocket;
  const socket = new WebSocketClass(options.url);
  const listeners = {
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };
  let readySettled = false;
  const ready = new Promise((resolve, reject) => {
    socket.on('open', () => {
      if (readySettled) {
        return;
      }

      readySettled = true;
      resolve();
    });

    socket.on('error', (error) => {
      if (!readySettled) {
        readySettled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }

      listeners.error.forEach((handler) => handler(error));
    });

    socket.on('close', () => {
      if (!readySettled) {
        readySettled = true;
        reject(new Error('CDP transport closed before becoming ready'));
      }

      listeners.close.forEach((handler) => handler());
    });
  });
  ready.catch(() => {});

  socket.on('message', (raw) => {
    const payload = typeof raw === 'string' ? raw : String(raw);
    listeners.message.forEach((handler) => handler(payload));
  });

  return {
    send(raw) {
      socket.send(raw);
    },
    close() {
      socket.close();
    },
    on(event, handler) {
      listeners[event]?.add(handler);
    },
    waitUntilReady() {
      return ready;
    },
  };
}
