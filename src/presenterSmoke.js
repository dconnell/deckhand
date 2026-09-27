import WebSocket from 'ws';

import { errorMessage } from './lib/errors.js';
import { isMainModule, loadPresenterCliContext } from './presenter/cliBootstrap.js';

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

    // The message listener must not go through `finish` unconditionally: a
    // non-registration message has to leave the wait alive, and a parse or
    // shape failure has to reject cleanly instead of throwing past the
    // settled guard and leaving this promise dangling forever.
    addSocketListener(socket, 'message', (event) => {
      let payload;

      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        finish(reject)(new Error(`Hub sent a message that was not valid JSON while waiting for observer registration: ${hubUrl}`));
        return;
      }

      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        finish(reject)(new Error(`Hub sent a message with an unexpected shape while waiting for observer registration: ${hubUrl}`));
        return;
      }

      if (payload.type !== 'registered' || payload.role !== 'observer') {
        // Well-formed hub traffic that is not our registration ack (sticky
        // state replays, pings) can arrive first; ignore it and keep waiting.
        return;
      }

      finish(resolve)(payload);
    });
  });
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

  const bootstrap = await loadPresenterCliContext({
    args,
    consoleLike,
    cwd,
    options: {
      'wait-ms': { type: 'string' },
    },
  });

  if (!bootstrap.ok) {
    return 1;
  }

  let waitMs;

  try {
    waitMs = normalizeWaitMs(bootstrap.parsed.values['wait-ms']);
  } catch (error) {
    consoleLike.error(errorMessage(error));
    return 1;
  }

  const config = bootstrap.config;

  if (config.presenter === null) {
    consoleLike.error('Presenter mode is not enabled in this config file.');
    return 1;
  }

  const baseUrl = `http://${config.presenter.http.host}:${config.presenter.http.port}`;

  try {
    await expectOkResponse(fetchFn, `${baseUrl}/presenter/`, { method: 'HEAD' }, 'Presenter app');
    consoleLike.log(`Presenter app ok: ${baseUrl}/presenter/`);

    const bootstrapResponse = await expectOkResponse(fetchFn, `${baseUrl}/presenter/bootstrap.json`, undefined, 'Presenter bootstrap');
    const bootstrapPayload = await bootstrapResponse.json();

    if (typeof bootstrapPayload.hubUrl !== 'string' || bootstrapPayload.hubUrl.trim() === '') {
      throw new Error('Presenter bootstrap did not include a valid hubUrl');
    }

    consoleLike.log(`Presenter bootstrap ok: ${bootstrapPayload.hubUrl}`);

    const statusResponse = await expectOkResponse(fetchFn, `${baseUrl}/status.json`, undefined, 'Status endpoint');
    const status = await statusResponse.json();
    consoleLike.log(`Status endpoint ok: ${status.current?.slideId ?? 'no active slide'}`);

    await waitForHubRegistration(WebSocketClass, bootstrapPayload.hubUrl, waitMs);
    consoleLike.log(`Hub registration ok: ${bootstrapPayload.hubUrl}`);
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
