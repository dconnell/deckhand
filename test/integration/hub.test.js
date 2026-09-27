import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';

import WebSocket from 'ws';

import { createHub } from '../../src/hub.js';
import { createCaptureLogger as createLogger } from '../helpers/logger.js';
import { waitForMessages } from '../helpers/waitFor.js';

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
    send(payload) {
      socket.send(JSON.stringify(payload));
    },
    async close() {
      socket.close();
      await once(socket, 'close');
    },
  };
}

/**
 * Poll until `predicate` holds over `messages`, using the shared helper that
 * follows the deterministic `waitForMessages` pattern from test/unit/presenter/stt/runner.test.js.
 *
 * @param {Array<unknown>} messages Array to poll (client messages or hub events).
 * @param {(messages: Array<unknown>) => boolean} predicate Condition to await.
 * @param {string} description What was being waited for, used in the timeout error.
 * @returns {Promise<void>} Resolves once the predicate holds; rejects on timeout.
 */

/**
 * Await the hub's own `registered` ack, the deterministic signal that the hub
 * finished processing a registration before the test drives the next step.
 *
 * @param {{ messages: Array<Record<string, unknown>> }} client Harness client.
 * @returns {Promise<void>}
 */
function waitForRegistered(client) {
  return waitForMessages(client.messages, (messages) => messages.some((message) => message.type === 'registered'), 'the registered ack');
}

test('hub rejects target registrations now that the role is removed', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const target = await createClient(port);

  try {
    await target.send({ type: 'register', role: 'target', controllerId: 'demo1', capabilities: ['navigate'] });
    await waitForMessages(target.messages, (messages) => messages.at(-1)?.type === 'error', 'the error reply to the rejected target registration');

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
    await waitForMessages(observer.messages, (messages) => messages.some((message) => message.type === 'presentationState'), 'the sticky presentationState replay');

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
    // Negative assertion is safe: the observer's replay above proves this
    // registration round was processed, and drivers never receive
    // presentationState.
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
    await waitForMessages(observer.messages, (messages) => messages.some((message) => message.type === 'presenterState'), 'the sticky presenterState replay');

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
    // Both clients must be registered before publishSticky so the live relay
    // and the negative assertion below are decided deterministically.
    await stateObserver.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });
    await waitForRegistered(stateObserver);
    await transcriptObserver.send({ type: 'register', role: 'observer', subscriptions: ['transcript'] });
    await waitForRegistered(transcriptObserver);

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
    await waitForMessages(stateObserver.messages, (messages) => messages.some((message) => message.type === 'presentationState'), 'the live presentationState relay');

    assert.equal(stateObserver.messages.filter((message) => message.type === 'presentationState').length, 1);
    // Negative assertion is safe: the positive relay landed on stateObserver
    // above, so the publish round has fully completed.
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
    // All three registrations must land before the transcript is sent so the
    // relay and both negative assertions below are decided deterministically.
    await sttObserver.send({ type: 'register', role: 'observer', subscriptions: ['transcript'] });
    await waitForRegistered(sttObserver);
    await teleprompterObserver.send({ type: 'register', role: 'observer', subscriptions: ['transcript'] });
    await waitForRegistered(teleprompterObserver);
    await stateObserver.send({ type: 'register', role: 'observer', subscriptions: ['presentationState'] });
    await waitForRegistered(stateObserver);

    await sttObserver.send({
      type: 'transcript',
      source: 'whisper',
      text: 'hello world',
      capturedAtMs: 1720000000000,
    });
    await waitForMessages(teleprompterObserver.messages, (messages) => messages.some((message) => message.type === 'transcript'), 'the relayed transcript');

    // Negative assertions are safe: the relay landed on teleprompterObserver
    // above, so the transcript publish round has fully completed.
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

test('hub serves multiple subscriptions over one socket', async () => {
  const logger = createLogger();
  const hub = createHub({ host: '127.0.0.1', port: 0, logger });

  await hub.start();
  const { port } = hub.getAddress();
  const presenter = await createClient(port);
  const stt = await createClient(port);

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

    await presenter.send({ type: 'register', role: 'observer', subscriptions: ['presentationState', 'transcript'] });
    await waitForRegistered(presenter);
    await stt.send({ type: 'register', role: 'observer', subscriptions: [] });
    await waitForRegistered(stt);

    await stt.send({
      type: 'transcript',
      source: 'whisper',
      text: 'walk through',
      capturedAtMs: 1720000000000,
    });

    await waitForMessages(presenter.messages, (messages) => messages.some((message) => message.type === 'presentationState'), 'the sticky presentationState replay');
    await waitForMessages(presenter.messages, (messages) => messages.some((message) => message.type === 'transcript'), 'the live transcript relay');

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
    // Negative assertion is safe: the live relay above proves the transcript
    // publish round completed, and the stt client holds no transcript
    // subscription.
    assert.deepEqual(stt.messages.filter((message) => message.type === 'transcript'), []);
  } finally {
    await Promise.all([presenter.close(), stt.close()]);
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
    await waitForMessages(driver.messages, (messages) => messages.at(-1)?.type === 'error', 'the error reply to the non-observer transcript sender');
    await waitForMessages(malformed.messages, (messages) => messages.at(-1)?.type === 'error', 'the error reply to the malformed JSON message');

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
    await waitForRegistered(observer);
    await observer.send({ type: 'driverCommand', command: { type: 'next' } });
    await waitForMessages(events, (items) => items.length >= 1, 'the observerDriverCommand event');

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
    await waitForRegistered(observer);
    await observer.send({ type: 'presenterCommand', op: 'nudge', source: 'teleprompter', delta: 1 });
    await waitForMessages(events, (items) => items.length >= 1, 'the observerPresenterCommand event');

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

test('hub preserves sourceId on relaunchSource presenter commands', async () => {
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
    await waitForRegistered(observer);
    await observer.send({ type: 'presenterCommand', op: 'relaunchSource', source: 'console', sourceId: 'Terminal' });
    await waitForMessages(events, (items) => items.length >= 1, 'the relaunchSource presenterCommand event');

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].command, {
      type: 'presenterCommand',
      op: 'relaunchSource',
      source: 'console',
      sourceId: 'Terminal',
    });
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
    await waitForRegistered(driver);
    await driver.send({
      type: 'slideManifest',
      slides: [{ id: 'intro', index: { h: 0, v: 0 }, heading: 'Intro' }],
    });
    await waitForMessages(events, (items) => items.length >= 1, 'the driverSlideManifest event');

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
    await waitForRegistered(driver);
    await driver.send({ type: 'positionSettled', eventId: 7 });
    await waitForMessages(events, (items) => items.length >= 1, 'the driverPositionSettled event');

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
    await waitForRegistered(driver);
    await hub.sendCommand({ role: 'driver' }, { type: 'next' });
    await waitForMessages(driver.messages, (messages) => messages.some((message) => message.type === 'command'), 'the command relayed to the active driver');

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
    await waitForRegistered(observer);
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
    await waitForMessages(events, (items) => items.length >= 1, 'the observerWindowBindings event');

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
    await waitForRegistered(observer);
    await observer.send({ type: 'windowSettled', seq: 12 });
    await waitForMessages(events, (items) => items.length >= 1, 'the observerWindowSettled ack event');

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

test('hub forwards window-settled frame mismatches to the coordinator event', async () => {
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
    await waitForRegistered(observer);
    const frameMismatches = [{
      source: 'Presenter',
      requested: { x: 0, y: 1120, w: 1210, h: 560 },
      observed: { x: 0, y: 900, w: 1210, h: 611 },
    }];
    await observer.send({ type: 'windowSettled', seq: 13, frameMismatches });
    await waitForMessages(events, (items) => items.length >= 1, 'the window-settled frame mismatch event');

    assert.deepEqual(events, [{
      seq: 13,
      frameMismatches,
      sender: {
        role: 'observer',
        sessionId: events[0]?.sender.sessionId,
        capabilities: [],
        subscriptions: ['presentationState'],
      },
    }]);
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
    await waitForRegistered(observer);
    const snapshot = hub.getSnapshot();

    assert.equal(snapshot.targets, undefined);
    assert.equal(snapshot.activeDriver, null);
    assert.equal(snapshot.observers.length, 1);
  } finally {
    await observer.close();
    await hub.stop();
  }
});
