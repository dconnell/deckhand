import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const BEGIN_SENTINEL = '-- >>> deckhand >>>';
export const END_SENTINEL = '-- <<< deckhand <<<';

export const DEFAULT_HUB_URL = 'ws://127.0.0.1:8765';
export const HAMMERSPOON_LUA_FILES = Object.freeze([
  'deckhand.lua',
  'apply_state.lua',
  'window_match.lua',
]);

export function renderDeckhandBlock({ hubUrl } = {}) {
  const url = hubUrl || DEFAULT_HUB_URL;
  return [
    'package.path = package.path .. ";" .. hs.configdir .. "/deckhand/?.lua"',
    '',
    `dofile(hs.configdir .. "/deckhand/deckhand.lua").start({`,
    `  hubUrl = "${url}",`,
    `})`,
  ].join('\n');
}

export function wrapWithSentinels(block) {
  return `${BEGIN_SENTINEL}\n${block}\n${END_SENTINEL}`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Idempotently splice the Deckhand block into a Hammerspoon init.lua body.
 *
 * - Replaces an existing sentinel-managed region in place.
 * - Otherwise replaces the pre-installer legacy dofile block from the README.
 * - Otherwise appends the block with a single blank-line separator.
 *
 * User content is preserved verbatim; only the Deckhand region is touched.
 */
export function patchInitLua(content, block) {
  const wrapped = `${wrapWithSentinels(block)}\n`;

  const sentinelRe = new RegExp(
    `${escapeRegex(BEGIN_SENTINEL)}[\\s\\S]*?${escapeRegex(END_SENTINEL)}\\n?`,
  );
  if (sentinelRe.test(content)) {
    return content.replace(sentinelRe, wrapped);
  }

  const legacyRe =
    /(?:package\.path[\s\S]*?deckhand\/\?\.lua["'][^\n]*\n[^\n]*\n)?dofile\(\s*hs\.configdir[\s\S]*?deckhand\.lua["'][\s\S]*?\)\.start\(\s*\{[\s\S]*?\}\s*\)\n?/;
  if (legacyRe.test(content)) {
    return content.replace(legacyRe, wrapped);
  }

  if (content.length === 0) {
    return wrapped;
  }
  const separator = content.endsWith('\n') ? (content.endsWith('\n\n') ? '' : '\n') : '\n\n';
  return content + separator + wrapped;
}

export async function installLuaFiles({
  sourceDir,
  destDir,
  filenames = HAMMERSPOON_LUA_FILES,
}) {
  await mkdir(destDir, { recursive: true });
  const copied = [];
  for (const name of filenames) {
    const src = path.join(sourceDir, name);
    const dest = path.join(destDir, name);
    await copyFile(src, dest);
    copied.push(dest);
  }
  return copied;
}

export async function ensureInitLuaBlock({ initLuaPath, block }) {
  let existing = '';
  try {
    existing = await readFile(initLuaPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const next = patchInitLua(existing, block);
  if (next === existing) {
    return { changed: false, action: 'unchanged' };
  }
  await mkdir(path.dirname(initLuaPath), { recursive: true });
  await writeFile(initLuaPath, next, 'utf8');
  return { changed: true, action: existing.length === 0 ? 'created' : 'updated' };
}

export async function install({ hammerspoonDir, sourceDir, hubUrl }) {
  const destDeckhandDir = path.join(hammerspoonDir, 'deckhand');
  const initLuaPath = path.join(hammerspoonDir, 'init.lua');

  const copied = await installLuaFiles({
    sourceDir,
    destDir: destDeckhandDir,
  });

  const block = renderDeckhandBlock({ hubUrl });
  const init = await ensureInitLuaBlock({ initLuaPath, block });

  return {
    deckhandDir: destDeckhandDir,
    copied,
    initLuaPath,
    init,
  };
}

export function defaultHammerspoonDir() {
  return path.join(os.homedir(), '.hammerspoon');
}

export function defaultSourceDir(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', 'hammerspoon');
}

async function run() {
  const { values } = parseArgs({
    options: {
      'hub-url': { type: 'string' },
      'hammerspoon-dir': { type: 'string' },
      'source-dir': { type: 'string' },
    },
  });

  const hammerspoonDir = values['hammerspoon-dir'] || defaultHammerspoonDir();
  const sourceDir = values['source-dir'] || defaultSourceDir(import.meta.url);

  const result = await install({
    hammerspoonDir,
    sourceDir,
    hubUrl: values['hub-url'],
  });

  console.log(`Installed Deckhand Lua files to ${result.deckhandDir}`);
  for (const f of result.copied) console.log(`  copied ${path.basename(f)}`);

  const initDesc = result.init.action === 'created'
    ? 'created (new file)'
    : result.init.action === 'updated'
      ? 'updated (replaced existing Deckhand block)'
      : 'unchanged';
  console.log(`${result.initLuaPath}: ${initDesc}`);
}

const isMainEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainEntry) {
  run().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
