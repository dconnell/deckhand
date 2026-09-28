import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { run } from '../../../src/index.js';
import { withPatchedExit } from '../../helpers/process.js';
import { waitForCondition } from '../../helpers/waitFor.js';
import {
  createCdpClientStub,
  createHubStub,
  createObsClientStub,
  createPresentationServerStub,
  createSilentConsole,
  writePresentationConfig,
} from './helpers.js';

/**
 * Browser-only presenter config (no owned app sources) so the test only needs
 * the Chrome runtime stubs. `chrome` is injected verbatim so each test picks
 * the generated-vs-configured profile-dir mode it exercises.
 * @param {{ chrome?: Record<string, unknown> }} [options]
 * @returns {string} serialized config
 */
function buildBrowserShutdownConfig({ chrome } = {}) {
  return JSON.stringify({
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { port: 8765 },
    ...(chrome === undefined ? {} : { chrome }),
    sources: {
      Slide: { kind: 'browser', browser: { tabs: { deck: { url: 'http://127.0.0.1:3000/deck/', initial: true } } } },
    },
    layouts: {
      'full-slide': { audienceScene: 'Full Slide', slots: [{ source: 'Slide', position: 'full' }] },
    },
    slides: { intro: { layout: 'full-slide' } },
  }, null, 2);
}

/**
 * Run options that drive a full `run()` startup with a stubbed Chrome/CDP
 * runtime, capturing the profile dir the launcher received. The stubbed CDP
 * client calls `discover()` on connect, which is what makes `run()` actually
 * launch Chrome. Kill/reap hooks are stubbed so no real process or `pkill`
 * side effect can hit the developer's machine.
 * @param {{ onLaunch: (launchOptions: { profileDir: string, profileName?: string }) => Promise<{ chromePid: number, debugPort: number, profileDir: string, profileName: string | null, stop: () => Promise<void> }> }} inputs
 * @returns {object} run options
 */
function buildCleanupRunOptions({ onLaunch }) {
  return {
    installSignalHandlers: false,
    preflightEnumerateWindowsFn: () => [],
    killProcessGroupFn: () => {},
    reapChromeProfilesFn: () => {},
    consoleLike: createSilentConsole(),
    createHubFn() {
      return createHubStub();
    },
    createObsClientFn() {
      return createObsClientStub();
    },
    launchChromeSessionFn: onLaunch,
    discoverCdpEndpointFn: async () => ({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
      chromePid: null,
    }),
    createCdpClientFn({ discover }) {
      const stub = createCdpClientStub(47213);
      return {
        ...stub,
        async connect() {
          await discover();
        },
      };
    },
    createBrowserSessionFn({ createCdpClient }) {
      const cdpClient = createCdpClient();
      return {
        async start() {
          await cdpClient.connect();
        },
        async stop() {
          await cdpClient.disconnect();
        },
        async openWindow() {},
        async openAuxWindow() {
          return { key: 'mock', targetId: 'TARGET_MOCK', cdpWindowId: 999, macWindowId: null, title: 'Mock', url: '' };
        },
        async measureMinimumWindowSize() {
          return null;
        },
        getStatus() {
          return { connected: true, chromePid: 47213, sources: {} };
        },
        getRegistry() {
          return { sources: { Slide: { title: 'Deckhand Deck' } } };
        },
        on() {},
        async activateTab() {},
        async navigateTab() {},
      };
    },
    createCoordinatorFn({ browserSession }) {
      return {
        async start() {
          await browserSession.start();
        },
        async stop() {
          await browserSession.stop();
        },
        getCurrentPresentationState() {
          return null;
        },
      };
    },
    createPresentationServerFn() {
      return createPresentationServerStub();
    },
    reconcileObsFn: async () => {},
    waitForDriverPositionFn: async () => {},
    waitForPresentationObserverFn: async () => {},
    resolveMacWindowBindingsFn: async () => ({
      Slide: { macWindowId: 11111, pid: 47213 },
    }),
  };
}

/**
 * Mark a directory as "in use by Chrome" so a no-op cleanup cannot pass the
 * test by accident.
 * @param {string} dir Directory to populate.
 * @returns {Promise<void>}
 */
async function simulateChromeProfileContents(dir) {
  await mkdir(path.join(dir, 'Default'), { recursive: true });
  await writeFile(path.join(dir, 'Default', 'Cookies'), 'stub');
}

async function assertMissing(dir, message) {
  await assert.rejects(() => access(dir), { code: 'ENOENT' }, message);
}

async function assertPresent(dir, message) {
  await assert.ok((await access(dir).then(() => true, () => false)), message);
}

function failExit() {
  throw new Error('EXIT_CALLED');
}

test('run removes the generated temp Chrome profile directory on shutdown', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-profile-cleanup-'));
  let capturedProfileDir = null;

  try {
    await writePresentationConfig(tempDir, 'profile-cleanup', buildBrowserShutdownConfig());

    await withPatchedExit(async (exitCalls) => {
      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'profile-cleanup',
        ...buildCleanupRunOptions({
          async onLaunch(launchOptions) {
            capturedProfileDir = launchOptions.profileDir;
            return {
              chromePid: 47213,
              debugPort: 9222,
              profileDir: launchOptions.profileDir,
              profileName: launchOptions.profileName ?? null,
              async stop() {},
            };
          },
        }),
        installSignalHandlers: true,
      });

      assert.equal(exitCode, 0);
      assert.ok(capturedProfileDir !== null, 'run launched Chrome with a profile dir');
      assert.ok(
        capturedProfileDir.includes(path.join(os.tmpdir(), 'deckhand-chrome-profiles')),
        `expected a generated temp profile dir, got ${capturedProfileDir}`,
      );

      await simulateChromeProfileContents(capturedProfileDir);

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });

    await assertMissing(capturedProfileDir, 'the generated temp profile dir must be removed on shutdown');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run never removes a configured chrome.profileDir on shutdown', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-profile-kept-'));
  const configuredProfileDir = path.join(tempDir, 'operator-owned-profile');
  let capturedProfileDir = null;

  try {
    await writePresentationConfig(tempDir, 'profile-kept', buildBrowserShutdownConfig({
      chrome: { profileDir: configuredProfileDir },
    }));

    await withPatchedExit(async (exitCalls) => {
      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'profile-kept',
        ...buildCleanupRunOptions({
          async onLaunch(launchOptions) {
            capturedProfileDir = launchOptions.profileDir;
            return {
              chromePid: 47213,
              debugPort: 9222,
              profileDir: launchOptions.profileDir,
              profileName: launchOptions.profileName ?? null,
              async stop() {},
            };
          },
        }),
        installSignalHandlers: true,
      });

      assert.equal(exitCode, 0);
      assert.equal(capturedProfileDir, configuredProfileDir, 'the configured profile dir is passed to the launcher');

      await simulateChromeProfileContents(configuredProfileDir);

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });

    await assertPresent(configuredProfileDir, 'a configured profile dir is operator-owned and must survive shutdown');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run removes the named-profile mkdtemp working copy but not its configured parent on shutdown', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-profile-named-'));
  const configuredProfileDir = path.join(tempDir, 'operator-owned-profile');
  const workingCopyDir = path.join(tempDir, 'deckhand-profile-working-copy');
  let capturedLaunch = null;

  try {
    await writePresentationConfig(tempDir, 'profile-named', buildBrowserShutdownConfig({
      chrome: { profileDir: configuredProfileDir, profileName: 'Work' },
    }));

    await withPatchedExit(async (exitCalls) => {
      // The operator-owned dir exists before the run; only the working copy
      // is created by the launch, mirroring the real launcher.
      await simulateChromeProfileContents(configuredProfileDir);
      const exitCode = await run({
        cwd: tempDir,
        presentationName: 'profile-named',
        ...buildCleanupRunOptions({
          // Mirror chromeLauncher.prepareProfileDir: a named profile always
          // runs from a fresh working copy, so the launch result's profileDir
          // is NOT the configured dir.
          async onLaunch(launchOptions) {
            await simulateChromeProfileContents(workingCopyDir);
            capturedLaunch = launchOptions;
            return {
              chromePid: 47213,
              debugPort: 9222,
              profileDir: workingCopyDir,
              profileName: launchOptions.profileName ?? null,
              async stop() {},
            };
          },
        }),
        installSignalHandlers: true,
      });

      assert.equal(exitCode, 0);
      assert.equal(capturedLaunch?.profileName, 'Work');

      try {
        process.emit('SIGTERM');
      } catch {
        // process.exit inside the handler throws — expected
      }

      await waitForCondition(() => exitCalls.length > 0, { description: 'the SIGTERM shutdown handler to call process.exit' });
    }, { onExit: failExit });

    await assertMissing(workingCopyDir, 'the mkdtemp working copy is temporary and must be removed on shutdown');
    await assertPresent(configuredProfileDir, 'the configured parent profile dir must survive shutdown');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run removes the generated temp Chrome profile directory when startup fails', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-profile-fail-'));
  let capturedProfileDir = null;
  let chromeStopCalls = 0;

  try {
    await writePresentationConfig(tempDir, 'profile-fail', buildBrowserShutdownConfig());

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'profile-fail',
      ...buildCleanupRunOptions({
        async onLaunch(launchOptions) {
          capturedProfileDir = launchOptions.profileDir;
          await simulateChromeProfileContents(launchOptions.profileDir);
          return {
            chromePid: 47213,
            debugPort: 9222,
            profileDir: launchOptions.profileDir,
            profileName: launchOptions.profileName ?? null,
            async stop() {
              chromeStopCalls += 1;
            },
          };
        },
      }),
      createCoordinatorFn({ browserSession }) {
        return {
          async start() {
            // Launch Chrome (via the browser session) first so the failure
            // path below has a launched session to clean up.
            await browserSession.start();
            throw new Error('startup exploded');
          },
          async stop() {},
          getCurrentPresentationState() {
            return null;
          },
        };
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(chromeStopCalls, 1, 'the launched Chrome is stopped on the failure path');
    await assertMissing(capturedProfileDir, 'the generated temp profile dir must be removed when startup fails');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
