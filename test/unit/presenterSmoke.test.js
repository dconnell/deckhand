import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { runPresenterSmoke } from '../../src/presenterSmoke.js';

function createConsoleLike() {
  return {
    errors: [],
    logs: [],
    error(message) {
      this.errors.push(message);
    },
    log(message) {
      this.logs.push(message);
    },
  };
}

async function writePresentationConfig(tempDir, presentationName, config) {
  const presentationDir = path.join(tempDir, 'presentation', presentationName);
  await mkdir(presentationDir, { recursive: true });
  await writeFile(path.join(presentationDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

class FakeWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.listeners = new Map();

    queueMicrotask(() => {
      this.#emit('open');
      queueMicrotask(() => {
        this.#emit('message', {
          data: JSON.stringify({
            type: 'registered',
            role: 'observer',
            sessionId: 'observer-1',
            subscriptions: ['presenterState'],
          }),
        });
      });
    });
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  close() {
    this.#emit('close');
  }

  send(message) {
    this.sent = JSON.parse(message);
  }

  #emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

test('runPresenterSmoke validates presenter HTTP surfaces and hub registration', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-smoke-'));
  const consoleLike = createConsoleLike();

  try {
    await writePresentationConfig(tempDir, 'demo', {
      driver: { type: 'revealjs' },
      obs: { url: 'ws://127.0.0.1:4455', password: '' },
      hub: { host: '127.0.0.1', port: 8765 },
      sources: {
        Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
      },
      layouts: {
        'full-slide': {
          audienceScene: 'Full Slide',
          slots: [{ source: 'Slide', position: 'full' }],
        },
      },
      slides: {
        intro: { layout: 'full-slide' },
      },
      presenter: {
        platform: 'macos',
        stage: { x: 0, y: 0, width: 1800, height: 1168 },
        windows: {
          Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' },
        },
        http: {
          host: '127.0.0.1',
          port: 3001,
        },
      },
    });

    const exitCode = await runPresenterSmoke({
      args: ['--wait-ms', '0', 'demo'],
      consoleLike,
      cwd: tempDir,
      fetchFn: async (url, init) => {
        if (String(url).endsWith('/status.json')) {
          return new Response(JSON.stringify({ service: 'deckhand', current: null, presenter: null }), { status: 200 });
        }

        if (String(url).endsWith('/presenter/bootstrap.json')) {
          return new Response(JSON.stringify({
            followEnabledByDefault: true,
            hubUrl: 'ws://127.0.0.1:8765',
          }), { status: 200 });
        }

        if (String(url).endsWith('/presenter/')) {
          assert.equal(init.method, 'HEAD');
          return new Response('', { status: 200 });
        }

        throw new Error(`Unexpected URL: ${url}`);
      },
      WebSocketClass: FakeWebSocket,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(consoleLike.errors, []);
    assert.ok(consoleLike.logs.some((line) => /status endpoint ok/i.test(line)));
    assert.ok(consoleLike.logs.some((line) => /hub registration ok/i.test(line)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
