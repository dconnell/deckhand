import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoordinator } from '../../../src/coordinator.js';
import {
  createConfig,
  createFakeExecutor,
  createFakeHub,
  createFakeObs,
  createLogger,
  listPublishesByChannel,
} from '../../helpers/coordinatorFixtures.js';

test('coordinator reduces driver manifests and transcripts into sticky presenter state', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor, logger });

  await coordinator.start();
  await hub.emit('driverSlideManifest', {
    manifest: {
      type: 'slideManifest',
      slides: [
        { id: 'intro', index: { h: 0, v: 0 }, heading: 'Intro' },
        { id: 'demo', index: { h: 1, v: 0 }, title: 'Live Demo' },
      ],
    },
    sender: { role: 'driver', sessionId: 'driver-1' },
  });
  await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  await hub.emit('observerTranscript', {
    transcript: {
      type: 'transcript',
      source: 'whisper',
      text: 'hello audience',
      capturedAtMs: 2_000_000_000_000,
    },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  const presenterPublishes = listPublishesByChannel(hub, 'presenterState');
  assert.ok(presenterPublishes.length >= 3, 'the manifest, position change, and transcript each publish presenter state');
  assert.deepEqual(presenterPublishes.at(-1).payload.next, {
    slideId: 'demo',
    title: 'Live Demo',
    heading: null,
    index: { h: 1, v: 0 },
  });
  assert.deepEqual(presenterPublishes.at(-1).payload.teleprompter.recentTranscript, [{
    source: 'whisper',
    text: 'hello audience',
    capturedAtMs: 2_000_000_000_000,
  }]);
});

test('coordinator applies transcripts with the current clock for delay compensation', async () => {
  const originalDateNow = Date.now;
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const config = createConfig();
  config.slides.demo.script = 'Line one.\nLine two.\nLine three.\nLine four.';
  const coordinator = createCoordinator({ config, obs, hub, executor, logger });

  try {
    await coordinator.start();
    await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });

    Date.now = () => 2_000_000_002_000;
    await hub.emit('observerTranscript', {
      transcript: {
        type: 'transcript',
        source: 'whisper',
        text: 'line one',
        capturedAtMs: 2_000_000_001_000,
      },
      sender: { role: 'observer', sessionId: 'observer-1' },
    });

    Date.now = () => 2_000_000_005_500;
    await hub.emit('observerTranscript', {
      transcript: {
        type: 'transcript',
        source: 'whisper',
        text: 'line two',
        capturedAtMs: 2_000_000_002_000,
      },
      sender: { role: 'observer', sessionId: 'observer-1' },
    });

    assert.equal(coordinator.getCurrentPresenterState().teleprompter.activeLineIndex, 3);
  } finally {
    Date.now = originalDateNow;
  }
});

test('coordinator reduces presenter commands into sticky presenter state', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  await hub.emit('observerPresenterCommand', {
    command: { type: 'presenterCommand', op: 'nudge', source: 'teleprompter', delta: 1 },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  const presenterPublishes = listPublishesByChannel(hub, 'presenterState');
  assert.ok(presenterPublishes.length >= 2, 'both the position change and the presenter command publish presenter state');
  assert.equal(presenterPublishes.at(-1).payload.teleprompter.activeLineIndex, 0);
});

test('coordinator tickPresenterState republishes elapsed timer updates', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  await hub.emit('observerPresenterCommand', {
    command: { type: 'presenterCommand', op: 'timerStart', source: 'console' },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });
  await hub.emit('observerPresenterCommand', {
    command: { type: 'presenterCommand', op: 'timerPause', source: 'console' },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });
  await hub.emit('observerPresenterCommand', {
    command: { type: 'presenterCommand', op: 'timerStart', source: 'console' },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  const beforeTick = listPublishesByChannel(hub, 'presenterState').length;
  await coordinator.tickPresenterState(Date.now() + 5_000);
  const presenterPublishes = listPublishesByChannel(hub, 'presenterState');

  assert.equal(presenterPublishes.length, beforeTick + 1);
  assert.ok(presenterPublishes.at(-1).payload.timer.elapsedMs > 0, 'the republished timer reports positive elapsed time');
});

test('coordinator tickPresenterState derives predictive follow lead from overlapping stream settings', async () => {
  const originalDateNow = Date.now;
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const config = createConfig();
  config.presenter.stt = {
    whisperBin: '/tmp/whisper-stream',
    model: '/tmp/model.bin',
    stream: {
      chunkMs: 2_000,
      overlapMs: 1_500,
    },
  };
  config.slides.demo.script = 'Line one.\nLine two.\nLine three.\nLine four.\nLine five.';
  const coordinator = createCoordinator({ config, obs, hub, executor, logger });

  try {
    await coordinator.start();
    await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });

    Date.now = () => 2_000_000_002_000;
    await hub.emit('observerTranscript', {
      transcript: {
        type: 'transcript',
        source: 'whisper',
        text: 'line one',
        capturedAtMs: 2_000_000_002_000,
      },
      sender: { role: 'observer', sessionId: 'observer-1' },
    });

    Date.now = () => 2_000_000_002_500;
    await hub.emit('observerTranscript', {
      transcript: {
        type: 'transcript',
        source: 'whisper',
        text: 'line two',
        capturedAtMs: 2_000_000_002_500,
      },
      sender: { role: 'observer', sessionId: 'observer-1' },
    });

    const beforeTick = listPublishesByChannel(hub, 'presenterState').length;
    await coordinator.tickPresenterState(2_000_000_004_000);
    const presenterPublishes = listPublishesByChannel(hub, 'presenterState');

    assert.equal(presenterPublishes.length, beforeTick + 1);
    // stream chunk/overlap resolve to stepMs=500; lead = max(500*3, 3000) = 3000,
    // so the predictor projects well past the old short-lead position.
    assert.equal(presenterPublishes.at(-1).payload.teleprompter.activeLineIndex, 4);
  } finally {
    Date.now = originalDateNow;
  }
});

test('coordinator tickPresenterState derives predictive follow lead from normalized presenter.stt.stepMs', async () => {
  const originalDateNow = Date.now;
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const config = createConfig();
  config.presenter.stt = {
    stepMs: 500,
    stream: {
      chunkMs: 2_000,
      overlapMs: 0,
    },
  };
  config.slides.demo.script = 'Line one.\nLine two.\nLine three.\nLine four.\nLine five.';
  const coordinator = createCoordinator({ config, obs, hub, executor, logger });

  try {
    await coordinator.start();
    await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });

    Date.now = () => 2_000_000_002_000;
    await hub.emit('observerTranscript', {
      transcript: {
        type: 'transcript',
        source: 'whisper',
        text: 'line one',
        capturedAtMs: 2_000_000_002_000,
      },
      sender: { role: 'observer', sessionId: 'observer-1' },
    });

    Date.now = () => 2_000_000_002_500;
    await hub.emit('observerTranscript', {
      transcript: {
        type: 'transcript',
        source: 'whisper',
        text: 'line two',
        capturedAtMs: 2_000_000_002_500,
      },
      sender: { role: 'observer', sessionId: 'observer-1' },
    });

    const beforeTick = listPublishesByChannel(hub, 'presenterState').length;
    await coordinator.tickPresenterState(2_000_000_004_000);
    const presenterPublishes = listPublishesByChannel(hub, 'presenterState');

    assert.equal(presenterPublishes.length, beforeTick + 1);
    // stepMs=500 resolves to lead = max(500*3, 3000) = 3000; the longer lead lets
    // the predictor bridge further between transcript updates than the old 500.
    assert.equal(presenterPublishes.at(-1).payload.teleprompter.activeLineIndex, 4);
  } finally {
    Date.now = originalDateNow;
  }
});

test('coordinator status polling updates preview metadata and stream summary', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor, logger });

  await coordinator.start();

  const presenterState = coordinator.getCurrentPresenterState();
  assert.ok(presenterState.obs.preview.available, 'the program preview is available after startup');
  assert.ok(presenterState.obs.preview.revision >= 1, 'the preview revision advances past the initial snapshot');
  assert.ok(presenterState.stream.active, 'the fake stream reports itself active');
  assert.equal(presenterState.stream.bitrateKbps, 3400);

  const preview = coordinator.getProgramPreviewSnapshot();
  assert.equal(preview?.etag, '"presenter-preview-1"');
  assert.deepEqual(preview?.body, Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
});

test('coordinator forwards a relaunchSource presenter command to the relaunch hook', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const relaunched = [];
  const coordinator = createCoordinator({
    config: createConfig(),
    obs,
    hub,
    executor,
    logger,
    relaunchSource: async (payload) => {
      relaunched.push(payload);
      return { sourceId: payload.sourceId, macWindowId: 999 };
    },
  });

  await coordinator.start();
  await hub.emit('observerPresenterCommand', {
    command: { type: 'presenterCommand', op: 'relaunchSource', sourceId: 'BrowserA' },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  assert.deepEqual(relaunched, [{ sourceId: 'BrowserA' }]);
});

test('coordinator logs and continues when a relaunch hook throws', async () => {
  const logger = createLogger();
  const hub = createFakeHub();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const coordinator = createCoordinator({
    config: createConfig(),
    obs,
    hub,
    executor,
    logger,
    relaunchSource: async () => {
      throw new Error('relaunch exploded');
    },
  });

  await coordinator.start();
  await assert.doesNotReject(
    hub.emit('observerPresenterCommand', {
      command: { type: 'presenterCommand', op: 'relaunchSource', sourceId: 'BrowserA' },
      sender: { role: 'observer', sessionId: 'observer-1' },
    }),
  );

  assert.ok(logger.errors.some((entry) => /failed to relaunch source/i.test(entry.message)));
  assert.ok(logger.errors.some((entry) => /relaunch exploded/i.test(entry.context?.error)));
});
