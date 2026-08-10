import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';

import WebSocket from 'ws';

import { createHub } from '../../src/hub.js';

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

async function flushMessages() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('hub rejects target registrations now that the role is removed', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const target = await createClient(port);

  try {
    await target.send({ type: 'register', role: 'target', controllerId: 'demo1', capabilities: ['navigate'] });

    assert.equal(target.messages.at(-1).type, 'error');
    assert.match(target.messages.at(-1).message, /role must be either "driver" or "observer"/i);
  } finally {
    await target.close();
    await hub.stop();
  }
});

test('hub replays the latest sticky presentation state to late-joining observers with matching subscriptions', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const observer = await createClient(port);
  const driver = await createClient(port);

  try {
    await hub.publishSticky('presentationState', {
      type: 'presentationState',
      seq: 7,
      slideId: 'intro',
      layoutId: 'full-slide',
      audienceScene: 'Full Slide',
      slots: [],
      focus: null,
      script: null,
    });

    await observer.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });
    await driver.send({ type: 'register', role: 'driver', capabilities: ['next', 'prev'] });
    await flushMessages();

    assert.deepEqual(
      observer.messages.filter((message) => message.type === 'presentationState'),
      [{
        type: 'presentationState',
        seq: 7,
        slideId: 'intro',
        layoutId: 'full-slide',
        audienceScene: 'Full Slide',
        slots: [],
        focus: null,
        script: null,
      }],
    );
    assert.deepEqual(driver.messages.filter((message) => message.type === 'presentationState'), []);
  } finally {
    await Promise.all([observer.close(), driver.close()]);
    await hub.stop();
  }
});

test('hub replays the latest sticky presenter state to late-joining observers with matching subscriptions', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const observer = await createClient(port);

  try {
    await hub.publishSticky('presenterState', {
      type: 'presenterState',
      seq: 2,
      presentationSeq: 7,
      current: {
        slideId: 'intro',
        layoutId: 'full-slide',
        focus: null,
        hidden: false,
        lines: [],
      },
      next: null,
      teleprompter: {
        followEnabled: true,
        activeLineIndex: 0,
        trackingState: 'idle',
        recentTranscript: [],
      },
      timer: { running: false, elapsedMs: 0, remainingMs: null, targetDurationMs: null },
      obs: { preview: { available: false, path: '/presenter/program.jpg', revision: 0, capturedAtMs: null, stale: true } },
      stream: { active: false, reconnecting: false, bitrateKbps: null, droppedFrames: 0, congestion: null, lastUpdateMs: null, warning: 'disconnected' },
      updatedAtMs: 1720000000000,
    });

    await observer.send({ type: 'register', role: 'observer', subscriptions: ['presenterState'] });
    await flushMessages();

    assert.equal(observer.messages.filter((message) => message.type === 'presenterState').length, 1);
  } finally {
    await observer.close();
    await hub.stop();
  }
});

test('hub publishes presentation state only to subscribed observers', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const stateObserver = await createClient(port);
  const transcriptObserver = await createClient(port);

  try {
    await stateObserver.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });
    await transcriptObserver.send({ type: 'register', role: 'observer', subscriptions: ['transcript'] });

    await hub.publishSticky('presentationState', {
      type: 'presentationState',
      seq: 8,
      slideId: 'code-walkthrough',
      layoutId: 'left-terminal-right-slide',
      audienceScene: 'Left Terminal Right Slide',
      slots: [],
      focus: 'Terminal',
      script: 'hello',
    });
    await flushMessages();

    assert.equal(stateObserver.messages.filter((message) => message.type === 'presentationState').length, 1);
    assert.equal(transcriptObserver.messages.filter((message) => message.type === 'presentationState').length, 0);
  } finally {
    await Promise.all([stateObserver.close(), transcriptObserver.close()]);
    await hub.stop();
  }
});

test('hub relays transcripts to subscribed observers and not back to the sender', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const sttObserver = await createClient(port);
  const teleprompterObserver = await createClient(port);
  const stateObserver = await createClient(port);

  try {
    await sttObserver.send({ type: 'register', role: 'observer', subscriptions: ['transcript'] });
    await teleprompterObserver.send({ type: 'register', role: 'observer', subscriptions: ['transcript'] });
    await stateObserver.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });

    await sttObserver.send({
      type: 'transcript',
      source: 'whisper',
      text: 'hello world',
      capturedAtMs: 1720000000000,
    });
    await flushMessages();

    assert.equal(sttObserver.messages.filter((message) => message.type === 'transcript').length, 0);
    assert.deepEqual(
      teleprompterObserver.messages.filter((message) => message.type === 'transcript'),
      [{
        type: 'transcript',
        source: 'whisper',
        text: 'hello world',
        capturedAtMs: 1720000000000,
      }],
    );
    assert.deepEqual(stateObserver.messages.filter((message) => message.type === 'transcript'), []);
  } finally {
    await Promise.all([sttObserver.close(), teleprompterObserver.close(), stateObserver.close()]);
    await hub.stop();
  }
});

test('hub rejects non-observer transcript senders and malformed messages without crashing', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const driver = await createClient(port);
  const malformed = await createClient(port);

  try {
    await driver.send({ type: 'register', role: 'driver', capabilities: ['next', 'prev'] });
    await driver.send({
      type: 'transcript',
      source: 'whisper',
      text: 'should fail',
      capturedAtMs: 1720000000001,
    });
    malformed.socket.send('{not-json');
    await flushMessages();

    assert.equal(driver.messages.at(-1).type, 'error');
    assert.match(driver.messages.at(-1).message, /Only observer clients/i);
    assert.equal(malformed.messages.at(-1).type, 'error');
  } finally {
    await Promise.all([driver.close(), malformed.close()]);
    await hub.stop();
  }
});

test('hub emits observer driverCommand events for the coordinator to forward', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });
  const events = [];
  hub.on('observerDriverCommand', (payload) => {
    events.push(payload);
  });

  await hub.start();
  const { port } = hub.getAddress();
  const driver = await createClient(port);
  const observer = await createClient(port);

  try {
    await driver.send({ type: 'register', role: 'driver', capabilities: ['next', 'prev', 'goTo'] });
    await observer.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });
    await observer.send({ type: 'driverCommand', command: { type: 'next' } });
    await flushMessages();

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].command, { type: 'next' });
    assert.equal(events[0].sender.role, 'observer');
  } finally {
    await Promise.all([driver.close(), observer.close()]);
    await hub.stop();
  }
});

test('hub emits observer presenterCommand events for the coordinator to reduce', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });
  const events = [];
  hub.on('observerPresenterCommand', (payload) => {
    events.push(payload);
  });

  await hub.start();
  const { port } = hub.getAddress();
  const observer = await createClient(port);

  try {
    await observer.send({ type: 'register', role: 'observer', subscriptions: ['presenterState'] });
    await observer.send({ type: 'presenterCommand', op: 'nudge', source: 'teleprompter', delta: 1 });
    await flushMessages();

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].command, {
      type: 'presenterCommand',
      op: 'nudge',
      source: 'teleprompter',
      delta: 1,
    });
    assert.equal(events[0].sender.role, 'observer');
  } finally {
    await observer.close();
    await hub.stop();
  }
});

test('hub emits driver slideManifest events from registered drivers', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });
  const events = [];
  hub.on('driverSlideManifest', (payload) => {
    events.push(payload);
  });

  await hub.start();
  const { port } = hub.getAddress();
  const driver = await createClient(port);

  try {
    await driver.send({ type: 'register', role: 'driver', capabilities: ['next', 'prev', 'goTo'] });
    await driver.send({
      type: 'slideManifest',
      slides: [{ id: 'intro', index: { h: 0, v: 0 }, heading: 'Intro' }],
    });
    await flushMessages();

    assert.equal(events.length, 1);
    assert.equal(events[0].manifest.type, 'slideManifest');
    assert.equal(events[0].sender.role, 'driver');
  } finally {
    await driver.close();
    await hub.stop();
  }
});

test('hub emits driver position-settled events from registered drivers', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });
  const events = [];
  hub.on('driverPositionSettled', (payload) => {
    events.push(payload);
  });

  await hub.start();
  const { port } = hub.getAddress();
  const driver = await createClient(port);

  try {
    await driver.send({ type: 'register', role: 'driver', capabilities: ['next', 'prev', 'goTo'] });
    await driver.send({ type: 'positionSettled', eventId: 7 });
    await flushMessages();

    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 7);
    assert.equal(events[0].sender.role, 'driver');
  } finally {
    await driver.close();
    await hub.stop();
  }
});

test('hub sendCommand routes driver-bound commands to the active driver only', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const driver = await createClient(port);

  try {
    await driver.send({ type: 'register', role: 'driver', capabilities: ['next', 'prev'] });
    await hub.sendCommand({ role: 'driver' }, { type: 'next' });
    await flushMessages();

    assert.deepEqual(
      driver.messages.filter((message) => message.type === 'command').map((message) => message.command),
      [{ type: 'next' }],
    );
  } finally {
    await driver.close();
    await hub.stop();
  }
});

test('hub sendCommand rejects non-driver targets', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();

  try {
    await assert.rejects(
      hub.sendCommand({ role: 'observer' }, { type: 'next' }),
      /only supports the driver boundary/i,
    );
  } finally {
    await hub.stop();
  }
});

test('hub emits observer window binding updates for registered observers', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });
  const events = [];
  hub.on('observerWindowBindings', (payload) => {
    events.push(payload);
  });

  await hub.start();
  const { port } = hub.getAddress();
  const observer = await createClient(port);

  try {
    await observer.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });
    await observer.send({
      type: 'windowBindings',
      bindings: {
        BrowserA: {
          app: 'Google Chrome',
          pid: 47213,
          macWindowId: 12345,
          strict: true,
        },
      },
      cleared: ['BrowserB'],
    });
    await flushMessages();

    assert.deepEqual(events, [{
      bindings: {
        BrowserA: {
          app: 'Google Chrome',
          pid: 47213,
          macWindowId: 12345,
          strict: true,
        },
      },
      cleared: ['BrowserB'],
      sender: {
        role: 'observer',
        sessionId: events[0]?.sender.sessionId,
        capabilities: [],
        subscriptions: ['presentationState'],
      },
    }]);
    assert.match(events[0].sender.sessionId, /^[0-9a-f-]+$/i);
  } finally {
    await observer.close();
    await hub.stop();
  }
});

test('hub emits observer window-settled acks keyed by presentation seq', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });
  const events = [];
  hub.on('observerWindowSettled', (payload) => {
    events.push(payload);
  });

  await hub.start();
  const { port } = hub.getAddress();
  const observer = await createClient(port);

  try {
    await observer.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });
    await observer.send({ type: 'windowSettled', seq: 12 });
    await flushMessages();

    assert.deepEqual(events, [{
      seq: 12,
      sender: {
        role: 'observer',
        sessionId: events[0]?.sender.sessionId,
        capabilities: [],
        subscriptions: ['presentationState'],
      },
    }]);
    assert.match(events[0].sender.sessionId, /^[0-9a-f-]+$/i);
  } finally {
    await observer.close();
    await hub.stop();
  }
});

test('hub snapshot no longer exposes a target catalog', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const observer = await createClient(port);

  try {
    await observer.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });
    const snapshot = hub.getSnapshot();

    assert.deepEqual(Object.keys(snapshot).sort(), ['activeDriver', 'observers', 'sticky']);
    assert.equal(snapshot.activeDriver, null);
    assert.equal(snapshot.observers.length, 1);
  } finally {
    await observer.close();
    await hub.stop();
  }
});
