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

function createPresenterConfig() {
  return {
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
  };
}

function createBootstrapFetchFn() {
  return async (url, init) => {
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
  };
}

class FakeWebSocket {
  static OPEN = 1;

  /**
   * @param {string} url
   * @param {{ messages?: Array<string | object> }} [options] Scripted hub traffic
   *   sent after `open`; objects are JSON-encoded, strings go over the wire raw.
   */
  constructor(url, options = {}) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.listeners = new Map();
    const messages = options.messages ?? [{
      type: 'registered',
      role: 'observer',
      sessionId: 'observer-1',
      subscriptions: ['presenterState'],
    }];

    queueMicrotask(() => {
      this.#emit('open');
      queueMicrotask(() => {
        for (const message of messages) {
          this.#emit('message', {
            data: typeof message === 'string' ? message : JSON.stringify(message),
          });
        }
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
    await writePresentationConfig(tempDir, 'demo', createPresenterConfig());

    const exitCode = await runPresenterSmoke({
      args: ['--wait-ms', '0', 'demo'],
      consoleLike,
      cwd: tempDir,
      fetchFn: createBootstrapFetchFn(),
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

test('runPresenterSmoke reports an invalid --wait-ms value and exits 1 instead of throwing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-smoke-waitms-'));
  const consoleLike = createConsoleLike();

  try {
    await writePresentationConfig(tempDir, 'demo', createPresenterConfig());

    const exitCode = await runPresenterSmoke({
      args: ['--wait-ms', 'soon', 'demo'],
      consoleLike,
      cwd: tempDir,
      fetchFn: createBootstrapFetchFn(),
      WebSocketClass: FakeWebSocket,
    });

    assert.equal(exitCode, 1);
    assert.equal(consoleLike.errors.length, 1);
    assert.match(consoleLike.errors[0], /--wait-ms must be a non-negative integer/);
    assert.deepEqual(consoleLike.logs, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runPresenterSmoke ignores unrelated hub traffic before observer registration', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-smoke-unrelated-'));
  const consoleLike = createConsoleLike();

  try {
    await writePresentationConfig(tempDir, 'demo', createPresenterConfig());

    const exitCode = await runPresenterSmoke({
      args: ['--wait-ms', '50', 'demo'],
      consoleLike,
      cwd: tempDir,
      fetchFn: createBootstrapFetchFn(),
      WebSocketClass: class extends FakeWebSocket {
        constructor(url) {
          super(url, {
            messages: [
              { type: 'presentationState', seq: 1, slideId: 'intro' },
              { type: 'ping' },
              { type: 'registered', role: 'observer', sessionId: 'observer-1' },
            ],
          });
        }
      },
    });

    assert.equal(exitCode, 0);
    assert.ok(consoleLike.logs.some((line) => /hub registration ok/i.test(line)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runPresenterSmoke fails gracefully on malformed JSON from the hub', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-smoke-malformed-'));
  const consoleLike = createConsoleLike();

  try {
    await writePresentationConfig(tempDir, 'demo', createPresenterConfig());

    const exitCode = await runPresenterSmoke({
      args: ['--wait-ms', '50', 'demo'],
      consoleLike,
      cwd: tempDir,
      fetchFn: createBootstrapFetchFn(),
      WebSocketClass: class extends FakeWebSocket {
        constructor(url) {
          super(url, { messages: ['{not valid json'] });
        }
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(consoleLike.errors.length, 1);
    assert.match(consoleLike.errors[0], /Presenter smoke failed/);
    assert.match(consoleLike.errors[0], /not valid JSON/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runPresenterSmoke fails gracefully on non-object hub messages', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-smoke-shape-'));
  const consoleLike = createConsoleLike();

  try {
    await writePresentationConfig(tempDir, 'demo', createPresenterConfig());

    const exitCode = await runPresenterSmoke({
      args: ['--wait-ms', '50', 'demo'],
      consoleLike,
      cwd: tempDir,
      fetchFn: createBootstrapFetchFn(),
      WebSocketClass: class extends FakeWebSocket {
        constructor(url) {
          super(url, { messages: ['42'] });
        }
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(consoleLike.errors.length, 1);
    assert.match(consoleLike.errors[0], /Presenter smoke failed/);
    assert.match(consoleLike.errors[0], /unexpected shape/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
