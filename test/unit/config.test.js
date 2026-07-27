import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { ConfigError, loadConfig, normalizeConfig, parseTargetSelector } from '../../src/config.js';
import { assertDriverAdapterContract, assertTargetAdapterContract } from '../../src/protocol.js';
import { revealjsDriver } from '../../src/drivers/revealjs.js';
import { browserTarget } from '../../src/targets/browser.js';

const exampleConfigPath = fileURLToPath(new URL('../../presentation/example/config.json', import.meta.url));

function createValidConfig() {
  return {
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { port: 8765 },
    hotkeys: { next: 'F13', prev: 'F14' },
    layouts: {
      'full-slide': {
        audienceScene: 'Full Slide',
        slots: [{ source: 'Slide', position: 'full' }],
      },
      'left-terminal-right-slide': {
        audienceScene: 'Left Terminal Right Slide',
        slots: [
          { source: 'Terminal', position: 'left' },
          { source: 'Slide', position: 'right' },
        ],
      },
      'dual-browser': {
        audienceScene: 'Dual Browser',
        slots: [
          { source: 'BrowserPrimary', position: 'left' },
          { source: 'BrowserSecondary', position: 'right' },
        ],
      },
    },
    slides: {
      welcome: { layout: 'full-slide' },
      'code-walkthrough': {
        layout: 'left-terminal-right-slide',
        focus: 'Terminal',
        script: 'Walk through the init flow.\nEmphasize line 42.',
      },
      'dual-demo': {
        layout: 'dual-browser',
        navigate: [
          { target: 'demo1:tabA', url: 'https://example.com/step2' },
          { target: 'demo2', url: 'https://example.com/other-app' },
        ],
      },
    },
    presenter: {
      platform: 'macos',
      stage: { x: 100, y: 50, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' },
        Terminal: { app: 'iTerm2' },
        BrowserPrimary: { app: 'Google Chrome', titleIncludes: 'Primary' },
        BrowserSecondary: { app: 'Google Chrome', titleIncludes: 'Secondary' },
      },
      stt: {
        whisperBin: '/opt/homebrew/bin/whisper-cli',
        model: '/opt/homebrew/share/whisper/ggml-base.en.bin',
        chunkSeconds: 2.5,
        language: 'en',
      },
      teleprompter: {
        followEnabledByDefault: true,
      },
    },
  };
}

function assertConfigError(callback, pathName, pattern) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.path, pathName);
    assert.match(error.message, pattern);
    return true;
  });
}

test('built-in driver and target adapters satisfy the common metadata contract', () => {
  assert.doesNotThrow(() => assertDriverAdapterContract(revealjsDriver));
  assert.doesNotThrow(() => assertTargetAdapterContract(browserTarget));
});

test('parseTargetSelector accepts controller-only selectors', () => {
  assert.deepEqual(parseTargetSelector('demo1'), {
    controllerId: 'demo1',
    tabId: null,
  });
});

test('parseTargetSelector accepts controller-plus-tab selectors', () => {
  assert.deepEqual(parseTargetSelector('demo1:tabA'), {
    controllerId: 'demo1',
    tabId: 'tabA',
  });
});

test('normalizeConfig accepts the greenfield presenter-mode model', () => {
  const config = normalizeConfig(createValidConfig());

  assert.deepEqual(config.driver, { type: 'revealjs' });
  assert.equal(config.layouts['full-slide'].audienceScene, 'Full Slide');
  assert.deepEqual(config.layouts['dual-browser'].sources, ['BrowserPrimary', 'BrowserSecondary']);
  assert.deepEqual(config.slides['code-walkthrough'], {
    layoutId: 'left-terminal-right-slide',
    focus: 'Terminal',
    script: 'Walk through the init flow.\nEmphasize line 42.',
    commands: [],
  });
  assert.deepEqual(config.presenter.stage, { x: 100, y: 50, width: 1800, height: 1168 });
  assert.equal(config.presenter.teleprompter.followEnabledByDefault, true);
});

test('normalizeConfig accepts audience-only mode when presenter is omitted', () => {
  const config = createValidConfig();
  delete config.presenter;

  const normalized = normalizeConfig(config);

  assert.equal(normalized.presenter, null);
  assert.equal(normalized.slides.welcome.layoutId, 'full-slide');
});

test('normalizeConfig converts navigate entries into generic command objects', () => {
  const config = normalizeConfig(createValidConfig());

  assert.deepEqual(config.slides['dual-demo'].commands, [
    {
      type: 'navigate',
      target: { controllerId: 'demo1', tabId: 'tabA' },
      url: 'https://example.com/step2',
    },
    {
      type: 'navigate',
      target: { controllerId: 'demo2', tabId: null },
      url: 'https://example.com/other-app',
    },
  ]);
});

test('normalizeConfig rejects missing layouts', () => {
  const config = createValidConfig();
  delete config.layouts;

  assertConfigError(() => normalizeConfig(config), 'layouts', /must be an object/i);
});

test('normalizeConfig rejects slide layout references that do not exist', () => {
  const config = createValidConfig();
  config.slides.welcome.layout = 'missing-layout';

  assertConfigError(() => normalizeConfig(config), 'slides.welcome.layout', /known layout/i);
});

test('normalizeConfig rejects empty layout slot lists', () => {
  const config = createValidConfig();
  config.layouts['full-slide'].slots = [];

  assertConfigError(() => normalizeConfig(config), 'layouts.full-slide.slots', /must contain at least one slot/i);
});

test('normalizeConfig rejects invalid slot positions', () => {
  const config = createValidConfig();
  config.layouts['full-slide'].slots[0].position = 'center';

  assertConfigError(() => normalizeConfig(config), 'layouts.full-slide.slots[0].position', /full, left, right/i);
});

test('normalizeConfig rejects focus values not present in the selected layout', () => {
  const config = createValidConfig();
  config.slides.welcome.focus = 'Terminal';

  assertConfigError(() => normalizeConfig(config), 'slides.welcome.focus', /present in layout/i);
});

test('normalizeConfig rejects odd presenter stage widths', () => {
  const config = createValidConfig();
  config.presenter.stage.width = 1799;

  assertConfigError(() => normalizeConfig(config), 'presenter.stage.width', /even integer/i);
});

test('normalizeConfig rejects missing presenter windows when presenter mode is enabled', () => {
  const config = createValidConfig();
  delete config.presenter.windows;

  assertConfigError(() => normalizeConfig(config), 'presenter.windows', /must be an object/i);
});

test('normalizeConfig rejects malformed window selectors', () => {
  const config = createValidConfig();
  config.presenter.windows.Slide = 'Safari';

  assertConfigError(() => normalizeConfig(config), 'presenter.windows.Slide', /must be an object/i);
});

test('normalizeConfig rejects missing window app names', () => {
  const config = createValidConfig();
  delete config.presenter.windows.Slide.app;

  assertConfigError(() => normalizeConfig(config), 'presenter.windows.Slide.app', /non-empty string/i);
});

test('normalizeConfig rejects relative stt paths', () => {
  const config = createValidConfig();
  config.presenter.stt.whisperBin = './whisper-cli';

  assertConfigError(() => normalizeConfig(config), 'presenter.stt.whisperBin', /absolute path/i);
});

test('normalizeConfig rejects non-positive stt chunkSeconds', () => {
  const config = createValidConfig();
  config.presenter.stt.chunkSeconds = 0;

  assertConfigError(() => normalizeConfig(config), 'presenter.stt.chunkSeconds', /positive number/i);
});

test('normalizeConfig rejects unknown driver types', () => {
  const config = createValidConfig();
  config.driver.type = 'googleslides';

  assertConfigError(
    () => normalizeConfig(config),
    'driver.type',
    /must be one of: revealjs/i,
  );
});

test('loadConfig reads JSON from disk and returns the normalized model', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-config-'));
  const configPath = path.join(tempDir, 'config.json');
  const configText = JSON.stringify(createValidConfig(), null, 2);

  try {
    await writeFile(configPath, configText, 'utf8');
    const config = await loadConfig({ filePath: configPath });

    assert.equal(config.driver.type, 'revealjs');
    assert.equal(config.layouts['full-slide'].audienceScene, 'Full Slide');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('presentation/example/config.json loads as the shipped sample presentation', async () => {
  const config = await loadConfig({ filePath: exampleConfigPath });

  assert.ok(config.presenter);
  assert.ok(config.layouts['dual-browser']);
});
