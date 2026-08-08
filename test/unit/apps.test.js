import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAppAdapter } from '../../src/apps/index.js';

test('resolveAppAdapter returns the default adapter for a generic app source', () => {
  const adapter = resolveAppAdapter({ id: 'Editor', kind: 'app', app: 'Slack' });

  assert.equal(adapter.id, 'default');
  assert.deepEqual(adapter.confirm, { stableSamples: 2 });
});

test('resolveAppAdapter matches VS Code aliases', () => {
  assert.equal(resolveAppAdapter({ id: 'Editor', kind: 'app', app: 'Visual Studio Code' }).id, 'vscode');
  assert.equal(resolveAppAdapter({ id: 'Editor', kind: 'app', app: 'Code' }).id, 'vscode');
});

test('resolveAppAdapter matches iTerm aliases', () => {
  assert.equal(resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'iTerm2' }).id, 'iterm2');
  assert.equal(resolveAppAdapter({ id: 'Terminal', kind: 'app', app: 'iTerm' }).id, 'iterm2');
});
