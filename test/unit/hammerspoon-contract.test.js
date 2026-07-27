import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function runLuaScript(scriptName) {
  return spawnSync('lua', [path.join(repoRoot, 'test/hammerspoon', scriptName)], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('Lua Hammerspoon apply_state contract holds', { skip: process.platform !== 'darwin' }, () => {
  const result = runLuaScript('apply_state_contract.lua');

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Lua Hammerspoon deckhand observer contract holds', { skip: process.platform !== 'darwin' }, () => {
  const result = runLuaScript('deckhand_contract.lua');

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
