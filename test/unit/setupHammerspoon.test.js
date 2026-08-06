import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BEGIN_SENTINEL,
  END_SENTINEL,
  DEFAULT_HUB_URL,
  HAMMERSPOON_LUA_FILES,
  renderDeckhandBlock,
  wrapWithSentinels,
  patchInitLua,
  installLuaFiles,
  ensureInitLuaBlock,
  install,
} from '../../src/setupHammerspoon.js';

test('renderDeckhandBlock emits the default hub url when none is given', () => {
  const block = renderDeckhandBlock();
  assert.match(block, new RegExp(`hubUrl = "${DEFAULT_HUB_URL}"`));
  assert.match(block, /dofile\(hs\.configdir \.\. "\/deckhand\/deckhand\.lua"\)\.start\(\{/);
});

test('renderDeckhandBlock uses a caller-provided hub url', () => {
  const block = renderDeckhandBlock({ hubUrl: 'ws://127.0.0.1:9000' });
  assert.match(block, /hubUrl = "ws:\/\/127\.0\.0\.1:9000"/);
});

test('patchInitLua creates a sentinel-wrapped block when init.lua is empty', () => {
  const result = patchInitLua('', renderDeckhandBlock());
  assert.ok(result.startsWith(BEGIN_SENTINEL));
  assert.ok(result.endsWith(END_SENTINEL + '\n'));
});

test('patchInitLua appends with a separator after existing content', () => {
  const existing = '-- my config\nhs.alert.show("hi")\n';
  const result = patchInitLua(existing, renderDeckhandBlock());
  assert.ok(result.startsWith(existing));
  assert.match(result, /\n\n-- >>> deckhand >>>/);
});

test('patchInitLua collapses to a single blank separator when content already ends with a blank line', () => {
  const existing = '-- my config\n\n';
  const result = patchInitLua(existing, renderDeckhandBlock());
  assert.ok(result.startsWith('-- my config\n\n'));
  assert.equal(
    (result.match(/\n\n-- >>> deckhand >>>/g) || []).length,
    1,
  );
  assert.doesNotMatch(result, /\n\n\n-- >>> deckhand >>>/);
});

test('patchInitLua preserves unrelated user content exactly when appending', () => {
  const existing = 'hs.loadSpoon("Other")\nlocal x = 42\n';
  const result = patchInitLua(existing, renderDeckhandBlock());
  assert.ok(result.startsWith(existing));
});

test('patchInitLua is idempotent when the sentinel block already matches', () => {
  const block = renderDeckhandBlock();
  const once = patchInitLua('', block);
  const twice = patchInitLua(once, block);
  assert.equal(once, twice);
});

test('patchInitLua replaces the existing sentinel block contents when they differ', () => {
  const oldBlock = renderDeckhandBlock({ hubUrl: 'ws://127.0.0.1:7000' });
  const once = patchInitLua('', oldBlock);
  assert.match(once, /7000/);

  const newBlock = renderDeckhandBlock({ hubUrl: 'ws://127.0.0.1:9000' });
  const updated = patchInitLua(once, newBlock);
  assert.doesNotMatch(updated, /7000/);
  assert.match(updated, /9000/);
  assert.equal(
    (updated.match(new RegExp(BEGIN_SENTINEL, 'g')) || []).length,
    1,
    'exactly one begin sentinel remains',
  );
});

test('patchInitLua replaces the legacy bare dofile block from the pre-installer README', () => {
  const legacy = [
    'package.path = package.path .. ";" .. hs.configdir .. "/deckhand/?.lua"',
    '',
    'dofile(hs.configdir .. "/deckhand/deckhand.lua").start({',
    '  hubUrl = "ws://127.0.0.1:8765",',
    '})',
    '',
  ].join('\n');
  const updated = patchInitLua(legacy, renderDeckhandBlock());
  assert.ok(updated.includes(BEGIN_SENTINEL));
  assert.equal(
    (updated.match(/dofile\(hs\.configdir/g) || []).length,
    1,
    'legacy dofile is replaced, not duplicated',
  );
});

test('patchInitLua leaves surrounding user content intact when refreshing a sentinel block', () => {
  const oldBlock = renderDeckhandBlock({ hubUrl: 'ws://127.0.0.1:7000' });
  const file = `-- my header\nhs.alert.show("hi")\n\n${wrapWithSentinels(oldBlock)}-- trailing note\n`;
  const updated = patchInitLua(file, renderDeckhandBlock({ hubUrl: 'ws://127.0.0.1:9000' }));
  assert.match(updated, /-- my header/);
  assert.match(updated, /hs\.alert\.show\("hi"\)/);
  assert.match(updated, /-- trailing note/);
  assert.match(updated, /9000/);
  assert.doesNotMatch(updated, /7000/);
});

test('installLuaFiles creates the destination dir and copies only the requested files', async () => {
  const src = await mkdtemp(path.join(os.tmpdir(), 'deckhand-src-'));
  const dest = await mkdtemp(path.join(os.tmpdir(), 'deckhand-dest-'));
  await writeFile(path.join(src, 'deckhand.lua'), '-- a');
  await writeFile(path.join(src, 'apply_state.lua'), '-- b');
  await writeFile(path.join(src, 'window_match.lua'), '-- c');
  await writeFile(path.join(src, 'init.lua'), '-- not copied');

  const copied = await installLuaFiles({ sourceDir: src, destDir: dest });
  assert.deepEqual(
    copied.map((p) => path.basename(p)).sort(),
    ['apply_state.lua', 'deckhand.lua', 'window_match.lua'],
  );

  const deckhand = (await readFile(path.join(dest, 'deckhand.lua'), 'utf8')).trim();
  assert.equal(deckhand, '-- a');
  await assert.rejects(() => access(path.join(dest, 'init.lua')));

  await rm(src, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test('ensureInitLuaBlock reports created / updated / unchanged correctly', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'deckhand-init-'));
  const initPath = path.join(tmp, 'init.lua');

  const r1 = await ensureInitLuaBlock({ initLuaPath: initPath, block: renderDeckhandBlock({ hubUrl: 'ws://127.0.0.1:7000' }) });
  assert.equal(r1.action, 'created');
  assert.equal(r1.changed, true);

  const r2 = await ensureInitLuaBlock({ initLuaPath: initPath, block: renderDeckhandBlock({ hubUrl: 'ws://127.0.0.1:7000' }) });
  assert.equal(r2.action, 'unchanged');
  assert.equal(r2.changed, false);

  const r3 = await ensureInitLuaBlock({ initLuaPath: initPath, block: renderDeckhandBlock({ hubUrl: 'ws://127.0.0.1:9000' }) });
  assert.equal(r3.action, 'updated');
  assert.equal(r3.changed, true);

  await rm(tmp, { recursive: true, force: true });
});

test('install is end-to-end idempotent on init.lua and copies the lua files', async () => {
  const src = await mkdtemp(path.join(os.tmpdir(), 'deckhand-src-'));
  const hs = await mkdtemp(path.join(os.tmpdir(), 'deckhand-hs-'));
  for (const f of HAMMERSPOON_LUA_FILES) await writeFile(path.join(src, f), `-- ${f}\n`);

  const r1 = await install({ hammerspoonDir: hs, sourceDir: src });
  assert.equal(r1.init.action, 'created');
  assert.equal(r1.copied.length, HAMMERSPOON_LUA_FILES.length);

  const after1 = await readFile(path.join(hs, 'init.lua'), 'utf8');
  assert.ok(after1.includes(BEGIN_SENTINEL));

  const r2 = await install({ hammerspoonDir: hs, sourceDir: src });
  assert.equal(r2.init.action, 'unchanged');

  const after2 = await readFile(path.join(hs, 'init.lua'), 'utf8');
  assert.equal(after1, after2);

  await rm(src, { recursive: true, force: true });
  await rm(hs, { recursive: true, force: true });
});

test('install preserves existing user content and updates on subsequent runs', async () => {
  const src = await mkdtemp(path.join(os.tmpdir(), 'deckhand-src-'));
  const hs = await mkdtemp(path.join(os.tmpdir(), 'deckhand-hs-'));
  for (const f of HAMMERSPOON_LUA_FILES) await writeFile(path.join(src, f), `-- ${f}\n`);

  await writeFile(path.join(hs, 'init.lua'), '-- pre-existing config\nhs.alert.show("hi")\n');

  const r1 = await install({ hammerspoonDir: hs, sourceDir: src, hubUrl: 'ws://127.0.0.1:7000' });
  assert.equal(r1.init.action, 'updated');

  const after1 = await readFile(path.join(hs, 'init.lua'), 'utf8');
  assert.match(after1, /-- pre-existing config/);
  assert.match(after1, /7000/);

  const r2 = await install({ hammerspoonDir: hs, sourceDir: src, hubUrl: 'ws://127.0.0.1:9000' });
  assert.equal(r2.init.action, 'updated');

  const after2 = await readFile(path.join(hs, 'init.lua'), 'utf8');
  assert.match(after2, /-- pre-existing config/);
  assert.match(after2, /9000/);
  assert.doesNotMatch(after2, /7000/);

  await rm(src, { recursive: true, force: true });
  await rm(hs, { recursive: true, force: true });
});
