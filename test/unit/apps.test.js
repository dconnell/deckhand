import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAppAdapter } from '../../src/apps/index.js';

test('resolveAppAdapter returns the default adapter for a generic app source', () => {
  const adapter = resolveAppAdapter({ id: 'Editor', kind: 'app', app: 'Slack' });

  assert.equal(adapter.id, 'default');
  assert.deepEqual(adapter.confirm, { stableSamples: 2 });
});

test('resolveAppAdapter default keeps CGWindow owner equal to source.app for Slack (verified bundle name)', () => {
  // Slack's CFBundleName and kCGWindowOwnerName are both `Slack` — no adapter
  // needed. This test pins that assumption so a future change to default.js
  // can't silently regress Slack window enumeration.
  const adapter = resolveAppAdapter({ id: 'Comms', kind: 'app', app: 'Slack' });

  assert.equal(adapter.cgWindowOwnerName({ app: 'Slack' }), 'Slack');
});

test('resolveAppAdapter matches VS Code aliases', () => {
  assert.equal(resolveAppAdapter({ id: 'Editor', kind: 'app', app: 'Visual Studio Code' }).id, 'vscode');
  assert.equal(resolveAppAdapter({ id: 'Editor', kind: 'app', app: 'Code' }).id, 'vscode');
});

test('resolveAppAdapter matches iTerm aliases', () => {
  assert.equal(resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'iTerm2' }).id, 'iterm2');
  assert.equal(resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'iTerm' }).id, 'iterm2');
});

test('resolveAppAdapter matches Apple Terminal aliases and maps to the Terminal CGWindow owner', () => {
  const adapter = resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'Terminal' });

  assert.equal(adapter.id, 'appleTerminal');
  assert.equal(adapter.cgWindowOwnerName(), 'Terminal');
  assert.deepEqual(
    adapter.buildBootstrapBinding({ kind: 'app', app: 'Terminal' }, { titleIncludes: 'demo' }),
    { app: 'Terminal', titleIncludes: 'demo' },
  );

  assert.equal(resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'terminal.app' }).id, 'appleTerminal');
  assert.equal(resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'Apple Terminal' }).id, 'appleTerminal');
});

test('resolveAppAdapter matches Ghostty and maps to the Ghostty CGWindow owner', () => {
  const adapter = resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'Ghostty' });

  assert.equal(adapter.id, 'ghostty');
  assert.equal(adapter.cgWindowOwnerName(), 'Ghostty');
  assert.deepEqual(
    adapter.buildBootstrapBinding({ kind: 'app', app: 'Ghostty' }, { titleIncludes: 'demo' }),
    { app: 'Ghostty', titleIncludes: 'demo' },
  );
});

test('resolveAppAdapter matches Alacritty and maps to the Alacritty CGWindow owner', () => {
  const adapter = resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'Alacritty' });

  assert.equal(adapter.id, 'alacritty');
  assert.equal(adapter.cgWindowOwnerName(), 'Alacritty');
  assert.equal(adapter.discardUnsavedChangesOnClose, false);
  assert.equal(typeof adapter.launch, 'function');
  assert.equal('close' in adapter, false);
});

test('resolveAppAdapter matches kitty and maps to the lowercase kitty CGWindow owner', () => {
  const adapter = resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'kitty' });

  assert.equal(adapter.id, 'kitty');
  assert.equal(adapter.cgWindowOwnerName(), 'kitty');
  assert.equal(typeof adapter.close, 'function');
});

test('terminal adapter close hooks await the async close primitive before resolving', async () => {
  // The close primitives became async with the Phase B conversion; a
  // fire-and-forget close here would let shutdown race the close subprocess.
  const { ghosttyAdapter } = await import('../../src/apps/ghostty.js');
  const { kittyAdapter } = await import('../../src/apps/kitty.js');
  const { appleTerminalAdapter } = await import('../../src/apps/appleTerminal.js');
  const { alacrittyAdapter } = await import('../../src/apps/alacritty.js');

  let settled = false;

  const slowClose = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    settled = true;
  };

  assert.equal(
    await ghosttyAdapter.close({ binding: { ghosttyWindowId: 'tab-group-xyz' } }, { closeGhosttyOwnedWindow: slowClose }),
    true,
  );
  assert.equal(settled, true, 'ghostty close must await the close primitive');

  settled = false;
  assert.equal(
    await kittyAdapter.close({ binding: { kittyWindowId: '42' } }, { closeKittyOwnedWindow: slowClose }),
    true,
  );
  assert.equal(settled, true, 'kitty close must await the close primitive');

  settled = false;
  assert.equal(
    await appleTerminalAdapter.close({ binding: { terminalWindowId: '5001' } }, { closeTerminalOwnedWindow: slowClose }),
    true,
  );
  assert.equal(settled, true, 'appleTerminal close must await the close primitive');

  const slowLaunch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    settled = true;

    return { pid: 1 };
  };

  settled = false;
  await alacrittyAdapter.launch({ command: 'npm run dev', cwd: '/repos/demo' }, { launchAlacrittyWindow: slowLaunch });
  assert.equal(settled, true, 'alacritty launch must await the launch primitive');
});
