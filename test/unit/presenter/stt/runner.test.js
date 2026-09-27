import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';

import { WebSocketServer } from 'ws';

import { runSttObserver } from '../../../../src/presenter/stt/runner.js';
import { createCaptureLogger as createLogger } from '../../../helpers/logger.js';

async function createMessageServer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');

  const address = server.address();
  const sockets = new Set();
  const messages = [];

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('message', (buffer) => {
      messages.push(JSON.parse(String(buffer)));
    });
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  return {
    messages,
    url: `ws://127.0.0.1:${address.port}`,
    async waitForMessages(count) {
      while (messages.length < count) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    async close() {
      for (const socket of sockets) {
        socket.close();
      }

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function createMockPersistentSubprocess() {
  let resolveReady;
  let readyResolved = false;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let resolveResult;
  let rejectResult;
  let killed = false;

  function maybeResolveReady() {
    if (!readyResolved && stdout.listenerCount('data') > 0 && stderr.listenerCount('data') > 0) {
      readyResolved = true;
      resolveReady();
    }
  }

  const originalStdoutOn = stdout.on.bind(stdout);
  const originalStderrOn = stderr.on.bind(stderr);
  stdout.on = (eventName, listener) => {
    const result = originalStdoutOn(eventName, listener);
    maybeResolveReady();
    return result;
  };
  stderr.on = (eventName, listener) => {
    const result = originalStderrOn(eventName, listener);
    maybeResolveReady();
    return result;
  };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};

  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  return {
    async waitUntilReady() {
      await ready;
    },
    stderr,
    stdout,
    get killed() {
      return killed;
    },
    kill() {
      killed = true;
    },
    fail(error) {
      rejectResult(error);
    },
    finish(output = { exitCode: 0, stderr: '', stdout: '' }) {
      resolveResult(output);
    },
    result,
  };
}

function createSttConfig(overrides = {}) {
  return {
    captureId: -1,
    keepMs: 250,
    lengthMs: 6000,
    model: '/tmp/model.bin',
    noFallback: true,
    stepMs: 1500,
    whisperBin: '/tmp/whisper-stream',
    ...overrides,
  };
}

test('runSttObserver publishes incremental stepped transcripts from one persistent subprocess and exits after first publish in once mode', async () => {
  const server = await createMessageServer();
  const logger = createLogger();
  const subprocess = createMockPersistentSubprocess();
  const invocations = [];
  let nowMs = 1720000000000;

  try {
    const runPromise = runSttObserver({
      chunkInput: ':7',
      createSubprocess: (command, args, options) => {
        invocations.push({ command, args, options });
        return subprocess;
      },
      hubUrl: server.url,
      logger,
      nowFn: () => nowMs,
      once: true,
      restartDelayMs: 0,
      stt: createSttConfig({ captureId: 5, language: 'en' }),
    });

    await subprocess.waitUntilReady();
    nowMs = 1720000002500;
    subprocess.stdout.emit('data', 'whisper_init_state: loading model\n[Start speaking]\n\u001b[2K\rWalk through');
    nowMs = 1720000002750;
    subprocess.stdout.emit('data', ' the init flow.');
    nowMs = 1720000003000;
    subprocess.stdout.emit('data', '\u001b[2K\rWalk through the init flow.\n');
    subprocess.finish();
    await runPromise;
    await server.waitForMessages(2);

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, '/tmp/whisper-stream');
    assert.deepEqual(invocations[0].args, [
      '-m', '/tmp/model.bin',
      '--capture', '7',
      '--step', '1500',
      '--length', '6000',
      '--keep', '250',
      '-l', 'en',
      '--no-fallback',
    ]);
    assert.deepEqual(server.messages, [
      {
        type: 'register',
        role: 'observer',
        subscriptions: [],
      },
      {
        type: 'transcript',
        source: 'whisper',
        text: 'Walk through the init flow.',
        capturedAtMs: 1720000001500,
      },
    ]);
    assert.equal(logger.warns.length, 0);
  } finally {
    await server.close();
  }
});

test('runSttObserver restarts a failed subprocess with backoff, logs stderr diagnostics, and keeps dedupe across restarts', async () => {
  const server = await createMessageServer();
  const logger = createLogger();
  const controller = new AbortController();
  const first = createMockPersistentSubprocess();
  const second = createMockPersistentSubprocess();
  const children = [first, second];
  const spawnCalls = [];
  const delayCalls = [];
  let nowMs = 1720000001000;

  try {
    const runPromise = runSttObserver({
      createSubprocess: (command, args, options) => {
        const child = children[spawnCalls.length];
        spawnCalls.push({ command, args, options });
        return child;
      },
      delayFn: async (delayMs) => {
        delayCalls.push(delayMs);
      },
      hubUrl: server.url,
      logger,
      nowFn: () => nowMs,
      restartDelayMs: 250,
      signal: controller.signal,
      stt: createSttConfig(),
    });

    await first.waitUntilReady();
    nowMs = 1720000001500;
    first.stdout.emit('data', '\u001b[2K\rRetry worked.');
    first.stderr.emit('data', 'dropped audio\n');
    const runFinished = runPromise.catch(() => {});
    first.fail(new Error('stream crashed'));

    await new Promise((resolve) => setImmediate(resolve));
    await second.waitUntilReady();
    nowMs = 1720000001750;
    second.stdout.emit('data', '\u001b[2K\rRetry worked.');
    nowMs = 1720000002000;
    second.stdout.emit('data', '\u001b[2K\rRecovered text.');
    controller.abort();
    second.finish();
    await runFinished;
    await server.waitForMessages(3);

    assert.equal(spawnCalls.length, 2);
    assert.deepEqual(delayCalls, [250]);
    assert.deepEqual(server.messages, [
      {
        type: 'register',
        role: 'observer',
        subscriptions: [],
      },
      {
        type: 'transcript',
        source: 'whisper',
        text: 'Retry worked.',
        capturedAtMs: 1720000000000,
      },
      {
        type: 'transcript',
        source: 'whisper',
        text: 'Recovered text.',
        capturedAtMs: 1720000000500,
      },
    ]);
    assert.equal(logger.warns.length, 1);
    assert.match(logger.warns[0].message, /retry/i);
    assert.match(String(logger.warns[0].context?.error), /stream crashed/i);
    assert.match(String(logger.warns[0].context?.stderr), /dropped audio/i);
  } finally {
    await server.close();
  }
});

test('runSttObserver fails fast in once mode when the persistent subprocess exits before any transcript is published', async () => {
  const server = await createMessageServer();
  const subprocess = createMockPersistentSubprocess();

  try {
    const runPromise = runSttObserver({
      createSubprocess: () => subprocess,
      hubUrl: server.url,
      once: true,
      stt: createSttConfig(),
    });
    const rejection = assert.rejects(runPromise, /capture failed/i);

    await subprocess.waitUntilReady();
    subprocess.fail(new Error('capture failed'));

    await rejection;
  } finally {
    await server.close();
  }
});

test('runSttObserver aborts the persistent subprocess when the observer is cancelled', async () => {
  const server = await createMessageServer();
  const controller = new AbortController();
  const subprocess = createMockPersistentSubprocess();

  try {
    const runPromise = runSttObserver({
      createSubprocess: () => subprocess,
      hubUrl: server.url,
      restartDelayMs: 0,
      signal: controller.signal,
      stt: createSttConfig(),
    });
    const completion = runPromise.catch(() => {});

    await subprocess.waitUntilReady();
    controller.abort();
    subprocess.fail(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    await completion;

    assert.equal(subprocess.killed, true);
  } finally {
    await server.close();
  }
});

test('runSttObserver estimates VAD transcript capture time from the configured window length', async () => {
  const server = await createMessageServer();
  const subprocess = createMockPersistentSubprocess();
  let nowMs = 1720000010000;

  try {
    const runPromise = runSttObserver({
      createSubprocess: () => subprocess,
      hubUrl: server.url,
      nowFn: () => nowMs,
      once: true,
      restartDelayMs: 0,
      stt: createSttConfig({
        captureId: 2,
        freqThreshold: 120,
        lengthMs: 6000,
        mode: 'vad',
        vadThreshold: 0.6,
      }),
    });

    await subprocess.waitUntilReady();
    subprocess.stdout.emit('data', '### Transcription 0 START | t0 = 0 ms | t1 = 6000 ms\n');
    subprocess.stdout.emit('data', '[00:00:00.000 --> 00:00:06.000]  Final segment.\n');
    nowMs = 1720000011000;
    subprocess.stdout.emit('data', '### Transcription 0 END\n');
    subprocess.finish();
    await runPromise;
    await server.waitForMessages(2);

    assert.deepEqual(server.messages.at(-1), {
      type: 'transcript',
      source: 'whisper',
      text: 'Final segment.',
      capturedAtMs: 1720000008000,
    });
  } finally {
    await server.close();
  }
});
