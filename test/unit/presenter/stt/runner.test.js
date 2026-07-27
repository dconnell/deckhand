import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';

import { WebSocketServer } from 'ws';

import { runSttObserver } from '../../../../src/presenter/stt/runner.js';

function createLogger() {
  return {
    errors: [],
    infos: [],
    warns: [],
    error(message, context) {
      this.errors.push({ message, context });
    },
    info(message, context) {
      this.infos.push({ message, context });
    },
    warn(message, context) {
      this.warns.push({ message, context });
    },
  };
}

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

test('runSttObserver captures once and publishes a parsed transcript', async () => {
  const server = await createMessageServer();
  const commands = [];

  try {
    await runSttObserver({
      commandRunner: async (command, args) => {
        commands.push({ command, args });

        if (command === 'ffmpeg') {
          return { exitCode: 0, stderr: '', stdout: '' };
        }

        return {
          exitCode: 0,
          stderr: '',
          stdout: '[00:00:00.000 --> 00:00:02.500]  Walk through the init flow.\n',
        };
      },
      hubUrl: server.url,
      nowFn: () => 1720000000000,
      once: true,
      restartDelayMs: 0,
      stt: {
        chunkSeconds: 2.5,
        model: '/tmp/model.bin',
        whisperBin: '/tmp/whisper-cli',
      },
    });

    assert.equal(commands.length, 2);
    assert.equal(commands[0].command, 'ffmpeg');
    assert.equal(commands[1].command, '/tmp/whisper-cli');
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
        capturedAtMs: 1720000000000,
      },
    ]);
  } finally {
    await server.close();
  }
});

test('runSttObserver retries failed loop iterations until aborted', async () => {
  const server = await createMessageServer();
  const controller = new AbortController();
  const logger = createLogger();
  let attempts = 0;

  try {
    await runSttObserver({
      commandRunner: async (command) => {
        if (command === 'ffmpeg') {
          attempts += 1;

          if (attempts === 1) {
            throw new Error('mic busy');
          }

          return { exitCode: 0, stderr: '', stdout: '' };
        }

        controller.abort();
        return {
          exitCode: 0,
          stderr: '',
          stdout: '[00:00:00.000 --> 00:00:02.500]  Retry worked.\n',
        };
      },
      hubUrl: server.url,
      logger,
      nowFn: () => 1720000001111,
      restartDelayMs: 0,
      signal: controller.signal,
      stt: {
        chunkSeconds: 2.5,
        model: '/tmp/model.bin',
        whisperBin: '/tmp/whisper-cli',
      },
    });

    assert.equal(attempts, 2);
    assert.equal(logger.warns.length, 1);
    assert.match(logger.warns[0].message, /retry/i);
    assert.deepEqual(server.messages.at(-1), {
      type: 'transcript',
      source: 'whisper',
      text: 'Retry worked.',
      capturedAtMs: 1720000001111,
    });
  } finally {
    await server.close();
  }
});

test('runSttObserver fails fast in once mode when capture fails', async () => {
  const server = await createMessageServer();

  try {
    await assert.rejects(
      () => runSttObserver({
        commandRunner: async () => {
          throw new Error('capture failed');
        },
        hubUrl: server.url,
        once: true,
        stt: {
          chunkSeconds: 2.5,
          model: '/tmp/model.bin',
          whisperBin: '/tmp/whisper-cli',
        },
      }),
      /capture failed/i,
    );
  } finally {
    await server.close();
  }
});
