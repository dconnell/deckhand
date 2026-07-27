import WebSocket from 'ws';

import { ConfigError } from './config.js';
import { loadPresentationConfig, parsePresentationCliArgs } from './presentations.js';

function addSocketListener(socket, eventName, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(eventName, handler);
    return;
  }

  if (eventName === 'message') {
    socket.on('message', (data) => {
      handler({ data: String(data) });
    });
    return;
  }

  socket.on(eventName, handler);
}

function createObserverRegistrationMessage() {
  return JSON.stringify({
    type: 'register',
    role: 'observer',
    subscriptions: ['presentationState'],
  });
}

function normalizeWaitMs(value) {
  if (value === undefined) {
    return 1000;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError('--wait-ms must be a non-negative integer');
  }

  return parsed;
}

async function expectOkResponse(fetchFn, url, init, label) {
  const response = await fetchFn(url, init);

  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }

  return response;
}

function waitForHubRegistration(WebSocketClass, hubUrl, waitMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClass(hubUrl);
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        socket.close();
      } catch {
        // ignore websocket cleanup failures
      }
      reject(new Error(`Timed out waiting for observer registration from ${hubUrl}`));
    }, waitMs);

    function finish(callback) {
      return (value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        try {
          socket.close();
        } catch {
          // ignore websocket cleanup failures
        }
        callback(value);
      };
    }

    addSocketListener(socket, 'open', () => {
      socket.send(createObserverRegistrationMessage());
    });

    addSocketListener(socket, 'error', finish((error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    }));

    addSocketListener(socket, 'close', finish(() => {
      reject(new Error(`Hub socket closed before observer registration completed: ${hubUrl}`));
    }));

    addSocketListener(socket, 'message', finish((event) => {
      const payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));

      if (payload.type !== 'registered' || payload.role !== 'observer') {
        reject(new Error(`Unexpected hub message while waiting for observer registration: ${JSON.stringify(payload)}`));
        return;
      }

      resolve(payload);
    }));
  });
}

function isMainModule(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === new URL(`file://${process.argv[1]}`).href;
}

/**
 * Run a presenter smoke check against the local HTTP and websocket surfaces.
 *
 * @param {{ args?: string[], consoleLike?: Console, cwd?: string, fetchFn?: typeof fetch, WebSocketClass?: typeof WebSocket }} [options] CLI options.
 * @returns {Promise<number>}
 */
export async function runPresenterSmoke(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const consoleLike = options.consoleLike ?? console;
  const cwd = options.cwd ?? process.cwd();
  const fetchFn = options.fetchFn ?? fetch;
  const WebSocketClass = options.WebSocketClass ?? WebSocket;
  let parsed;

  try {
    parsed = parsePresentationCliArgs({
      args,
      options: {
        'wait-ms': { type: 'string' },
      },
    });
  } catch (error) {
    consoleLike.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const waitMs = normalizeWaitMs(parsed.values['wait-ms']);
  let config;

  try {
    config = (await loadPresentationConfig({ cwd, presentationName: parsed.presentationName })).config;
  } catch (error) {
    if (error instanceof ConfigError) {
      consoleLike.error(`Invalid configuration at ${error.path}: ${error.message}`);
      return 1;
    }

    consoleLike.error(`Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (config.presenter === null) {
    consoleLike.error('Presenter mode is not enabled in this config file.');
    return 1;
  }

  const baseUrl = `http://${config.presenter.http.host}:${config.presenter.http.port}`;

  try {
    await expectOkResponse(fetchFn, `${baseUrl}/presenter/`, { method: 'HEAD' }, 'Presenter app');
    consoleLike.log(`Presenter app ok: ${baseUrl}/presenter/`);

    const bootstrapResponse = await expectOkResponse(fetchFn, `${baseUrl}/presenter/bootstrap.json`, undefined, 'Presenter bootstrap');
    const bootstrap = await bootstrapResponse.json();

    if (typeof bootstrap.hubUrl !== 'string' || bootstrap.hubUrl.trim() === '') {
      throw new Error('Presenter bootstrap did not include a valid hubUrl');
    }

    consoleLike.log(`Presenter bootstrap ok: ${bootstrap.hubUrl}`);

    const statusResponse = await expectOkResponse(fetchFn, `${baseUrl}/status.json`, undefined, 'Status endpoint');
    const status = await statusResponse.json();
    consoleLike.log(`Status endpoint ok: ${status.current?.slideId ?? 'no active slide'}`);

    await waitForHubRegistration(WebSocketClass, bootstrap.hubUrl, waitMs);
    consoleLike.log(`Hub registration ok: ${bootstrap.hubUrl}`);
    return 0;
  } catch (error) {
    consoleLike.error(`Presenter smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  const exitCode = await runPresenterSmoke();
  process.exitCode = exitCode;
}
