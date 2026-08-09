import assert from 'node:assert/strict';
import test from 'node:test';

import { createElectronAdapter } from '../../src/apps/electron.js';

function baseConfig(overrides = {}) {
  return {
    id: 'test-electron',
    aliases: ['demo', 'demo-app'],
    cgWindowOwnerName: 'DemoHelper',
    bootstrapAppName: 'Demo',
    ...overrides,
  };
}

test('createElectronAdapter always sets the splash-rejection confirm policy shared by Electron apps', () => {
  const adapter = createElectronAdapter(baseConfig());

  assert.deepEqual(adapter.confirm, { stableSamples: 2 });
});

test('createElectronAdapter matches aliases case-insensitively and rejects unknown apps', () => {
  const adapter = createElectronAdapter(baseConfig());

  assert.equal(adapter.matches({ app: 'Demo' }), true);
  assert.equal(adapter.matches({ app: 'DEMO-app' }), true);
  assert.equal(adapter.matches({ app: 'other' }), false);
  assert.equal(adapter.matches({}), false);
  assert.equal(adapter.matches({ app: 42 }), false);
  assert.equal(adapter.matches({ app: null }), false);
});

test('createElectronAdapter exposes the configured CGWindow owner name and bootstrap app name', () => {
  const adapter = createElectronAdapter(baseConfig());

  assert.equal(adapter.cgWindowOwnerName(), 'DemoHelper');
  assert.deepEqual(
    adapter.buildBootstrapBinding(
      { kind: 'app', app: 'demo' },
      { titleIncludes: 'Workspace X' },
    ),
    { app: 'Demo', titleIncludes: 'Workspace X' },
  );
});

test('createElectronAdapter buildBootstrapBinding preserves no configuredBinding by defaulting to empty object', () => {
  const adapter = createElectronAdapter(baseConfig());

  assert.deepEqual(adapter.buildBootstrapBinding({ kind: 'app', app: 'demo' }), {
    app: 'Demo',
  });
});

test('createElectronAdapter omits discardUnsavedChangesOnClose when not configured', () => {
  const adapter = createElectronAdapter(baseConfig());

  assert.equal('discardUnsavedChangesOnClose' in adapter, false);
});

test('createElectronAdapter forwards discardUnsavedChangesOnClose when configured', () => {
  const adapter = createElectronAdapter(baseConfig({ discardUnsavedChangesOnClose: true }));

  assert.equal(adapter.discardUnsavedChangesOnClose, true);
});

test('createElectronAdapter forwards buildLaunchArgs when supplied', () => {
  const adapter = createElectronAdapter(baseConfig({
    buildLaunchArgs: (source) => ['--new-window', ...(source.args ?? [])],
  }));

  assert.deepEqual(adapter.buildLaunchArgs({ args: ['/repo'] }), ['--new-window', '/repo']);
});

test('createElectronAdapter omits buildLaunchArgs when not supplied', () => {
  const adapter = createElectronAdapter(baseConfig());

  assert.equal('buildLaunchArgs' in adapter, false);
});
