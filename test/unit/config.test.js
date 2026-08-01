import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { ConfigError, loadConfig, normalizeConfig } from '../../src/config.js';
import { assertDriverAdapterContract } from '../../src/protocol.js';
import { revealjsDriver } from '../../src/drivers/revealjs.js';

const exampleConfigPath = fileURLToPath(new URL('../../presentation/example/config.json', import.meta.url));

function createValidConfig() {
  return {
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { port: 8765 },
    sources: {
      Slide: {
        kind: 'browser',
        browser: {
          window: { label: 'slide' },
          tabs: {
            deck: { url: 'http://127.0.0.1:3000/presentation/example/deck/index.html', initial: true },
          },
        },
      },
      Terminal: { kind: 'terminal' },
      BrowserA: {
        kind: 'browser',
        browser: {
          window: { label: 'browser-a' },
          tabs: {
            home: { url: 'https://example.com/demo/home', initial: true },
            checkout: { url: 'https://example.com/demo/checkout' },
          },
        },
      },
      BrowserB: {
        kind: 'browser',
        browser: {
          window: { label: 'browser-b' },
          tabs: {
            main: { url: 'https://example.com/demo/secondary', initial: true },
          },
        },
      },
    },
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
          { source: 'BrowserA', position: 'left' },
          { source: 'BrowserB', position: 'right' },
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
        focus: 'BrowserB',
        browser: [
          { source: 'BrowserA', action: 'activateTab', tab: 'checkout' },
          { source: 'BrowserB', action: 'activateTab', tab: 'main' },
        ],
      },
      'api-demo': {
        layout: 'dual-browser',
        browser: [
          { source: 'BrowserA', action: 'navigate', tab: 'home', url: 'https://example.com/demo/api' },
        ],
      },
    },
    presenter: {
      platform: 'macos',
      stage: { x: 100, y: 50, width: 1800, height: 1168 },
      windows: {
        Slide: { app: 'Google Chrome', titleIncludes: 'Deckhand Deck' },
        Terminal: { app: 'iTerm2' },
        BrowserA: { app: 'Google Chrome', titleIncludes: 'Primary' },
        BrowserB: { app: 'Google Chrome', titleIncludes: 'Secondary' },
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

test('built-in driver adapter satisfies the common metadata contract', () => {
  assert.doesNotThrow(() => assertDriverAdapterContract(revealjsDriver));
});

test('normalizeConfig accepts the greenfield presenter-mode model', () => {
  const config = normalizeConfig(createValidConfig());

  assert.deepEqual(config.driver, { type: 'revealjs' });
  assert.equal(config.layouts['full-slide'].audienceScene, 'Full Slide');
  assert.deepEqual(config.layouts['dual-browser'].sources, ['BrowserA', 'BrowserB']);
  assert.deepEqual(config.sources.BrowserA, {
    id: 'BrowserA',
    kind: 'browser',
    browser: {
      windowLabel: 'browser-a',
      tabs: {
        home: { url: 'https://example.com/demo/home', preload: true },
        checkout: { url: 'https://example.com/demo/checkout', preload: true },
      },
      initialTab: 'home',
    },
  });
  assert.deepEqual(config.sources.Terminal, { id: 'Terminal', kind: 'terminal' });
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

test('normalizeConfig converts slide browser actions into typed command objects', () => {
  const config = normalizeConfig(createValidConfig());

  assert.deepEqual(config.slides['dual-demo'].commands, [
    { type: 'activateTab', source: 'BrowserA', tab: 'checkout' },
    { type: 'activateTab', source: 'BrowserB', tab: 'main' },
  ]);
  assert.deepEqual(config.slides['api-demo'].commands, [
    { type: 'navigate', source: 'BrowserA', tab: 'home', url: 'https://example.com/demo/api' },
  ]);
});

test('normalizeConfig defaults preload to true and resolves the initial tab when none is marked', () => {
  const config = createValidConfig();
  delete config.sources.BrowserA.browser.tabs.home.initial;

  const normalized = normalizeConfig(config);

  assert.equal(normalized.sources.BrowserA.browser.initialTab, 'home');
  assert.equal(normalized.sources.BrowserA.browser.tabs.home.preload, true);
});

test('normalizeConfig accepts chrome.profileName for seeding a working copy from a named Chrome profile', () => {
  const config = createValidConfig();
  config.chrome = { profileName: 'Personal' };

  const normalized = normalizeConfig(config);

  assert.equal(normalized.chrome.profileName, 'Personal');
});

test('normalizeConfig rejects browser tabs that disable preload', () => {
  const config = createValidConfig();
  config.sources.BrowserA.browser.tabs.checkout.preload = false;

  assertConfigError(() => normalizeConfig(config), 'sources.BrowserA.browser.tabs.checkout.preload', /preload all declared tabs/i);
});

test('normalizeConfig rejects missing sources catalog', () => {
  const config = createValidConfig();
  delete config.sources;

  assertConfigError(() => normalizeConfig(config), 'sources', /must be an object/i);
});

test('normalizeConfig rejects empty sources catalog', () => {
  const config = createValidConfig();
  config.sources = {};

  assertConfigError(() => normalizeConfig(config), 'sources', /must define at least one source/i);
});

test('normalizeConfig rejects unknown source kinds', () => {
  const config = createValidConfig();
  config.sources.Slide.kind = 'slide-deck';

  assertConfigError(() => normalizeConfig(config), 'sources.Slide.kind', /browser, terminal/i);
});

test('normalizeConfig rejects browser sources that omit the tab catalog', () => {
  const config = createValidConfig();
  delete config.sources.BrowserA.browser;

  assertConfigError(() => normalizeConfig(config), 'sources.BrowserA.browser', /must be an object/i);
});

test('normalizeConfig rejects browser sources with an empty tab catalog', () => {
  const config = createValidConfig();
  config.sources.BrowserA.browser.tabs = {};

  assertConfigError(() => normalizeConfig(config), 'sources.BrowserA.browser.tabs', /at least one tab/i);
});

test('normalizeConfig rejects browser tabs with invalid urls', () => {
  const config = createValidConfig();
  config.sources.BrowserA.browser.tabs.home.url = 'not-a-url';

  assertConfigError(() => normalizeConfig(config), 'sources.BrowserA.browser.tabs.home.url', /absolute url/i);
});

test('normalizeConfig rejects browser catalogs with multiple initial tabs', () => {
  const config = createValidConfig();
  config.sources.BrowserA.browser.tabs.checkout.initial = true;

  assertConfigError(() => normalizeConfig(config), 'sources.BrowserA.browser', /exactly one initial/i);
});

test('normalizeConfig rejects slide browser actions that reference unknown sources', () => {
  const config = createValidConfig();
  config.slides['dual-demo'].browser[0].source = 'Mystery';

  assertConfigError(() => normalizeConfig(config), 'slides.dual-demo.browser[0].source', /known source/i);
});

test('normalizeConfig rejects slide browser actions against non-browser sources', () => {
  const config = createValidConfig();
  config.slides['dual-demo'].browser[0].source = 'Terminal';

  assertConfigError(() => normalizeConfig(config), 'slides.dual-demo.browser[0].source', /browser-capable/i);
});

test('normalizeConfig rejects slide browser actions with unknown tab aliases', () => {
  const config = createValidConfig();
  config.slides['dual-demo'].browser[0].tab = 'missing';

  assertConfigError(() => normalizeConfig(config), 'slides.dual-demo.browser[0].tab', /declared tab/i);
});

test('normalizeConfig rejects navigate actions without a url', () => {
  const config = createValidConfig();
  delete config.slides['api-demo'].browser[0].url;

  assertConfigError(() => normalizeConfig(config), 'slides.api-demo.browser[0].url', /absolute url/i);
});

test('normalizeConfig rejects unknown browser action types', () => {
  const config = createValidConfig();
  config.slides['dual-demo'].browser[0].action = 'close';

  assertConfigError(() => normalizeConfig(config), 'slides.dual-demo.browser[0].action', /activateTab, navigate/i);
});

test('normalizeConfig rejects layout slots that reference unknown sources', () => {
  const config = createValidConfig();
  config.layouts['full-slide'].slots[0].source = 'Mystery';

  assertConfigError(() => normalizeConfig(config), 'layouts.full-slide.slots[0].source', /known source/i);
});

test('normalizeConfig rejects focus values that are not known sources', () => {
  const config = createValidConfig();
  config.slides.welcome.focus = 'Mystery';

  assertConfigError(() => normalizeConfig(config), 'slides.welcome.focus', /known source/i);
});

test('normalizeConfig rejects presenter windows that reference unknown sources', () => {
  const config = createValidConfig();
  config.presenter.windows.Mystery = { app: 'Google Chrome' };

  assertConfigError(() => normalizeConfig(config), 'presenter.windows.Mystery', /known source/i);
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
  config.presenter.windows.Slide = 'Google Chrome';

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
