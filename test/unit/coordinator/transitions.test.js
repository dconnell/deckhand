import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoordinator } from '../../../src/coordinator.js';
import { deckhandInputName } from '../../../src/obsNames.js';
import {
  createConfig,
  createFakeExecutor,
  createFakeObs,
  createLogger,
  createTracingExecutor,
  createTracingHub,
  createTracingObs,
  createTransitionsConfig,
} from '../../helpers/coordinatorFixtures.js';

test('coordinator ensures freeze assets at startup when transitions are configured', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();

  assert.ok(trace.includes('ensureFreezeAssets:10'), 'ensures freeze assets with the configured dim percent');
});

test('coordinator alternates freeze image file paths so OBS reloads each re-arm', async () => {
  const appliedFiles = [];
  const config = createTransitionsConfig({ freezeImagePath: '/tmp/deckhand-freeze-frame.png' });
  config.presenter = null;

  const obs = {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    async applyInputSettings(name, settings) {
      if (name === 'Freeze Frame' && typeof settings.file === 'string') {
        appliedFiles.push(settings.file);
      }
    },
    async getCurrentTransitionName() {
      return 'Fade';
    },
    async captureProgramScreenshot() {},
    async setCurrentTransition() {},
    async switchProgramScene() {},
    async waitForSceneTransitionEnd() {},
    async ensureFreezeAssets() {},
  };

  const coordinator = createCoordinator({
    config,
    obs,
    hub: createTracingHub([]),
    executor: createTracingExecutor([]),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(appliedFiles.some((file) => file.endsWith('-0.png')), 'the first re-arm writes the -0 freeze file');
  assert.ok(appliedFiles.some((file) => file.endsWith('-1.png')), 'the next re-arm alternates to the -1 freeze file');
});

/**
 * Extend the transitions fixture with a minimal app-window source, layout, and
 * slide so an advance can target a scene whose only slot is an `app` capture.
 *
 * @param {{ appScreenshot: () => Promise<string> }} options Probe behavior for the app source's deckhand input.
 * @returns {{ config: ReturnType<typeof createTransitionsConfig>, appInputName: string }}
 */
function createAppSlideTransitionsConfig({ appScreenshot }) {
  const config = createTransitionsConfig();
  config.presenter = null;
  config.sources.Editor = { id: 'Editor', kind: 'app', app: 'Visual Studio Code' };
  config.layouts['editor-view'] = {
    id: 'editor-view',
    audienceScene: 'Editor View',
    slots: [{ source: 'Editor', position: 'full' }],
    sources: ['Editor'],
  };
  config.slides.editor = {
    layoutId: 'editor-view',
    focus: null,
    script: null,
    commands: [],
  };

  return { config, appInputName: deckhandInputName('Editor'), appScreenshot };
}

test('coordinator keeps the last good freeze frame when an app source cannot be screenshotted', async () => {
  const trace = [];
  const logger = createLogger();
  const harness = createAppSlideTransitionsConfig({
    // App-window captures can fail to render in OBS offscreen screenshot
    // requests; surface that here so the coordinator probe must detect it.
    appScreenshot: async () => {
      throw new Error('Failed to render screenshot.');
    },
  });
  const obs = {
    ...createTracingObs(trace),
    async getSourceScreenshotData(sourceName) {
      trace.push(`getSourceScreenshotData:${sourceName}`);

      if (sourceName === harness.appInputName) {
        return harness.appScreenshot();
      }

      return 'data:image/png;base64,AAAA';
    },
  };

  const coordinator = createCoordinator({
    config: harness.config,
    obs,
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'editor', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes(`getSourceScreenshotData:${harness.appInputName}`), 'probes the app source directly');
  assert.ok(!trace.includes('applyInputSettings:Freeze Frame'), 'freeze input keeps pointing at the last good file');
  assert.ok(
    logger.warns.some((entry) => entry.message === 'Freeze frame may render black; keeping the last good freeze frame'
      && entry.context?.source === 'Editor'),
    'warns about the unreliable app source',
  );
  assert.ok(trace.includes('switchProgramScene:Deckhand_Editor View'), 'the advance still reveals the audience scene');
});

test('coordinator keeps the last good freeze frame when an app source probe returns an empty image payload', async () => {
  const trace = [];
  const logger = createLogger();
  const harness = createAppSlideTransitionsConfig({
    // A bare data-URI prefix decodes to a zero-byte image; the probe must
    // treat it as empty, matching the decoded-buffer check in the obs client.
    appScreenshot: async () => 'data:image/png;base64,',
  });
  const obs = {
    ...createTracingObs(trace),
    async getSourceScreenshotData(sourceName) {
      trace.push(`getSourceScreenshotData:${sourceName}`);

      if (sourceName === harness.appInputName) {
        return harness.appScreenshot();
      }

      return 'data:image/png;base64,AAAA';
    },
  };

  const coordinator = createCoordinator({
    config: harness.config,
    obs,
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'editor', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes(`getSourceScreenshotData:${harness.appInputName}`), 'probes the app source directly');
  assert.ok(!trace.includes('applyInputSettings:Freeze Frame'), 'freeze input keeps pointing at the last good file');
  assert.ok(
    logger.warns.some((entry) => entry.message === 'Freeze frame may render black; keeping the last good freeze frame'
      && entry.context?.source === 'Editor'),
    'warns about the unreliable app source',
  );
  assert.ok(trace.includes('switchProgramScene:Deckhand_Editor View'), 'the advance still reveals the audience scene');
});

test('coordinator re-arms the freeze frame when the app source screenshot probe succeeds', async () => {
  const trace = [];
  const logger = createLogger();
  const harness = createAppSlideTransitionsConfig({
    appScreenshot: async () => 'data:image/png;base64,AAAA',
  });
  const obs = {
    ...createTracingObs(trace),
    async getSourceScreenshotData(sourceName) {
      trace.push(`getSourceScreenshotData:${sourceName}`);

      if (sourceName === harness.appInputName) {
        return harness.appScreenshot();
      }

      return 'data:image/png;base64,AAAA';
    },
  };

  const coordinator = createCoordinator({
    config: harness.config,
    obs,
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'editor', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes(`getSourceScreenshotData:${harness.appInputName}`), 'probes the app source directly');
  assert.ok(trace.includes('applyInputSettings:Freeze Frame'), 'a reliable probe still re-arms the freeze frame');
  assert.ok(
    !logger.warns.some((entry) => entry.message === 'Freeze frame may render black; keeping the last good freeze frame'),
    'no warning is logged when the probe succeeds',
  );
});

test('coordinator does not re-apply identical OBS window bindings across slide changes', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    getManagedBrowserPid: () => 47213,
    getManagedWindowBindings: () => ({
      BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary', macWindowId: 12345, pid: 47213, strict: true },
    }),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  const firstCount = trace.filter((entry) => entry === 'applyInputSettings:Deckhand_BrowserA').length;
  assert.equal(firstCount, 1, 'applies the window binding on the first slide change');

  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 2, v: 0 }, meta: {} });

  const secondCount = trace.filter((entry) => entry === 'applyInputSettings:Deckhand_BrowserA').length;
  assert.equal(secondCount, 0, 'skips re-applying an identical window binding to avoid resetting the OBS capture');
});

test('coordinator runs freeze -> mutate -> directional reveal for a forward jump', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  const freezeIndex = trace.indexOf('switchProgramScene:Freeze');
  const revealIndex = trace.indexOf('switchProgramScene:Deckhand_Dual Browser');
  const publishIndex = trace.indexOf('publishSticky');

  assert.ok(freezeIndex !== -1 && revealIndex !== -1, 'freeze and reveal scene switches both occur');
  assert.ok(freezeIndex < publishIndex, 'state publishes only after the freeze scene is showing');
  assert.ok(publishIndex < revealIndex, 'dirty work completes before the reveal');

  const captureIndex = trace.indexOf('captureProgramScreenshot');
  const freezeLoadIndex = trace.indexOf('applyInputSettings:Freeze Frame');
  assert.ok(captureIndex !== -1, 're-arms the freeze after the reveal');
  assert.ok(freezeLoadIndex !== -1, 'loads the freeze image source when re-arming');

  const captureCount = trace.filter((entry) => entry === 'captureProgramScreenshot').length;
  assert.equal(captureCount, 1, 're-arms exactly once after the reveal');

  assert.ok(trace.includes('setCurrentTransition:Cut'), 'cuts to the freeze instantly');
  assert.ok(trace.includes('setCurrentTransition:Slide Right'), 'reveals with the forward transition');

  const cutIndex = trace.indexOf('setCurrentTransition:Cut');
  const forwardIndex = trace.indexOf('setCurrentTransition:Slide Right');
  assert.ok(cutIndex < forwardIndex, 'cut happens before the directional reveal');

  const transitionEndIndex = trace.indexOf('waitForSceneTransitionEnd');
  assert.ok(transitionEndIndex > revealIndex, 'waits for the transition to end after the reveal');
  assert.ok(captureIndex > transitionEndIndex, 'captures the next freeze frame only after the reveal settles');
  assert.ok(freezeLoadIndex > captureIndex, 'loads the re-armed freeze image after capturing it');
});

test('coordinator picks the backward transition for a prev jump and restores the operator transition', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 2, v: 0 }, meta: {} });
  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });

  assert.ok(trace.includes('setCurrentTransition:Slide Left'), 'reveals with the backward transition');
  assert.ok(trace.includes('setCurrentTransition:Fade'), 'restores the captured operator transition');
  const restoreIndex = trace.lastIndexOf('setCurrentTransition:Fade');
  const revealIndex = trace.indexOf('switchProgramScene:Deckhand_Full Slide');
  assert.ok(restoreIndex > revealIndex, 'transition is restored after the reveal');
});

test('coordinator continues after partial executor failures', async () => {
  const logger = createLogger();
  const obs = createFakeObs();
  const executor = createFakeExecutor();
  const hub = createTracingHub([]);
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor, logger });

  await coordinator.start();
  executor.state.nextError = new Error('browser session degraded');
  await hub.emit('driverPositionChanged', { id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Deckhand_Dual Browser']);
  assert.equal(executor.state.executedCommands.length, 2);
  assert.match(logger.errors[0].message, /Browser command failed/i);
});

test('coordinator runs without an executor for audience-only slides', async () => {
  const logger = createLogger();
  const obs = createFakeObs();
  const hub = createTracingHub([]);
  const coordinator = createCoordinator({ config: createConfig(), obs, hub, executor: null, logger });

  await coordinator.start();
  await hub.emit('driverPositionChanged', { id: 'intro', index: { h: 0, v: 0 }, meta: {} });

  assert.deepEqual(obs.state.scenes, ['Deckhand_Full Slide']);
});

test('coordinator waits for visible audience-source screenshots to stabilize before reveal', async () => {
  const trace = [];
  const config = createTransitionsConfig();
  config.presenter = null;

  const obs = {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    async applyInputSettings(name) {
      trace.push(`applyInputSettings:${name}`);
    },
    async getCurrentTransitionName() {
      return 'Fade';
    },
    async captureProgramScreenshot() {
      trace.push('captureProgramScreenshot');
    },
    async setCurrentTransition(name) {
      trace.push(`setCurrentTransition:${name}`);
    },
    async switchProgramScene(name) {
      trace.push(`switchProgramScene:${name}`);
    },
    async waitForSceneTransitionEnd() {
      trace.push('waitForSceneTransitionEnd');
    },
    async ensureFreezeAssets() {},
    async waitForSourceScreenshotStable(sourceName) {
      trace.push(`waitForSourceScreenshotStable:${sourceName}`);
    },
  };

  const coordinator = createCoordinator({
    config,
    obs,
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes('waitForSourceScreenshotStable:Deckhand_BrowserA'), 'waits for the BrowserA source to stabilize');
  assert.ok(trace.includes('waitForSourceScreenshotStable:Deckhand_BrowserB'), 'waits for the BrowserB source to stabilize');
  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'reveal still lands on the target program scene after source stabilization');
});

test('coordinator reveals via the window-settle timeout fallback when no ack arrives', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 5 });

  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'reveal proceeds after the fallback timeout');
});

test('coordinator skips the window-settle wait when no presenter is configured', async () => {
  const trace = [];
  const config = createTransitionsConfig({ windowSettleMs: 2000 });
  config.presenter = null;

  const coordinator = createCoordinator({
    config,
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  // With no presenter the settle wait is skipped, so this resolves promptly
  // even though windowSettleMs is large and no ack is ever emitted.
  const start = Date.now();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, 'does not block on the settle timeout when there is no presenter');
  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'still reveals the target scene');
});

test('coordinator treats a freeze capture failure as best-effort and still reveals the target', async () => {
  const trace = [];
  const logger = createLogger();
  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs: createTracingObs(trace, { failCapture: true }),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'still reveals the target scene');
  assert.ok(trace.includes('setCurrentTransition:Fade'), 'restores the operator transition');
  assert.ok(logger.warns.some((entry) => /arm freeze frame/i.test(entry.message)), 'warns about the failed freeze arm');
});

test('coordinator falls back to a direct scene switch when the reveal itself fails', async () => {
  const trace = [];
  const logger = createLogger();
  const obs = createTracingObs(trace);
  // The reveal switch passes { waitForEvent: true }; the fallback passes none.
  const realSwitch = obs.switchProgramScene;
  obs.switchProgramScene = async (name, opts) => {
    if (opts && opts.waitForEvent && name === 'Deckhand_Dual Browser') {
      throw new Error('reveal rejected');
    }

    return realSwitch(name);
  };

  const coordinator = createCoordinator({
    config: createTransitionsConfig(),
    obs,
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'attempts the reveal');
  assert.ok(trace.includes('setCurrentTransition:Fade'), 'restores the operator transition after failure');
  assert.ok(logger.errors.some((entry) => /Slide transition failed/i.test(entry.message)), 'logs the transition failure');
});

function createSameSceneTransitionsConfig() {
  const config = createTransitionsConfig();
  config.slides['demo-clean'] = {
    layoutId: 'dual-browser',
    focus: null,
    script: null,
    commands: [],
  };
  config.slides['intro-clean'] = {
    layoutId: 'full-slide',
    focus: null,
    script: null,
    commands: [],
  };
  return config;
}

test('coordinator skips the audience transition for same-scene advances without commands', async () => {
  const trace = [];
  const publishes = [];
  const coordinator = createCoordinator({
    config: createSameSceneTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace, { publishes }),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  assert.ok(trace.includes('switchProgramScene:Freeze'), 'the first advance still runs the full sequence');

  trace.length = 0;
  publishes.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'demo-clean', index: { h: 2, v: 0 }, meta: {} });

  assert.ok(!trace.includes('switchProgramScene:Freeze'), 'no freeze for an unchanged audience frame');
  assert.ok(!trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'no program-scene switch when the scene and slots are unchanged');
  assert.ok(!trace.includes('setCurrentTransition:Cut'), 'no freeze cut when the OBS program is untouched');
  assert.ok(!trace.some((entry) => entry.startsWith('execute:')), 'no browser commands are dispatched');

  const publish = publishes.find(({ channel }) => channel === 'presentationState');
  assert.ok(publish, 'a sticky presentation-state publish still occurs');
  assert.equal(publish.payload.slideId, 'demo-clean', 'the publish carries the incoming slide id');
  assert.equal(publish.payload.audienceScene, 'Dual Browser', 'the publish resolves to the same audience scene');
});

test('coordinator still runs the freeze -> reveal sequence for same-scene advances with commands', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createSameSceneTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo-clean', index: { h: 2, v: 0 }, meta: {} });

  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes('switchProgramScene:Freeze'), 'browser commands force the freeze');
  assert.ok(trace.includes('switchProgramScene:Deckhand_Dual Browser'), 'browser commands force the reveal');
  assert.ok(trace.includes('execute:activateTab'), 'browser commands dispatch behind the freeze');
});

test('coordinator still runs the freeze -> reveal sequence when the audience scene changes', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createSameSceneTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo-clean', index: { h: 2, v: 0 }, meta: {} });

  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });

  assert.ok(trace.includes('switchProgramScene:Freeze'), 'a scene change still freezes first');
  assert.ok(trace.includes('switchProgramScene:Deckhand_Full Slide'), 'a scene change still reveals the new scene');
});

test('coordinator still reveals the audience scene when a frozen observer driver command is in flight', async () => {
  const trace = [];
  const publishes = [];

  const hub = {
    ...createTracingHub(trace, {
      activeDriver: { role: 'driver', sessionId: 'driver-1' },
      publishes,
    }),
    async sendCommand(_target, command) {
      trace.push(`sendCommand:${command.type}`);
      return [{ role: 'driver', sessionId: 'driver-1' }];
    },
  };

  const coordinator = createCoordinator({
    config: createSameSceneTransitionsConfig(),
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  trace.length = 0;

  await hub.emit('observerDriverCommand', {
    command: { type: 'next' },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  const freezeIndex = trace.indexOf('switchProgramScene:Freeze');
  assert.ok(freezeIndex !== -1, 'the observer driver command cuts to the freeze');

  publishes.length = 0;
  // Staged positions cannot process before their settle ack, so emitting the
  // ack immediately is deterministic.
  const pending = hub.emit('driverPositionChanged', {
    id: 'demo-clean',
    index: { h: 2, v: 0 },
    meta: { driverEventId: 21 },
  });
  hub.emit('driverPositionSettled', { eventId: 21 });
  await pending;

  const revealIndex = trace.indexOf('switchProgramScene:Deckhand_Dual Browser');
  assert.ok(revealIndex !== -1, 'the frozen advance still reveals the audience scene');
  assert.ok(freezeIndex < revealIndex, 'the reveal follows the freeze instead of stranding the audience on Freeze');

  const publish = publishes.find(({ channel }) => channel === 'presentationState');
  assert.ok(publish, 'a sticky presentation-state publish still occurs');
  assert.equal(publish.payload.slideId, 'demo-clean', 'the publish carries the incoming slide id');
});

test('coordinator cuts straight back when a pre-frozen advance cannot change the audience frame', async () => {
  const trace = [];
  const publishes = [];

  const hub = {
    ...createTracingHub(trace, {
      activeDriver: { role: 'driver', sessionId: 'driver-1' },
      publishes,
    }),
    async sendCommand(_target, command) {
      trace.push(`sendCommand:${command.type}`);
      return [{ role: 'driver', sessionId: 'driver-1' }];
    },
  };

  const coordinator = createCoordinator({
    config: createSameSceneTransitionsConfig(),
    obs: createTracingObs(trace),
    hub,
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  trace.length = 0;

  // The observer command pre-freezes the audience before forwarding `next`,
  // then the driver reports the resulting position.
  await hub.emit('observerDriverCommand', {
    command: { type: 'next' },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  const freezeIndex = trace.indexOf('switchProgramScene:Freeze');
  assert.ok(freezeIndex !== -1, 'the observer driver command cuts to the freeze');

  publishes.length = 0;
  const pending = hub.emit('driverPositionChanged', {
    id: 'demo-clean',
    index: { h: 2, v: 0 },
    meta: { driverEventId: 31 },
  });
  hub.emit('driverPositionSettled', { eventId: 31 });
  await pending;

  assert.equal(
    trace.filter((entry) => entry === 'switchProgramScene:Freeze').length,
    1,
    'the pre-freeze is the only freeze: the unchanged audience frame must not freeze again',
  );
  assert.ok(
    !trace.includes('setCurrentTransition:Slide Right'),
    'no directional transition runs when the audience frame cannot change',
  );
  assert.ok(
    !trace.some((entry) => entry.startsWith('triggerStudioModeTransition:')),
    'no studio-mode reveal fires for the incoming slide',
  );

  const cutBackIndex = trace.indexOf('switchProgramScene:Deckhand_Dual Browser');
  assert.ok(cutBackIndex !== -1, 'the audience scene is cut back to directly');
  assert.ok(freezeIndex < cutBackIndex, 'the cut-back follows the pre-freeze instead of stranding the audience on Freeze');
  assert.ok(trace.includes('setCurrentTransition:Fade'), 'the cut-back restores the operator default transition');

  const publish = publishes.find(({ channel }) => channel === 'presentationState');
  assert.ok(publish, 'a sticky presentation-state publish still occurs');
  assert.equal(publish.payload.slideId, 'demo-clean', 'the publish carries the incoming slide id');
  assert.equal(publish.payload.audienceScene, 'Dual Browser', 'the publish resolves to the same audience scene');
});

test('coordinator still runs the full masked transition when a Slide-source slot changes slide id', async () => {
  const trace = [];
  const coordinator = createCoordinator({
    config: createSameSceneTransitionsConfig(),
    obs: createTracingObs(trace),
    hub: createTracingHub(trace),
    executor: createTracingExecutor(trace),
    logger: createLogger(),
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'intro', index: { h: 0, v: 0 }, meta: {} });
  trace.length = 0;
  await coordinator.handleDriverPositionChanged({ id: 'intro-clean', index: { h: 1, v: 0 }, meta: {} });

  assert.ok(trace.includes('switchProgramScene:Freeze'), 'the driver deck surface is audience-visible, so the slide change still freezes');
  assert.ok(trace.includes('setCurrentTransition:Slide Right'), 'the driver deck slide change still reveals directionally');
  assert.ok(trace.includes('switchProgramScene:Deckhand_Full Slide'), 'the driver deck slide change still reveals the audience scene');
});

test('coordinator still publishes presenter state when the frozen cut-back scene switch fails', async () => {
  const trace = [];
  const publishes = [];

  const hub = {
    ...createTracingHub(trace, {
      activeDriver: { role: 'driver', sessionId: 'driver-1' },
      publishes,
    }),
    async sendCommand(_target, command) {
      trace.push(`sendCommand:${command.type}`);
      return [{ role: 'driver', sessionId: 'driver-1' }];
    },
  };

  const obs = createTracingObs(trace);
  // Only the cut-back target fails: the pre-freeze switch to Freeze must work.
  const realSwitch = obs.switchProgramScene;
  obs.switchProgramScene = async (name) => {
    if (name === 'Deckhand_Dual Browser') {
      throw new Error('obs hiccup');
    }
    return realSwitch(name);
  };

  const logger = createLogger();
  const coordinator = createCoordinator({
    config: createSameSceneTransitionsConfig(),
    obs,
    hub: hub,
    executor: createTracingExecutor(trace),
    logger,
  });

  await coordinator.start();
  await coordinator.handleDriverPositionChanged({ id: 'demo', index: { h: 1, v: 0 }, meta: {} });
  trace.length = 0;

  await hub.emit('observerDriverCommand', {
    command: { type: 'next' },
    sender: { role: 'observer', sessionId: 'observer-1' },
  });

  publishes.length = 0;
  const pending = hub.emit('driverPositionChanged', {
    id: 'demo-clean',
    index: { h: 2, v: 0 },
    meta: { driverEventId: 41 },
  });
  hub.emit('driverPositionSettled', { eventId: 41 });
  await pending;

  assert.ok(logger.errors.some((entry) => /cut back/i.test(entry.message)), 'the failed cut-back is logged as an error');
  const publish = publishes.find(({ channel }) => channel === 'presentationState');
  assert.ok(publish, 'an OBS hiccup must not strand the presenter: state is still published');
  assert.equal(publish.payload.slideId, 'demo-clean', 'the publish carries the incoming slide id');
});
