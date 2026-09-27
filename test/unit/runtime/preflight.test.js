import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { run } from '../../../src/index.js';
import {
  createHubStub,
  createObsClientStub,
  createPresentationServerStub,
  createSilentConsole,
  writePresentationConfig,
} from './helpers.js';

/**
 * Minimal presenter-less config whose only source is a VS Code app window:
 * the Electron adapter gates on an already-running instance. `sourceArgs`
 * optionally names a workspace (e.g. `['--new-window', '/path/to/repo']`),
 * which scopes the preflight gate to windows of THAT project.
 * @param {{ sourceArgs?: string[] }} [options]
 * @returns {string} serialized config
 */
function createVscodeAppConfig({ sourceArgs } = {}) {
  return JSON.stringify({
    driver: { type: 'revealjs' },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    hub: { port: 8765 },
    sources: {
      Editor: sourceArgs === undefined
        ? { kind: 'app', app: 'Visual Studio Code' }
        : { kind: 'app', app: 'Visual Studio Code', args: sourceArgs },
    },
    layouts: {
      'full-slide': {
        audienceScene: 'Full Slide',
        slots: [{ source: 'Editor', position: 'full' }],
      },
    },
    slides: {
      intro: { layout: 'full-slide' },
    },
  }, null, 2);
}

/**
 * Create a temp bin dir containing a fake `code` CLI so the preflight
 * workspace probe (`code --status` on the real vscode adapter) is
 * deterministic: without it the operator's installed CLI would decide which
 * preflight path (probe vs enumeration fallback) the run takes.
 * @param {string} tempDir
 * @param {string} statusScriptBody
 * @returns {Promise<string>} the stub bin dir
 */
async function createCodeStubBin(tempDir, statusScriptBody) {
  const binDir = path.join(tempDir, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, 'code'),
    `#!/bin/sh\n${statusScriptBody}`,
    { encoding: 'utf8', mode: 0o755 },
  );
  return binDir;
}

/** Point PATH exclusively at `binDir` so only the stubbed `code` is resolvable. */
async function runWithPath(binDir, runFn) {
  const originalPath = process.env.PATH;
  process.env.PATH = binDir;

  try {
    return await runFn();
  } finally {
    process.env.PATH = originalPath;
  }
}

test('run refuses to start before any side effects when a gated owned app already has windows open', { skip: process.platform !== 'darwin' }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-preflight-conflict-'));
  const errors = [];
  const factoryCalls = [];

  try {
    await writePresentationConfig(tempDir, 'vscode-open', createVscodeAppConfig());

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'vscode-open',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onError: (message) => errors.push(message) }),
      preflightEnumerateWindowsFn: (ownerName) => (
        ownerName === 'Code'
          ? [
            { windowId: 1, title: 'run.js — deckhand' },
            { windowId: 2, title: 'README.md — deckhand' },
          ]
          : []
      ),
      createHubFn() {
        factoryCalls.push('hub');
        return {};
      },
      createObsClientFn() {
        factoryCalls.push('obs');
        return {};
      },
      createCoordinatorFn() {
        factoryCalls.push('coordinator');
        return {};
      },
      createPresenterHttpFn() {
        factoryCalls.push('presenterHttp');
        return {};
      },
      createPresentationServerFn() {
        factoryCalls.push('presentationServer');
        return {};
      },
      launchChromeSessionFn: async () => {
        factoryCalls.push('chrome');
        return { async stop() {} };
      },
      reconcileObsFn: async () => {
        factoryCalls.push('reconcileObs');
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(factoryCalls, [], 'no startup side effect may run before the preflight gate');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Refusing to start: owned app already running/);
    assert.match(errors[0], /- Editor: "Visual Studio Code" already has 2 window\(s\) open/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run refuses to start when the gated owned app already has the configured workspace open (enumeration fallback)', { skip: process.platform !== 'darwin' }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-preflight-workspace-'));
  const errors = [];
  const factoryCalls = [];

  try {
    await writePresentationConfig(tempDir, 'vscode-open', createVscodeAppConfig({
      sourceArgs: ['--new-window', '/Users/me/repos/dc-enclave'],
    }));

    // A failing `code` CLI forces the probe to report failure (null), so this
    // pins the enumeration-fallback message variant: the probe's success path
    // has its own test below.
    const binDir = await createCodeStubBin(tempDir, 'echo "code: status failed" >&2\nexit 1\n');

    const exitCode = await runWithPath(binDir, () => run({
      cwd: tempDir,
      presentationName: 'vscode-open',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onError: (message) => errors.push(message) }),
      // One window of the configured workspace plus one unrelated project:
      // the gate must name the workspace and count only its window.
      preflightEnumerateWindowsFn: (ownerName) => (
        ownerName === 'Code'
          ? [
            { windowId: 1, title: 'postinstall.js — dc-enclave' },
            { windowId: 2, title: 'readme — unrelated' },
          ]
          : []
      ),
      createHubFn() {
        factoryCalls.push('hub');
        return {};
      },
      createObsClientFn() {
        factoryCalls.push('obs');
        return {};
      },
      createCoordinatorFn() {
        factoryCalls.push('coordinator');
        return {};
      },
      createPresenterHttpFn() {
        factoryCalls.push('presenterHttp');
        return {};
      },
      createPresentationServerFn() {
        factoryCalls.push('presentationServer');
        return {};
      },
      launchChromeSessionFn: async () => {
        factoryCalls.push('chrome');
        return { async stop() {} };
      },
      reconcileObsFn: async () => {
        factoryCalls.push('reconcileObs');
      },
    }));

    assert.equal(exitCode, 1);
    assert.deepEqual(factoryCalls, [], 'no startup side effect may run before the preflight gate');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Refusing to start: owned app already running/);
    assert.match(errors[0], /- Editor: "Visual Studio Code" already has "dc-enclave" open \(1 window\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run refuses to start when the workspace probe reports the configured workspace open', { skip: process.platform !== 'darwin' }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-preflight-probe-'));
  const errors = [];
  const factoryCalls = [];

  try {
    await writePresentationConfig(tempDir, 'vscode-open', createVscodeAppConfig({
      sourceArgs: ['--new-window', '/Users/me/repos/dc-enclave'],
    }));

    // A working `code` CLI answers authoritatively, so the conflict message
    // carries no window count — the probe knows about workspaces, not windows
    // (it even sees multi-root folders that titles never show). The script
    // only uses shell builtins: with PATH pointing solely at the stub bin
    // dir, external binaries like `touch` would not resolve.
    const probeSentinel = path.join(tempDir, 'probe-invoked');
    const binDir = await createCodeStubBin(tempDir, [
      `echo invoked > ${probeSentinel}`,
      "echo 'Workspace Stats:'",
      "echo '|  Window (README.md — deckhand)'",
      "echo '|    Folder (dc-enclave): 1768 files'",
      'exit 0',
    ].join('\n'));

    const exitCode = await runWithPath(binDir, () => run({
      cwd: tempDir,
      presentationName: 'vscode-open',
      installSignalHandlers: false,
      consoleLike: createSilentConsole({ onError: (message) => errors.push(message) }),
      preflightEnumerateWindowsFn: () => {
        throw new Error('enumeration must not run when the probe answers');
      },
      createHubFn() {
        factoryCalls.push('hub');
        return {};
      },
      createObsClientFn() {
        factoryCalls.push('obs');
        return {};
      },
      createCoordinatorFn() {
        factoryCalls.push('coordinator');
        return {};
      },
      createPresenterHttpFn() {
        factoryCalls.push('presenterHttp');
        return {};
      },
      createPresentationServerFn() {
        factoryCalls.push('presentationServer');
        return {};
      },
      launchChromeSessionFn: async () => {
        factoryCalls.push('chrome');
        return { async stop() {} };
      },
      reconcileObsFn: async () => {
        factoryCalls.push('reconcileObs');
      },
    }));

    assert.equal(exitCode, 1);
    assert.deepEqual(factoryCalls, [], 'no startup side effect may run before the preflight gate');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Refusing to start: owned app already running/);
    assert.match(errors[0], /- Editor: "Visual Studio Code" already has "dc-enclave" open$/m);
    assert.doesNotMatch(errors[0], /\(\d+ windows?\)/);
    // The Window row is a display title, not an open-workspace signal: only
    // the Folder row may drive the conflict.
    assert.doesNotMatch(errors[0], /README\.md — deckhand/);
    assert.equal(await readFile(probeSentinel, 'utf8'), 'invoked\n', 'the probe must have run');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('run proceeds normally when the preflight finds no gated app windows open', { skip: process.platform !== 'darwin' }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-preflight-clear-'));
  const lifecycle = [];

  try {
    await writePresentationConfig(tempDir, 'vscode-open', createVscodeAppConfig());

    const exitCode = await run({
      cwd: tempDir,
      presentationName: 'vscode-open',
      installSignalHandlers: false,
      consoleLike: createSilentConsole(),
      preflightEnumerateWindowsFn: () => [],
      createHubFn() {
        return createHubStub();
      },
      createObsClientFn() {
        return createObsClientStub();
      },
      createCoordinatorFn() {
        return {
          async start() {
            lifecycle.push('coordinator.start');
          },
          async stop() {},
          getCurrentPresentationState() { return null; },
        };
      },
      createPresentationServerFn() {
        return createPresentationServerStub();
      },
      reconcileObsFn: async () => {},
      waitForDriverPositionFn: async () => {},
      resolveOwnedWindowBindingsFn: async () => ({}),
    });

    assert.equal(exitCode, 0);
    // Startup ran past the preflight gate far enough to start the coordinator.
    assert.ok(lifecycle.includes('coordinator.start'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
