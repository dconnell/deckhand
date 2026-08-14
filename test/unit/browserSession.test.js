import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserSession } from '../../src/browserSession.js';

function createFakeCdpClient() {
  const calls = [];
  let targetCounter = 0;
  let windowCounter = 90;
  let connected = false;
  let chromePid = null;
  const disconnectedHandlers = new Set();

  return {
    calls,
    async connect() {
      calls.push({ type: 'connect' });
      connected = true;
      chromePid = 47213;
    },
    async disconnect() {
      calls.push({ type: 'disconnect' });
      connected = false;
    },
    isConnected() {
      return connected;
    },
    getChromePid() {
      return chromePid;
    },
    on(event, handler) {
      if (event === 'disconnected') {
        disconnectedHandlers.add(handler);
      }
    },
    simulateDisconnect() {
      connected = false;
      disconnectedHandlers.forEach((handler) => handler());
    },
    async createWindow({ url, width, height }) {
      targetCounter += 1;
      windowCounter += 1;
      const call = { type: 'createWindow', url };
      if (width !== undefined) {
        call.width = width;
      }
      if (height !== undefined) {
        call.height = height;
      }
      calls.push(call);
      return { targetId: `TARGET_${targetCounter}`, windowId: windowCounter };
    },
    async createTab({ url }) {
      targetCounter += 1;
      calls.push({ type: 'createTab', url });
      return { targetId: `TARGET_${targetCounter}`, windowId: windowCounter };
    },
    async activateTab({ targetId }) {
      calls.push({ type: 'activateTab', targetId });
    },
    async navigateTab({ targetId, url }) {
      calls.push({ type: 'navigateTab', targetId, url });
    },
    async waitForTabPaint({ targetId }) {
      calls.push({ type: 'waitForTabPaint', targetId });
    },
    async setWindowTitle({ targetId, title }) {
      calls.push({ type: 'setWindowTitle', targetId, title });
    },
    async closeTarget({ targetId }) {
      calls.push({ type: 'closeTarget', targetId });
    },
  };
}

function createBrowserSource(id, tabs, options = {}) {
  const tabEntries = Object.entries(tabs).map(([alias, tab]) => [
    alias,
    { url: tab.url, preload: tab.preload ?? true },
  ]);

  return {
    id,
    kind: 'browser',
    browser: {
      windowLabel: options.windowLabel ?? null,
      tabs: Object.fromEntries(tabEntries),
      initialTab: options.initialTab ?? Object.keys(tabs)[0],
    },
  };
}

function createSources(...sources) {
  return Object.fromEntries(sources.map((source) => [source.id, source]));
}

test('start creates one window per browser source in config order and preloads declared tabs', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource('Slide', { deck: { url: 'http://deck/' } }, { initialTab: 'deck' }),
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();

  assert.deepEqual(
    cdpClient.calls.map((call) => {
      const entry = { type: call.type };
      if (call.url !== undefined) {
        entry.url = call.url;
      }
      if (call.title !== undefined) {
        entry.title = call.title;
      }
      if (call.targetId !== undefined) {
        entry.targetId = call.targetId;
      }
      return entry;
    }),
    [
      { type: 'connect' },
      { type: 'createWindow', url: 'http://deck/' },
      { type: 'setWindowTitle', title: 'Deckhand Example Deck', targetId: 'TARGET_1' },
      { type: 'activateTab', targetId: 'TARGET_1' },
      { type: 'createWindow', url: 'https://example.com/home' },
      { type: 'createTab', url: 'https://example.com/checkout' },
      { type: 'setWindowTitle', title: 'Deckhand BrowserA', targetId: 'TARGET_2' },
      { type: 'setWindowTitle', title: 'Deckhand BrowserA', targetId: 'TARGET_3' },
      { type: 'activateTab', targetId: 'TARGET_2' },
    ],
  );
});

test('start records the initial tab as the window main target and tracks activeTab per source', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();

  const registry = session.getRegistry();
  assert.equal(registry.sources.BrowserA.mainTargetId, 'TARGET_1');
  assert.equal(registry.sources.BrowserA.cdpWindowId, 91);
  assert.equal(registry.sources.BrowserA.title, 'Deckhand BrowserA');
  assert.deepEqual(registry.sources.BrowserA.tabs, {
    home: { targetId: 'TARGET_1', initialUrl: 'https://example.com/home' },
    checkout: { targetId: 'TARGET_2', initialUrl: 'https://example.com/checkout' },
  });
  assert.equal(registry.sources.BrowserA.activeTab, 'home');
});

test('activateTab routes through the recorded target handle without URL lookup and updates activeTab', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();
  await session.activateTab('BrowserA', 'checkout');

  assert.deepEqual(
    cdpClient.calls.filter((call) => call.type === 'activateTab' && call.targetId === 'TARGET_2'),
    [{ type: 'activateTab', targetId: 'TARGET_2' }],
  );
  assert.deepEqual(
    cdpClient.calls.filter((call) => call.type === 'waitForTabPaint' && call.targetId === 'TARGET_2'),
    [{ type: 'waitForTabPaint', targetId: 'TARGET_2' }],
  );
  assert.equal(session.getRegistry().sources.BrowserA.activeTab, 'checkout');
});

test('navigateTab routes to the recorded target handle for the named tab', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();
  await session.navigateTab('BrowserA', 'checkout', 'https://example.com/checkout/v2');

  assert.deepEqual(
    cdpClient.calls.filter((call) => call.type === 'navigateTab'),
    [{ type: 'navigateTab', targetId: 'TARGET_2', url: 'https://example.com/checkout/v2' }],
  );
  assert.deepEqual(
    cdpClient.calls.filter((call) => call.type === 'waitForTabPaint' && call.targetId === 'TARGET_2'),
    [],
  );
});

test('navigateTab waits for paint when navigating the active tab', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();
  await session.navigateTab('BrowserA', 'home', 'https://example.com/home/v2');

  assert.deepEqual(
    cdpClient.calls.filter((call) => call.type === 'navigateTab'),
    [{ type: 'navigateTab', targetId: 'TARGET_1', url: 'https://example.com/home/v2' }],
  );
  assert.deepEqual(
    cdpClient.calls.filter((call) => call.type === 'waitForTabPaint' && call.targetId === 'TARGET_1'),
    [{ type: 'waitForTabPaint', targetId: 'TARGET_1' }],
  );
});

test('activateTab rejects unknown source or tab aliases', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();

  await assert.rejects(session.activateTab('Mystery', 'home'), /unknown source/i);
  await assert.rejects(session.activateTab('BrowserA', 'missing'), /unknown tab/i);
});

test('navigateTab rejects unknown source or tab aliases', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();

  await assert.rejects(session.navigateTab('BrowserA', 'missing', 'https://example.com/x'), /unknown tab/i);
});

test('start rejects browser sources that disable tab preload', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        lazy: { url: 'https://example.com/lazy', preload: false },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await assert.rejects(session.start(), /preload/i);
  assert.deepEqual(session.getRegistry().sources, {});
});

test('start rejects when a preloaded tab lands in a different window than its source', async () => {
  const cdpClient = createFakeCdpClient();
  cdpClient.createTab = async ({ url }) => {
    cdpClient.calls.push({ type: 'createTab', url });
    return { targetId: 'TARGET_2', windowId: 999 };
  };
  const sources = createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await assert.rejects(session.start(), /same chrome window/i);
  assert.deepEqual(session.getRegistry().sources, {});
});

test('stop disconnects the cdp client and clears the registry', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }));
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();
  await session.stop();

  assert.deepEqual(
    cdpClient.calls.map((call) => call.type).filter((type) => type === 'disconnect'),
    ['disconnect'],
  );
  assert.deepEqual(session.getRegistry().sources, {});
  assert.equal(session.getStatus().connected, false);
});

test('stop disconnects without closing individual targets to avoid hanging on degraded transports', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();
  await session.stop();

  assert.equal(
    cdpClient.calls.some((call) => call.type === 'closeTarget'),
    false,
  );
  assert.deepEqual(
    cdpClient.calls.map((call) => call.type).filter((type) => type === 'disconnect'),
    ['disconnect'],
  );
});

test('restart recreates a fresh source/tab registry with new runtime handles', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();
  const firstHandle = session.getRegistry().sources.BrowserA.tabs.home.targetId;

  await session.stop();
  await session.start();
  const secondHandle = session.getRegistry().sources.BrowserA.tabs.home.targetId;

  assert.notEqual(firstHandle, secondHandle);
  assert.equal(session.getRegistry().sources.BrowserA.activeTab, 'home');
});

test('getStatus reports ready per source after start', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();

  assert.deepEqual(session.getStatus(), {
    connected: true,
    chromePid: 47213,
    phase: 'connected',
    sources: {
      BrowserA: { ready: true, activeTab: 'home', tabs: ['home', 'checkout'] },
    },
  });
});

test('getStatus reports degraded state before start and after an unexpected disconnect', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }));
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient, timer: createFakeTimer() });

  assert.deepEqual(session.getStatus(), {
    connected: false,
    chromePid: null,
    phase: 'disconnected',
    sources: {},
  });

  await session.start();
  cdpClient.simulateDisconnect();

  const status = session.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.phase, 'reconnecting');
  assert.equal(status.sources.BrowserA.ready, false);
});

test('start resets state after a cdp client connect failure so a later retry can succeed', async () => {
  let attempts = 0;
  const sources = createSources(createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }));
  const session = createBrowserSession({
    sources,
    createCdpClient: () => {
      const cdpClient = createFakeCdpClient();
      cdpClient.connect = async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error('chrome unreachable');
        }

        cdpClient.calls.push({ type: 'connect' });
      };
      cdpClient.isConnected = () => attempts > 1;
      cdpClient.getChromePid = () => (attempts > 1 ? 47213 : null);
      return cdpClient;
    },
  });

  await assert.rejects(session.start(), /chrome unreachable/);
  assert.equal(session.getStatus().connected, false);

  await assert.doesNotReject(session.start());
  assert.equal(session.getStatus().connected, true);
});

test('start resolves macWindowId per browser source by diffing window ids around createWindow', async () => {
  const cdpClient = createFakeCdpClient();
  const windows = [{ windowId: 100, x: 0, y: 0, width: 800, height: 600 }];
  const enumerateWindowIdsByPidFn = (pid) => {
    assert.equal(pid, 47213);
    return [...windows];
  };
  const realCreateWindow = cdpClient.createWindow;
  cdpClient.createWindow = async (details) => {
    const result = await realCreateWindow(details);
    windows.push({ windowId: 5000, x: 0, y: 0, width: 1280, height: 800 });
    return result;
  };
  const sources = createSources(createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }));
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient, enumerateWindowIdsByPidFn });

  await session.start();

  assert.equal(session.getRegistry().sources.BrowserA.macWindowId, 5000);
});

test('start picks the largest-bounds window when createWindow surfaces several new entries', async () => {
  const cdpClient = createFakeCdpClient();
  const windows = [{ windowId: 100, x: 0, y: 0, width: 800, height: 600 }];
  const enumerateWindowIdsByPidFn = () => [...windows];
  const realCreateWindow = cdpClient.createWindow;
  cdpClient.createWindow = async (details) => {
    const result = await realCreateWindow(details);
    windows.push({ windowId: 5001, x: 0, y: 0, width: 100, height: 30 });
    windows.push({ windowId: 5002, x: 0, y: 0, width: 1280, height: 800 });
    return result;
  };
  const sources = createSources(createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }));
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient, enumerateWindowIdsByPidFn });

  await session.start();

  assert.equal(session.getRegistry().sources.BrowserA.macWindowId, 5002);
});

test('start leaves macWindowId unresolved when the new window never appears in CGWindowList', async () => {
  const cdpClient = createFakeCdpClient();
  const enumerateWindowIdsByPidFn = () => [{ windowId: 100, x: 0, y: 0, width: 800, height: 600 }];
  const sources = createSources(createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }));
  const session = createBrowserSession({
    sources,
    createCdpClient: () => cdpClient,
    enumerateWindowIdsByPidFn,
    resolveMacWindowMaxAttempts: 2,
    resolveMacWindowRetryMs: 1,
  });

  await session.start();

  assert.equal(session.getRegistry().sources.BrowserA.macWindowId, null);
});

test('start leaves macWindowId null when window enumeration is not wired', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }));
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();

  assert.equal(session.getRegistry().sources.BrowserA.macWindowId, null);
});

test('openAuxWindow requests the teleprompter initial size, reuses the tracked window on focus, and recreates it on reopen', async () => {
  const cdpClient = createFakeCdpClient();
  const windows = [{ windowId: 100, x: 0, y: 0, width: 800, height: 600 }];
  const session = createBrowserSession({
    sources: {},
    createCdpClient: () => cdpClient,
    enumerateWindowIdsByPidFn: () => [...windows],
  });
  const realCreateWindow = cdpClient.createWindow;
  let nextWindowId = 5000;
  cdpClient.createWindow = async (details) => {
    const result = await realCreateWindow(details);
    windows.push({ windowId: nextWindowId, x: 0, y: 0, width: 1280, height: 800 });
    nextWindowId += 1;
    return result;
  };

  await session.start();
  await session.openAuxWindow({
    key: 'presenter-teleprompter',
    title: 'Deckhand Presenter',
    url: 'http://127.0.0.1:3001/presenter/teleprompter.html',
  });
  await session.openAuxWindow({
    key: 'presenter-teleprompter',
    title: 'Deckhand Presenter',
    url: 'http://127.0.0.1:3001/presenter/teleprompter.html',
  });
  await session.openAuxWindow({
    key: 'presenter-teleprompter',
    title: 'Deckhand Presenter',
    url: 'http://127.0.0.1:3001/presenter/teleprompter.html',
    reopen: true,
  });

  assert.deepEqual(cdpClient.calls.filter((call) => call.type === 'createWindow').length, 2);
  assert.deepEqual(cdpClient.calls.filter((call) => call.type === 'activateTab' && call.targetId === 'TARGET_1').length, 2);
  assert.deepEqual(cdpClient.calls.find((call) => call.type === 'createWindow'), {
    type: 'createWindow',
    url: 'http://127.0.0.1:3001/presenter/teleprompter.html',
    width: 500,
    height: 700,
  });
  assert.deepEqual(session.getRegistry().auxWindows['presenter-teleprompter'], {
    key: 'presenter-teleprompter',
    targetId: 'TARGET_2',
    cdpWindowId: 92,
    macWindowId: 5001,
    title: 'Deckhand Presenter',
    url: 'http://127.0.0.1:3001/presenter/teleprompter.html',
  });
});

test('openAuxWindow does not request teleprompter sizing for unrelated auxiliary windows', async () => {
  const cdpClient = createFakeCdpClient();
  const session = createBrowserSession({ sources: {}, createCdpClient: () => cdpClient });

  await session.start();
  await session.openAuxWindow({
    key: 'presenter-console',
    title: 'Deckhand Console',
    url: 'http://127.0.0.1:3001/presenter/',
  });

  assert.deepEqual(cdpClient.calls.find((call) => call.type === 'createWindow'), {
    type: 'createWindow',
    url: 'http://127.0.0.1:3001/presenter/',
  });
});

test('openAuxWindow prefers the new window whose bounds match the teleprompter size', async () => {
  const cdpClient = createFakeCdpClient();
  const windows = [{ windowId: 100, x: 0, y: 0, width: 800, height: 600 }];
  const session = createBrowserSession({
    sources: {},
    createCdpClient: () => cdpClient,
    enumerateWindowIdsByPidFn: () => [...windows],
  });
  const realCreateWindow = cdpClient.createWindow;
  cdpClient.createWindow = async (details) => {
    const result = await realCreateWindow(details);
    windows.push({ windowId: 5000, x: 0, y: 0, width: 1280, height: 800 });
    windows.push({ windowId: 5001, x: 0, y: 0, width: 500, height: 700 });
    return result;
  };

  await session.start();
  const auxWindow = await session.openAuxWindow({
    key: 'presenter-teleprompter',
    title: 'Deckhand Presenter',
    url: 'http://127.0.0.1:3001/presenter/teleprompter.html',
  });

  assert.equal(auxWindow.macWindowId, 5001);
});

test('stop explicitly closes tracked auxiliary windows before disconnecting chrome', async () => {
  const cdpClient = createFakeCdpClient();
  const session = createBrowserSession({ sources: {}, createCdpClient: () => cdpClient });

  await session.start();
  await session.openAuxWindow({
    key: 'presenter-teleprompter',
    title: 'Deckhand Presenter',
    url: 'http://127.0.0.1:3001/presenter/teleprompter.html',
  });
  await session.stop();

  assert.equal(cdpClient.calls.some((call) => call.type === 'closeTarget' && call.targetId === 'TARGET_1'), true);
});

function createFakeTimer() {
  const pending = [];

  return {
    setTimeout(fn, ms) {
      const handle = { fn, ms, done: false };
      pending.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) {
        handle.done = true;
      }
    },
    delays() {
      return pending.map((handle) => handle.ms);
    },
    activeDelays() {
      return pending.filter((handle) => !handle.done).map((handle) => handle.ms);
    },
    async run(count) {
      let executed = 0;

      while (executed < count && pending.some((handle) => !handle.done)) {
        const handle = pending.find((entry) => !entry.done);
        handle.done = true;
        await handle.fn();
        executed += 1;
      }
    },
  };
}

function createRecoverableSources() {
  return createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
}

test('an unexpected disconnect emits transportLost then recovers and rebuilds the registry with fresh target ids', async () => {
  const cdpClient = createFakeCdpClient();
  const timer = createFakeTimer();
  const events = [];
  const session = createBrowserSession({
    sources: createRecoverableSources(),
    createCdpClient: () => cdpClient,
    timer,
  });
  session.on('transportLost', () => events.push('transportLost'));
  session.on('recovered', () => events.push('recovered'));

  await session.start();
  const firstTarget = session.getRegistry().sources.BrowserA.tabs.home.targetId;

  cdpClient.simulateDisconnect();

  assert.deepEqual(events, ['transportLost']);
  assert.equal(session.getStatus().phase, 'reconnecting');

  await timer.run(5);

  assert.deepEqual(events, ['transportLost', 'recovered']);
  assert.equal(session.getStatus().phase, 'connected');

  const secondTarget = session.getRegistry().sources.BrowserA.tabs.home.targetId;
  assert.notEqual(firstTarget, secondTarget);
  assert.equal(session.getRegistry().sources.BrowserA.activeTab, 'home');
});

test('browser session recover retries with backoff when the first reconnect attempt fails', async () => {
  const cdpClient = createFakeCdpClient();
  const timer = createFakeTimer();
  const events = [];
  let connectCalls = 0;
  const realConnect = cdpClient.connect;
  cdpClient.connect = async () => {
    connectCalls += 1;
    if (connectCalls === 2) {
      throw new Error('chrome unreachable');
    }
    await realConnect.call(cdpClient);
  };
  const session = createBrowserSession({
    sources: createRecoverableSources(),
    createCdpClient: () => cdpClient,
    timer,
  });
  session.on('recovered', () => events.push('recovered'));

  await session.start();
  cdpClient.simulateDisconnect();

  await timer.run(5);

  assert.deepEqual(events, ['recovered']);
  assert.equal(connectCalls, 3);
  assert.equal(session.getStatus().phase, 'connected');
});

test('browser commands reject with a recovering error while a rebuild is in flight', async () => {
  const cdpClient = createFakeCdpClient();
  const timer = createFakeTimer();
  const session = createBrowserSession({
    sources: createRecoverableSources(),
    createCdpClient: () => cdpClient,
    timer,
  });

  await session.start();
  cdpClient.simulateDisconnect();

  await assert.rejects(session.activateTab('BrowserA', 'home'), /recovering/i);
  await assert.rejects(session.navigateTab('BrowserA', 'home', 'https://example.com/x'), /recovering/i);
});

test('stop suppresses an in-flight browser recovery', async () => {
  const cdpClient = createFakeCdpClient();
  const timer = createFakeTimer();
  const events = [];
  const session = createBrowserSession({
    sources: createRecoverableSources(),
    createCdpClient: () => cdpClient,
    timer,
  });
  session.on('recovered', () => events.push('recovered'));

  await session.start();
  cdpClient.simulateDisconnect();

  await session.stop();
  await timer.run(5);

  assert.deepEqual(events, []);
  assert.equal(session.getStatus().phase, 'disconnected');
});

test('browser session recovery can be disabled so a disconnect stays down', async () => {
  const cdpClient = createFakeCdpClient();
  const timer = createFakeTimer();
  const events = [];
  const session = createBrowserSession({
    sources: createRecoverableSources(),
    createCdpClient: () => cdpClient,
    timer,
    recovery: {
      browserRecover: { enabled: false, initialDelayMs: 500, maxDelayMs: 10000 },
    },
  });
  session.on('transportLost', () => events.push('transportLost'));
  session.on('recovered', () => events.push('recovered'));

  await session.start();
  cdpClient.simulateDisconnect();

  assert.deepEqual(events, ['transportLost']);
  assert.equal(timer.delays().length, 0);
  assert.equal(session.getStatus().phase, 'disconnected');
});

test('relaunchBrowserSource rebuilds a single source window with fresh runtime handles', async () => {
  const cdpClient = createFakeCdpClient();
  const windows = [{ windowId: 100, width: 800, height: 600 }];
  const enumerateWindowIdsByPidFn = () => [...windows];
  let nextWindow = 5000;
  const realCreateWindow = cdpClient.createWindow;
  cdpClient.createWindow = async (details) => {
    const result = await realCreateWindow(details);
    windows.push({ windowId: nextWindow, width: 1280, height: 800 });
    nextWindow += 1;
    return result;
  };
  const sources = createSources(
    createBrowserSource(
      'BrowserA',
      {
        home: { url: 'https://example.com/home' },
        checkout: { url: 'https://example.com/checkout' },
      },
      { initialTab: 'home' },
    ),
  );
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient, enumerateWindowIdsByPidFn });

  await session.start();
  const firstTarget = session.getRegistry().sources.BrowserA.tabs.home.targetId;
  assert.equal(session.getRegistry().sources.BrowserA.macWindowId, 5000);

  const result = await session.relaunchBrowserSource('BrowserA');

  const after = session.getRegistry().sources.BrowserA;

  assert.notEqual(after.tabs.home.targetId, firstTarget, 'the source window is rebuilt with a fresh target id');
  assert.equal(after.macWindowId, 5001);
  assert.deepEqual(result, { macWindowId: 5001 });
});

test('relaunchBrowserSource rejects an unknown or non-browser source id', async () => {
  const cdpClient = createFakeCdpClient();
  const sources = createSources(createBrowserSource('BrowserA', { home: { url: 'https://example.com/home' } }));
  const session = createBrowserSession({ sources, createCdpClient: () => cdpClient });

  await session.start();

  await assert.rejects(session.relaunchBrowserSource('Mystery'), /unknown browser source/i);
});

test('relaunchBrowserSource rejects while a recovery is in flight', async () => {
  const cdpClient = createFakeCdpClient();
  const timer = createFakeTimer();
  const session = createBrowserSession({
    sources: createRecoverableSources(),
    createCdpClient: () => cdpClient,
    timer,
  });

  await session.start();
  cdpClient.simulateDisconnect();

  await assert.rejects(session.relaunchBrowserSource('BrowserA'), /recovering/i);
});
