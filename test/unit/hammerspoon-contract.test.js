import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Probe lua once at module scope: on a macOS box without lua installed the
// spawns below would fail with a spawnSync ENOENT instead of skipping.
const luaProbe = spawnSync('lua', ['-v'], { encoding: 'utf8' });
const luaAvailable = luaProbe.error === undefined && luaProbe.status === 0;

// `skip: false` runs the test; a string skips with that reason.
const luaContractSkipReason = process.platform !== 'darwin' || !luaAvailable
  ? 'lua is unavailable or the platform is not macOS; the Hammerspoon Lua contract tests need both'
  : false;

function runLuaScript(scriptName) {
  return spawnSync('lua', [path.join(repoRoot, 'test/hammerspoon', scriptName)], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('Lua Hammerspoon apply_state contract holds', { skip: luaContractSkipReason }, () => {
  const result = runLuaScript('apply_state_contract.lua');

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Lua Hammerspoon deckhand observer contract holds', { skip: luaContractSkipReason }, () => {
  const result = runLuaScript('deckhand_contract.lua');

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Lua Hammerspoon window_match contract holds', { skip: luaContractSkipReason }, () => {
  const result = runLuaScript('window_match_contract.lua');

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
