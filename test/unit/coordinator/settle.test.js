import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoordinator } from '../../../src/coordinator.js';
import {
  createLogger,
  createTracingExecutor,
  createTracingHub,
  createTracingObs,
  createTransitionsConfig,
} from '../../helpers/coordinatorFixtures.js';

test('coordinator gates the reveal on the presenter window-settle ack', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 2000 });
  const hub = createTracingHub(trace);

  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();

  // 'demo' is the first position change -> seq 1. The mutate publishes then
  // blocks awaiting the windowSettle ack for seq 1. Awaiting the publish is
  // deterministic: the settle waiter is registered before the publish, so once
  // the publish lands the waiter is guaranteed armed.
  const pending = coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  const publish = await hub.waitForPublish('presentationState', ({ payload }) => payload.seq === 1);

  assert.equal(publish.payload.seq, 1, 'presentation state is published before the reveal');
  assert.ok(!trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'reveal must wait for the settle ack');

  hub.emit('observerWindowSettled', { seq: 1 });
  await pending;

  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'reveal proceeds once the ack arrives');
});

test('coordinator warns once per distinct presenter frame mismatch', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 2000 });
  const hub = createTracingHub(trace);

  const logger = createLogger();
  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();

  const mismatches = [
    {
      source: 'Presenter',
      requested: { x: 0, y: 1120, w: 1210, h: 560 },
      observed: { x: 0, y: 900, w: 1210, h: 611 },
    },
    {
      source: 'Console',
      requested: { x: 40, y: 40, w: 480, h: 720 },
      observed: { x: 40, y: 40, w: 620, h: 720 },
    },
  ];

  const first = coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  await hub.waitForPublish('presentationState', ({ payload }) => payload.seq === 1);
  hub.emit('observerWindowSettled', { seq: 1, frameMismatches: mismatches });
  await first;

  assert.equal(logger.warns.length, 2, 'one warning per mismatch entry');
  assert.equal(logger.warns[0].message, 'Window did not settle to configured rect');
  assert.deepEqual(logger.warns[0].context, { source: 'Presenter', requested: mismatches[0].requested, observed: mismatches[0].observed });
  assert.deepEqual(logger.warns[1].context, { source: 'Console', requested: mismatches[1].requested, observed: mismatches[1].observed });

  // Slide advances re-apply identical rects, so the same ack on a later seq
  // must not repeat the warnings.
  const second = coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  await hub.waitForPublish('presentationState', ({ payload }) => payload.seq === 2);
  hub.emit('observerWindowSettled', { seq: 2, frameMismatches: mismatches });
  await second;

  assert.equal(logger.warns.length, 2, 'the same mismatch warns only once per process');
});

test('coordinator warns separately for mismatches that differ only in requested origin', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 2000 });
  const hub = createTracingHub(trace);

  const logger = createLogger();
  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();

  // Same source, same requested size, and the same clamped result — only the
  // requested origin differs (e.g. a source applied to a left-slot rect and a
  // right-slot rect that both clamp to the same place). These are distinct
  // mismatches and must each warn.
  const mismatches = [
    {
      source: 'Presenter',
      requested: { x: 0, y: 1120, w: 1210, h: 560 },
      observed: { x: 0, y: 900, w: 1210, h: 611 },
    },
    {
      source: 'Presenter',
      requested: { x: 660, y: 1120, w: 1210, h: 560 },
      observed: { x: 0, y: 900, w: 1210, h: 611 },
    },
  ];

  const first = coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  await hub.waitForPublish('presentationState', ({ payload }) => payload.seq === 1);
  hub.emit('observerWindowSettled', { seq: 1, frameMismatches: mismatches });
  await first;

  assert.equal(logger.warns.length, 2, 'a mismatch at a second requested origin warns again');
  assert.deepEqual(logger.warns[0].context.requested, mismatches[0].requested);
  assert.deepEqual(logger.warns[1].context.requested, mismatches[1].requested);

  // Replaying the identical ack on a later seq must still not warn again.
  const second = coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  await hub.waitForPublish('presentationState', ({ payload }) => payload.seq === 2);
  hub.emit('observerWindowSettled', { seq: 2, frameMismatches: mismatches });
  await second;

  assert.equal(logger.warns.length, 2, 'identical mismatches still dedupe to one warning each');
});

test('coordinator warns once per process when the presenter skipped window placement', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 2000 });
  const hub = createTracingHub(trace);

  const logger = createLogger();
  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();

  const first = coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  await hub.waitForPublish('presentationState', ({ payload }) => payload.seq === 1);
  hub.emit('observerWindowSettled', { seq: 1, placementSkipped: { reason: 'display-arrangement-mismatch' } });
  await first;

  assert.equal(logger.warns.length, 1, 'one warning when the ack reports a placement skip');
  assert.equal(
    logger.warns[0].message,
    'Window placement skipped: configured stage/overlay rects do not fit the current display arrangement; windows left as launched and presenter overlays kept back',
  );
  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'the skip must not suppress the reveal');

  // Every later slide re-acks the same skip; no per-slide spam.
  const second = coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  await hub.waitForPublish('presentationState', ({ payload }) => payload.seq === 2);
  hub.emit('observerWindowSettled', { seq: 2, placementSkipped: { reason: 'display-arrangement-mismatch' } });
  await second;

  assert.equal(logger.warns.length, 1, 'placement-skip warnings dedupe to once per process');
});

test('coordinator resolves the settle waiter without warnings when the ack carries no frame mismatches', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 2000 });
  const hub = createTracingHub(trace);

  const logger = createLogger();
  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();

  const pending = coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  await hub.waitForPublish('presentationState', ({ payload }) => payload.seq === 1);
  hub.emit('observerWindowSettled', { seq: 1 });
  await pending;

  assert.equal(logger.warns.length, 0, 'an ack without frameMismatches warns nothing');
  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'the waiter still resolves without frameMismatches');
});

test('coordinator gates the reveal on the driver position-settle ack', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 2000 });
  config.presenter = null;
  const hub = createTracingHub(trace);

  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();

  // Staging is synchronous: the position cannot process until its settle ack
  // arrives, so the negative assertion holds deterministically without a wait.
  const pending = coordinator.handleDriverPositionChanged({
    id: 'intro',
    index: { h: 0, v: 0 },
    meta: { driverEventId: 17 },
  });

  assert.ok(!trace.includes('switchProgramScene:Deckhand_Full Slide'), 'reveal must wait for the driver settle ack');

  hub.emit('driverPositionSettled', { eventId: 17 });
  await pending;

  assert.ok(trace.includes('switchProgramScene:Deckhand_Full Slide'), 'reveal proceeds once the driver settle ack arrives');
});

test('coordinator processes only the latest staged driver position once it settles', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 2000 });
  config.presenter = null;
  const hub = createTracingHub(trace);

  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();

  // Staging is synchronous: positions with a driverEventId register in the
  // staging map and cannot process before their settle ack arrives, so the
  // negative assertions below hold without any wait.
  const first = hub.emit('driverPositionChanged', {
    id: 'intro',
    index: { h: 0, v: 0 },
    meta: { driverEventId: 1 },
  });
  const second = hub.emit('driverPositionChanged', {
    id: 'demo',
    index: { h: 1, v: 0 },
    meta: { driverEventId: 2 },
  });
  const third = hub.emit('driverPositionChanged', {
    id: 'demo',
    index: { h: 1, v: 0 },
    meta: { driverEventId: 3 },
  });

  assert.ok(!trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'staged positions do not reveal before settle');
  assert.ok(!trace.includes('switchProgramScene:Deckhand_Full Slide'), 'older staged positions do not reveal before settle');

  hub.emit('driverPositionSettled', { eventId: 3 });
  await Promise.all([first, second, third]);

  assert.equal(trace.filter((entry) => entry === 'publishSticky').length, 1, 'only one staged position is processed');
  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'the latest settled position is revealed');
  assert.ok(!trace.includes('switchProgramScene:Deckhand_Full Slide'), 'older staged positions are skipped');
});

test('coordinator cuts to the freeze before forwarding observer driver commands', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 2000 });
  config.presenter = null;

  const hub = {
    ...createTracingHub(trace, { activeDriver: { role: 'driver', sessionId: 'driver-1' } }),
    async sendCommand(_target, command) {
      trace.push(`sendCommand:${command.type}`);
      return [{ role: 'driver', sessionId: 'driver-1' }];
    },
  };

  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  trace.length = 0;

  await hub.emit('observerDriverCommand', {
    command: { type: 'next' },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  const freezeIndex = trace.indexOf('switchProgramScene:Freeze');
  const sendCommandIndex = trace.indexOf('sendCommand:next');

  assert.ok(freezeIndex !== -1 && sendCommandIndex !== -1, 'freeze and driver command both occur');
  assert.ok(freezeIndex < sendCommandIndex, 'freeze is shown before the driver deck advances');

  // Staged positions cannot process before their settle ack, so emitting the
  // ack immediately is deterministic and resolves the staged advance.
  const pending = hub.emit('driverPositionChanged', {
    id: 'demo',
    index: { h: 1, v: 0 },
    meta: { driverEventId: 17 },
  });
  hub.emit('driverPositionSettled', { eventId: 17 });
  await pending;
});
