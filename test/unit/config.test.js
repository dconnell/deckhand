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
const laptopConfigPath = fileURLToPath(new URL('../../presentation/example-laptop/config.json', import.meta.url));

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
      Terminal: { kind: 'app', app: 'iTerm2', command: 'npm run dev', cwd: '/repos/demo' },
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
        overlays: [{ source: 'Presenter', rect: { x: 1600, y: 50, w: 250, h: 400 } }],
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
        overlays: [{ source: 'Presenter', hidden: true }],
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
        whisperBin: '/opt/homebrew/bin/whisper-stream',
        model: '/opt/homebrew/share/whisper/ggml-base.en.bin',
        mode: 'step',
        captureId: -1,
        stepMs: 1000,
        lengthMs: 4000,
        keepMs: 250,
        threads: 4,
        audioCtx: 0,
        beamSize: -1,
        keepContext: false,
        noFallback: true,
        useGpu: true,
        flashAttn: true,
        language: 'en',
      },
      teleprompter: {
        followEnabledByDefault: true,
        window: { app: 'Google Chrome', titleIncludes: 'Deckhand Presenter' },
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
  assert.deepEqual(config.sources.Terminal, {
    id: 'Terminal',
    kind: 'app',
    app: 'iTerm2',
    command: 'npm run dev',
    cwd: '/repos/demo',
  });
  assert.deepEqual(config.slides['code-walkthrough'], {
    layoutId: 'left-terminal-right-slide',
    focus: 'Terminal',
    script: 'Walk through the init flow.\nEmphasize line 42.',
    commands: [],
    overlays: [{ source: 'Presenter', hidden: true }],
  });
  assert.deepEqual(config.presenter.stage, { x: 100, y: 50, width: 1800, height: 1168 });
  assert.equal(config.presenter.teleprompter.followEnabledByDefault, true);
  assert.deepEqual(config.presenter.teleprompter.window, {
    app: 'Google Chrome',
    titleIncludes: 'Deckhand Presenter',
  });
});

test('normalizeConfig preserves teleprompter tracking tuning including farJumpLines', () => {
  const config = createValidConfig();
  config.presenter.teleprompter.tracking = {
    farJumpLines: 3,
    lostMs: 9_000,
    minConfidence: 0.45,
    offScriptMs: 4_000,
  };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.presenter.teleprompter.tracking, {
    farJumpLines: 3,
    lostMs: 9_000,
    minConfidence: 0.45,
    offScriptMs: 4_000,
  });
});

test('normalizeConfig applies whisper-stream stt defaults when optional fields are omitted', () => {
  const config = createValidConfig();
  config.presenter.stt = {
    whisperBin: '/opt/homebrew/bin/whisper-stream',
    model: '/opt/homebrew/share/whisper/ggml-base.en.bin',
  };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.presenter.stt, {
    whisperBin: '/opt/homebrew/bin/whisper-stream',
    model: '/opt/homebrew/share/whisper/ggml-base.en.bin',
    mode: 'step',
    captureId: -1,
    stepMs: 1000,
    lengthMs: 4000,
    keepMs: 250,
    threads: 4,
    audioCtx: 0,
    beamSize: -1,
    keepContext: false,
    noFallback: true,
    useGpu: true,
    flashAttn: true,
  });
});

test('normalizeConfig preserves explicit whisper-stream stt settings', () => {
  const config = createValidConfig();
  config.presenter.stt = {
    whisperBin: '/opt/homebrew/bin/whisper-stream',
    model: '/opt/homebrew/share/whisper/ggml-large-v3-turbo.bin',
    mode: 'vad',
    captureId: 2,
    stepMs: 500,
    lengthMs: 5000,
    keepMs: 250,
    threads: 6,
    audioCtx: 768,
    beamSize: 3,
    keepContext: true,
    noFallback: true,
    useGpu: false,
    flashAttn: false,
    vadThreshold: 0.65,
    freqThreshold: 120,
    language: 'en',
  };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.presenter.stt, {
    whisperBin: '/opt/homebrew/bin/whisper-stream',
    model: '/opt/homebrew/share/whisper/ggml-large-v3-turbo.bin',
    mode: 'vad',
    captureId: 2,
    stepMs: 500,
    lengthMs: 5000,
    keepMs: 250,
    threads: 6,
    audioCtx: 768,
    beamSize: 3,
    keepContext: true,
    noFallback: true,
    useGpu: false,
    flashAttn: false,
    vadThreshold: 0.65,
    freqThreshold: 120,
    language: 'en',
  });
});

test('normalizeConfig accepts audience-only mode when presenter is omitted', () => {
  const config = createValidConfig();
  delete config.presenter;
  delete config.layouts['full-slide'].overlays;
  delete config.slides['code-walkthrough'].overlays;

  const normalized = normalizeConfig(config);

  assert.equal(normalized.presenter, null);
  assert.equal(normalized.slides.welcome.layoutId, 'full-slide');
});

test('normalizeConfig accepts teleprompter overlays on layouts and slides', () => {
  const config = normalizeConfig(createValidConfig());

  assert.deepEqual(config.layouts['full-slide'].overlays, [
    { source: 'Presenter', rect: { x: 1600, y: 50, w: 250, h: 400 } },
  ]);
  assert.deepEqual(config.slides['code-walkthrough'].overlays, [
    { source: 'Presenter', hidden: true },
  ]);
});

test('normalizeConfig allows omitting presenter.teleprompter.window when overlays are unused', () => {
  const config = createValidConfig();
  delete config.presenter.teleprompter.window;
  delete config.layouts['full-slide'].overlays;
  delete config.slides['code-walkthrough'].overlays;

  const normalized = normalizeConfig(config);

  assert.equal(normalized.presenter.teleprompter.window, null);
});

test('normalizeConfig applies default teleprompter tracking thresholds', () => {
  const normalized = normalizeConfig(createValidConfig());

  assert.deepEqual(normalized.presenter.teleprompter.tracking, {
    farJumpLines: 8,
    offScriptMs: 3000,
    lostMs: 8000,
    minConfidence: 0.35,
  });
});

test('normalizeConfig accepts explicit teleprompter tracking overrides', () => {
  const config = createValidConfig();
  config.presenter.teleprompter.tracking = {
    offScriptMs: 4500,
    lostMs: 9000,
    minConfidence: 0.5,
  };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.presenter.teleprompter.tracking, {
    farJumpLines: 8,
    offScriptMs: 4500,
    lostMs: 9000,
    minConfidence: 0.5,
  });
});

test('normalizeConfig rejects invalid teleprompter tracking values', () => {
  const config = createValidConfig();
  config.presenter.teleprompter.tracking = {
    offScriptMs: 0,
    lostMs: 9000,
    minConfidence: 0.5,
  };

  assertConfigError(() => normalizeConfig(config), 'presenter.teleprompter.tracking.offScriptMs', /positive integer/i);
});

test('normalizeConfig enables obs.transitions by default when the block is omitted', () => {
  const config = normalizeConfig(createValidConfig());

  assert.deepEqual(config.obs.transitions, {
    forward: null,
    backward: null,
    freezeScene: 'Deckhand_Freeze',
    freezeImage: 'Deckhand_Freeze Frame',
    freezeImagePath: null,
    durationMs: 300,
    settleMs: 200,
    navigationWaitMs: 1000,
    windowSettleMs: 2000,
    freezeDimPercent: 5,
  });
});

test('normalizeConfig disables obs.transitions when set to false', () => {
  const config = createValidConfig();
  config.obs.transitions = false;

  assert.equal(normalizeConfig(config).obs.transitions, null);
});

test('normalizeConfig disables obs.transitions when explicitly set to null', () => {
  const config = createValidConfig();
  config.obs.transitions = null;

  assert.equal(normalizeConfig(config).obs.transitions, null);
});

test('normalizeConfig normalizes the slide-transitions block with defaults', () => {
  const config = createValidConfig();
  config.obs.transitions = { forward: 'Slide Right', backward: 'Slide Left' };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.obs.transitions, {
    forward: 'Slide Right',
    backward: 'Slide Left',
    freezeScene: 'Deckhand_Freeze',
    freezeImage: 'Deckhand_Freeze Frame',
    freezeImagePath: null,
    durationMs: 300,
    settleMs: 200,
    navigationWaitMs: 1000,
    windowSettleMs: 2000,
    freezeDimPercent: 5,
  });
});

test('normalizeConfig treats forward/backward as optional, defaulting to null', () => {
  const config = createValidConfig();
  config.obs.transitions = { forward: 'Slide Right' };

  const normalized = normalizeConfig(config).obs.transitions;

  assert.equal(normalized.forward, 'Slide Right');
  assert.equal(normalized.backward, null);
});

test('normalizeConfig defaults obs.prune to true so stale Deckhand entities are reconciled', () => {
  const config = normalizeConfig(createValidConfig());

  assert.equal(config.obs.prune, true);
});

test('normalizeConfig honors an explicit obs.prune override', () => {
  const config = createValidConfig();
  config.obs.prune = false;

  assert.equal(normalizeConfig(config).obs.prune, false);
});

test('normalizeConfig rejects a non-boolean obs.prune', () => {
  const config = createValidConfig();
  config.obs.prune = 'yes';

  assertConfigError(() => normalizeConfig(config), 'obs.prune', /must be a boolean/i);
});

test('normalizeConfig accepts operator overrides for freeze assets and timing', () => {
  const config = createValidConfig();
  config.obs.transitions = {
    forward: 'Slide Right',
    backward: 'Slide Left',
    freezeScene: 'Freeze',
    freezeImage: 'Freeze Frame',
    freezeImagePath: '/tmp/freeze.png',
    durationMs: 250,
    settleMs: 150,
    navigationWaitMs: 800,
    freezeDimPercent: 15,
  };

  const normalized = normalizeConfig(config);

  assert.equal(normalized.obs.transitions.freezeScene, 'Freeze');
  assert.equal(normalized.obs.transitions.freezeImagePath, '/tmp/freeze.png');
  assert.equal(normalized.obs.transitions.durationMs, 250);
  assert.equal(normalized.obs.transitions.navigationWaitMs, 800);
  assert.equal(normalized.obs.transitions.freezeDimPercent, 15);
});

test('normalizeConfig clamps freezeDimPercent to the 0-100 range', () => {
  const config = createValidConfig();
  config.obs.transitions = { forward: 'Slide Right', backward: 'Slide Left' };

  assertConfigError(() => {
    const c = createValidConfig();
    c.obs.transitions = { forward: 'Slide Right', backward: 'Slide Left', freezeDimPercent: -1 };
    normalizeConfig(c);
  }, 'obs.transitions.freezeDimPercent', /0.*100/i);

  assertConfigError(() => {
    const c = createValidConfig();
    c.obs.transitions = { forward: 'Slide Right', backward: 'Slide Left', freezeDimPercent: 101 };
    normalizeConfig(c);
  }, 'obs.transitions.freezeDimPercent', /0.*100/i);

  config.obs.transitions = { forward: 'Slide Right', backward: 'Slide Left', freezeDimPercent: 0 };
  assert.equal(normalizeConfig(config).obs.transitions.freezeDimPercent, 0);
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

  assertConfigError(() => normalizeConfig(config), 'sources.Slide.kind', /browser, app/i);
});

test('normalizeConfig rejects the removed terminal kind', () => {
  const config = createValidConfig();
  config.sources.Terminal.kind = 'terminal';

  assertConfigError(() => normalizeConfig(config), 'sources.Terminal.kind', /browser, app/i);
});

test('normalizeConfig normalizes iTerm2 app command and cwd fields', () => {
  const config = normalizeConfig(createValidConfig());

  assert.deepEqual(config.sources.Terminal, {
    id: 'Terminal',
    kind: 'app',
    app: 'iTerm2',
    command: 'npm run dev',
    cwd: '/repos/demo',
  });
});

test('normalizeConfig accepts iTerm2 app sources without command or cwd', () => {
  const config = createValidConfig();
  config.sources.Terminal = { kind: 'app', app: 'iTerm2' };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.sources.Terminal, { id: 'Terminal', kind: 'app', app: 'iTerm2' });
});

test('normalizeConfig rejects iTerm2 app sources with a non-string command', () => {
  const config = createValidConfig();
  config.sources.Terminal = { kind: 'app', app: 'iTerm2', command: 42 };

  assertConfigError(() => normalizeConfig(config), 'sources.Terminal.command', /non-empty string/i);
});

test('normalizeConfig rejects relative iTerm2 app cwd paths', () => {
  const config = createValidConfig();
  config.sources.Terminal = { kind: 'app', app: 'iTerm2', cwd: './demo' };

  assertConfigError(() => normalizeConfig(config), 'sources.Terminal.cwd', /absolute path/i);
});

test('normalizeConfig normalizes app source owner, args, and cwd fields', () => {
  const config = createValidConfig();
  config.sources.Editor = { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'], cwd: '/repos/demo' };
  config.layouts['full-editor'] = {
    audienceScene: 'Full Editor',
    slots: [{ source: 'Editor', position: 'full' }],
  };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.sources.Editor, {
    id: 'Editor',
    kind: 'app',
    app: 'Visual Studio Code',
    args: ['--new-window', '/repos/demo'],
    cwd: '/repos/demo',
  });
});

test('normalizeConfig preserves command on generic app sources so adapters can opt into it', () => {
  const config = createValidConfig();
  config.sources.Editor = { kind: 'app', app: 'Visual Studio Code', command: 'ignored-by-default' };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.sources.Editor, {
    id: 'Editor',
    kind: 'app',
    app: 'Visual Studio Code',
    command: 'ignored-by-default',
  });
});

test('normalizeConfig rejects app sources without an owner app name', () => {
  const config = createValidConfig();
  config.sources.Editor = { kind: 'app' };

  assertConfigError(() => normalizeConfig(config), 'sources.Editor.app', /non-empty string/i);
});

test('normalizeConfig rejects app sources with non-string args', () => {
  const config = createValidConfig();
  config.sources.Editor = { kind: 'app', app: 'Visual Studio Code', args: '--new-window' };

  assertConfigError(() => normalizeConfig(config), 'sources.Editor.args', /array of non-empty strings/i);
});

test('normalizeConfig rejects app sources with empty-string args', () => {
  const config = createValidConfig();
  config.sources.Editor = { kind: 'app', app: 'Visual Studio Code', args: ['--new-window', '   '] };

  assertConfigError(() => normalizeConfig(config), 'sources.Editor.args', /array of non-empty strings/i);
});

test('normalizeConfig accepts app sources with only an owner name', () => {
  const config = createValidConfig();
  config.sources.Editor = { kind: 'app', app: 'Visual Studio Code' };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.sources.Editor, { id: 'Editor', kind: 'app', app: 'Visual Studio Code' });
});

test('normalizeConfig normalizes app source files as absolute paths', () => {
  const config = createValidConfig();
  config.sources.Image = { kind: 'app', app: 'Preview', files: ['/abs/image.jpg', '/abs/second.png'] };
  config.layouts['full-image'] = {
    audienceScene: 'Full Image',
    slots: [{ source: 'Image', position: 'full' }],
  };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.sources.Image, {
    id: 'Image',
    kind: 'app',
    app: 'Preview',
    files: ['/abs/image.jpg', '/abs/second.png'],
  });
});

test('normalizeConfig rejects app sources with non-array files', () => {
  const config = createValidConfig();
  config.sources.Image = { kind: 'app', app: 'Preview', files: '/abs/image.jpg' };
  config.layouts['full-image'] = {
    audienceScene: 'Full Image',
    slots: [{ source: 'Image', position: 'full' }],
  };

  assertConfigError(() => normalizeConfig(config), 'sources.Image.files', /array of non-empty strings/i);
});

test('normalizeConfig resolves relative file paths against the presentation base dir', () => {
  const config = createValidConfig();
  config.sources.Image = { kind: 'app', app: 'Preview', files: ['image.jpg', 'nested/second.png'] };
  config.layouts['full-image'] = {
    audienceScene: 'Full Image',
    slots: [{ source: 'Image', position: 'full' }],
  };

  const normalized = normalizeConfig(config, { baseDir: '/repos/example-laptop' });

  assert.deepEqual(normalized.sources.Image.files, [
    '/repos/example-laptop/image.jpg',
    '/repos/example-laptop/nested/second.png',
  ]);
});

test('normalizeConfig leaves absolute file paths untouched when a base dir is provided', () => {
  const config = createValidConfig();
  config.sources.Image = { kind: 'app', app: 'Preview', files: ['/abs/image.jpg'] };
  config.layouts['full-image'] = {
    audienceScene: 'Full Image',
    slots: [{ source: 'Image', position: 'full' }],
  };

  const normalized = normalizeConfig(config, { baseDir: '/repos/example-laptop' });

  assert.deepEqual(normalized.sources.Image.files, ['/abs/image.jpg']);
});

test('normalizeConfig normalizes app source openArgs as a verbatim string array', () => {
  const config = createValidConfig();
  config.sources.Site = { kind: 'app', app: 'Safari', openArgs: ['-g', 'https://example.com'] };
  config.layouts['full-site'] = {
    audienceScene: 'Full Site',
    slots: [{ source: 'Site', position: 'full' }],
  };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.sources.Site, {
    id: 'Site',
    kind: 'app',
    app: 'Safari',
    openArgs: ['-g', 'https://example.com'],
  });
});

test('normalizeConfig rejects app sources that set openArgs alongside args', () => {
  const config = createValidConfig();
  config.sources.Site = { kind: 'app', app: 'Safari', openArgs: ['-g'], args: ['--flag'] };
  config.layouts['full-site'] = {
    audienceScene: 'Full Site',
    slots: [{ source: 'Site', position: 'full' }],
  };

  assertConfigError(() => normalizeConfig(config), 'sources.Site.openArgs', /mutually exclusive/i);
});

test('normalizeConfig rejects app sources that set openArgs alongside files', () => {
  const config = createValidConfig();
  config.sources.Site = { kind: 'app', app: 'Preview', openArgs: ['-F'], files: ['/abs/image.jpg'] };
  config.layouts['full-site'] = {
    audienceScene: 'Full Site',
    slots: [{ source: 'Site', position: 'full' }],
  };

  assertConfigError(() => normalizeConfig(config), 'sources.Site.openArgs', /mutually exclusive/i);
});

test('normalizeConfig passes through Slack adapter fields with shape validation', () => {
  const config = createValidConfig();
  config.sources.QnA = {
    kind: 'app',
    app: 'Slack',
    slack: { target: 'channel', team: 'T14AN', id: 'C07HV', newWindow: true },
  };
  config.layouts['full-qna'] = {
    audienceScene: 'QnA',
    slots: [{ source: 'QnA', position: 'full' }],
  };

  const normalized = normalizeConfig(config);

  assert.deepEqual(normalized.sources.QnA.slack, { target: 'channel', team: 'T14AN', id: 'C07HV', newWindow: true });
});

test('normalizeConfig accepts a raw slack:// uri and a sibling newWindow flag', () => {
  const config = createValidConfig();
  config.sources.QnA = {
    kind: 'app',
    app: 'Slack',
    uri: 'slack://channel?team=T14AN&id=C07HV',
    newWindow: false,
  };
  config.layouts['full-qna'] = {
    audienceScene: 'QnA',
    slots: [{ source: 'QnA', position: 'full' }],
  };

  const normalized = normalizeConfig(config);

  assert.equal(normalized.sources.QnA.uri, 'slack://channel?team=T14AN&id=C07HV');
  assert.equal(normalized.sources.QnA.newWindow, false);
});

test('normalizeConfig rejects a non-boolean newWindow', () => {
  const config = createValidConfig();
  config.sources.QnA = {
    kind: 'app',
    app: 'Slack',
    slack: { team: 'T1', id: 'C1' },
    newWindow: 'yes',
  };
  config.layouts['full-qna'] = {
    audienceScene: 'QnA',
    slots: [{ source: 'QnA', position: 'full' }],
  };

  assertConfigError(() => normalizeConfig(config), 'sources.QnA.newWindow', /boolean/i);
});

test('normalizeConfig rejects a non-object slack field', () => {
  const config = createValidConfig();
  config.sources.QnA = {
    kind: 'app',
    app: 'Slack',
    slack: 'channel',
  };
  config.layouts['full-qna'] = {
    audienceScene: 'QnA',
    slots: [{ source: 'QnA', position: 'full' }],
  };

  assertConfigError(() => normalizeConfig(config), 'sources.QnA.slack', /object/i);
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

test('normalizeConfig rejects overlays that reference non-Presenter sources', () => {
  const config = createValidConfig();
  config.layouts['full-slide'].overlays[0].source = 'Slide';

  assertConfigError(() => normalizeConfig(config), 'layouts.full-slide.overlays[0].source', /Presenter/i);
});

test('normalizeConfig rejects overlays without rect or hidden', () => {
  const config = createValidConfig();
  config.layouts['full-slide'].overlays = [{ source: 'Presenter' }];

  assertConfigError(() => normalizeConfig(config), 'layouts.full-slide.overlays[0]', /rect or hidden/i);
});

test('normalizeConfig rejects overlays with both rect and hidden', () => {
  const config = createValidConfig();
  config.layouts['full-slide'].overlays = [{ source: 'Presenter', rect: { x: 1, y: 2, w: 3, h: 4 }, hidden: true }];

  assertConfigError(() => normalizeConfig(config), 'layouts.full-slide.overlays[0]', /exactly one/i);
});

test('normalizeConfig rejects malformed overlay rects', () => {
  const config = createValidConfig();
  config.layouts['full-slide'].overlays = [{ source: 'Presenter', rect: { x: 1, y: 2, w: 0, h: 4 } }];

  assertConfigError(() => normalizeConfig(config), 'layouts.full-slide.overlays[0].rect.w', /positive integer/i);
});

test('normalizeConfig rejects Presenter as a layout slot source', () => {
  const config = createValidConfig();
  config.layouts['full-slide'].slots[0].source = 'Presenter';

  assertConfigError(() => normalizeConfig(config), 'layouts.full-slide.slots[0].source', /Presenter.*reserved|known source/i);
});

test('normalizeConfig requires presenter.teleprompter.window when overlays reference Presenter', () => {
  const config = createValidConfig();
  delete config.presenter.teleprompter.window;

  assertConfigError(() => normalizeConfig(config), 'presenter.teleprompter.window', /required/i);
});

test('normalizeConfig rejects focus on Presenter because overlays are never focus targets', () => {
  const config = createValidConfig();
  config.slides.welcome.focus = 'Presenter';

  assertConfigError(() => normalizeConfig(config), 'slides.welcome.focus', /known source|present in layout/i);
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

test('normalizeConfig relaxes presenter.windows requirement for owned source kinds', () => {
  const config = createValidConfig();
  delete config.presenter.windows.Terminal;

  const normalized = normalizeConfig(config);

  assert.equal(Object.prototype.hasOwnProperty.call(normalized.presenter.windows, 'Terminal'), false);
  assert.equal(normalized.sources.Terminal.kind, 'app');
  assert.equal(normalized.sources.Terminal.app, 'iTerm2');
});

test('normalizeConfig accepts an app source without a presenter.windows entry', () => {
  const config = createValidConfig();
  config.sources.Editor = { kind: 'app', app: 'Visual Studio Code' };
  config.layouts['full-editor'] = {
    audienceScene: 'Full Editor',
    slots: [{ source: 'Editor', position: 'full' }],
  };

  const normalized = normalizeConfig(config);

  assert.equal(normalized.sources.Editor.kind, 'app');
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.presenter.windows, 'Editor'), false);
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
  config.presenter.stt.whisperBin = './whisper-stream';

  assertConfigError(() => normalizeConfig(config), 'presenter.stt.whisperBin', /absolute path/i);
});

test('normalizeConfig rejects unknown stt modes', () => {
  const config = createValidConfig();
  config.presenter.stt.mode = 'chunked';

  assertConfigError(() => normalizeConfig(config), 'presenter.stt.mode', /must be one of/i);
});

test('normalizeConfig rejects legacy stt chunkSeconds', () => {
  const config = createValidConfig();
  delete config.presenter.stt.mode;
  delete config.presenter.stt.stepMs;
  delete config.presenter.stt.lengthMs;
  delete config.presenter.stt.keepMs;
  config.presenter.stt.chunkSeconds = 2.5;

  assertConfigError(() => normalizeConfig(config), 'presenter.stt.chunkSeconds', /replaced/i);
});

test('normalizeConfig rejects non-positive stt stepMs', () => {
  const config = createValidConfig();
  config.presenter.stt.stepMs = 0;

  assertConfigError(() => normalizeConfig(config), 'presenter.stt.stepMs', /positive integer/i);
});

test('normalizeConfig rejects stt lengthMs shorter than stepMs', () => {
  const config = createValidConfig();
  config.presenter.stt.lengthMs = config.presenter.stt.stepMs - 1;

  assertConfigError(() => normalizeConfig(config), 'presenter.stt.lengthMs', /must be greater than or equal to presenter\.stt\.stepMs/i);
});

test('normalizeConfig rejects stt keepMs larger than stepMs', () => {
  const config = createValidConfig();
  config.presenter.stt.keepMs = config.presenter.stt.stepMs + 1;

  assertConfigError(() => normalizeConfig(config), 'presenter.stt.keepMs', /must be less than or equal to presenter\.stt\.stepMs/i);
});

test('normalizeConfig rejects invalid stt vadThreshold values', () => {
  const config = createValidConfig();
  config.presenter.stt.vadThreshold = 1.5;

  assertConfigError(() => normalizeConfig(config), 'presenter.stt.vadThreshold', /between 0 and 1/i);
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

test('loadConfig rejects an app source files path that does not exist on disk', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-files-exist-'));
  const configPath = path.join(tempDir, 'config.json');
  const config = createValidConfig();
  config.sources.Image = { kind: 'app', app: 'Preview', files: ['/abs/does-not-exist.jpg'] };
  config.layouts['full-image'] = {
    audienceScene: 'Full Image',
    slots: [{ source: 'Image', position: 'full' }],
  };

  try {
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    await assert.rejects(
      () => loadConfig({ filePath: configPath }),
      (error) => {
        assert.ok(error instanceof ConfigError, 'should be a ConfigError');
        assert.equal(error.path, 'sources.Image.files[0]');
        assert.match(error.message, /does not exist/i);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadConfig accepts an app source files path that exists on disk', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-files-exist-'));
  const configPath = path.join(tempDir, 'config.json');
  const imagePath = path.join(tempDir, 'image.jpg');
  const config = createValidConfig();
  config.sources.Image = { kind: 'app', app: 'Preview', files: [imagePath] };
  config.layouts['full-image'] = {
    audienceScene: 'Full Image',
    slots: [{ source: 'Image', position: 'full' }],
  };

  try {
    await writeFile(imagePath, 'data', 'utf8');
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const normalized = await loadConfig({ filePath: configPath });

    assert.deepEqual(normalized.sources.Image.files, [imagePath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('presentation/example/config.json loads as the shipped sample presentation', async () => {
  const config = await loadConfig({ filePath: exampleConfigPath });

  assert.ok(config.presenter);
  assert.ok(config.layouts['dual-browser']);
  assert.equal(config.presenter.stt.mode, 'step');
  assert.equal(config.presenter.stt.stepMs, 1000);
});

test('presentation/example-laptop/config.json ships per-layout teleprompter overlays with one slide override', async () => {
  const { buildPresentationState } = await import('../../src/scenes.js');
  const config = await loadConfig({ filePath: laptopConfigPath });

  assert.deepEqual(config.presenter.stage, { x: 0, y: 0, width: 1800, height: 1168 });
  assert.ok(config.presenter.teleprompter.window, 'laptop sample requires a teleprompter selector');

  for (const layout of Object.values(config.layouts)) {
    assert.equal(layout.overlays.length, 1, `layout ${layout.id} should declare a default teleprompter overlay`);
    assert.equal(layout.overlays[0].source, 'Presenter');
    assert.equal(layout.overlays[0].rect.h, 584, 'laptop overlays should be half-screen-height columns');
    assert.equal(layout.overlays[0].rect.w, 150);
  }

  const welcome = buildPresentationState('welcome', config, 1);
  const closing = buildPresentationState('closing', config, 2);

  assert.equal(welcome.layoutId, 'full-slide');
  assert.equal(closing.layoutId, 'full-slide');

  assert.deepEqual(welcome.overlays, [
    { source: 'Presenter', rect: { x: 1650, y: 0, w: 150, h: 584 } },
  ]);
  assert.deepEqual(closing.overlays, [
    { source: 'Presenter', rect: { x: 0, y: 584, w: 150, h: 584 } },
  ]);

  assert.notDeepEqual(welcome.overlays, closing.overlays, 'closing must override the full-slide default');
});
