import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';

import WebSocket from 'ws';

import { createHub } from '../../src/hub.js';

function createLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

async function createClient(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');

  const messages = [];
  socket.on('message', (buffer) => {
    messages.push(JSON.parse(String(buffer)));
  });

  return {
    socket,
    messages,
    async send(payload) {
      socket.send(JSON.stringify(payload));
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    async close() {
      socket.close();
      await once(socket, 'close');
    },
  };
}

test('late presenter observer receives sticky presentation state and live transcripts', async () => {
  const hub = createHub({ host: '127.0.0.1', logger: createLogger(), port: 0 });
  await hub.start();

  const { port } = hub.getAddress();
  const stt = await createClient(port);
  const presenter = await createClient(port);

  try {
    await hub.publishSticky('presentationState', {
      type: 'presentationState',
      seq: 3,
      slideId: 'code-walkthrough',
      layoutId: 'left-terminal-right-slide',
      audienceScene: 'Left Terminal Right Slide',
      slots: [],
      focus: 'Terminal',
      script: 'Walk through the init flow.',
    });

    await stt.send({ type: 'register', role: 'observer', subscriptions: [] });
    await presenter.send({ type: 'register', role: 'observer', subscriptions: ['presentationState', 'transcript'] });

    await stt.send({
      type: 'transcript',
      source: 'whisper',
      text: 'walk through',
      capturedAtMs: 1720000000000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      presenter.messages.filter((message) => message.type === 'presentationState'),
      [{
        type: 'presentationState',
        seq: 3,
        slideId: 'code-walkthrough',
        layoutId: 'left-terminal-right-slide',
        audienceScene: 'Left Terminal Right Slide',
        slots: [],
        focus: 'Terminal',
        script: 'Walk through the init flow.',
      }],
    );
    assert.deepEqual(
      presenter.messages.filter((message) => message.type === 'transcript'),
      [{
        type: 'transcript',
        source: 'whisper',
        text: 'walk through',
        capturedAtMs: 1720000000000,
      }],
    );
  } finally {
    await Promise.all([stt.close(), presenter.close()]);
    await hub.stop();
  }
});
