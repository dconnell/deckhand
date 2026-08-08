import path from 'node:path';
import { parseArgs } from 'node:util';
import { access, readFile } from 'node:fs/promises';

import { ConfigError, assertOwnedAppFilesExist, normalizeConfig } from './config.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfigOverlay(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return overlay;
  }

  const merged = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeConfigOverlay(base[key], value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

async function readJsonFile(filePath) {
  const text = await readFile(filePath, 'utf8');

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError('config', `must be valid JSON: ${error.message}`);
  }
}

function validatePresentationName(presentationName) {
  if (typeof presentationName !== 'string' || presentationName.trim() === '') {
    throw new TypeError('Presentation name must be a non-empty string');
  }

  const normalized = presentationName.trim();

  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new TypeError('Presentation name must contain only letters, numbers, dots, underscores, or hyphens');
  }

  if (normalized === '.' || normalized === '..') {
    throw new TypeError('Presentation name must not be a traversal path');
  }

  return normalized;
}

/**
 * Parse command-line args that require one presentation name positional.
 *
 * @param {{ args: string[], options: Record<string, { type: 'boolean' | 'string', default?: boolean | string }> }} input Parse inputs.
 * @returns {{ presentationName: string, values: Record<string, boolean | string | undefined> }}
 */
export function parsePresentationCliArgs(input) {
  const parsed = parseArgs({
    args: input.args,
    options: input.options,
    allowPositionals: true,
  });

  if (parsed.positionals.length !== 1) {
    throw new TypeError('Expected exactly one presentation name positional argument');
  }

  return {
    presentationName: validatePresentationName(parsed.positionals[0]),
    values: { ...parsed.values },
  };
}

/**
 * Resolve the self-contained file layout for a named presentation.
 *
 * @param {{ cwd: string, presentationName: string }} options Resolution inputs.
 * @returns {{ name: string, root: string, configPath: string, deckRoot: string, deckEntryPath: string }}
 */
export function resolvePresentationPaths(options) {
  const name = validatePresentationName(options.presentationName);
  const root = path.join(options.cwd, 'presentation', name);

  return {
    name,
    root,
    configPath: path.join(root, 'config.json'),
    localConfigPath: path.join(root, 'config.local.json'),
    deckRoot: path.join(root, 'deck'),
    deckEntryPath: path.join(root, 'deck', 'index.html'),
  };
}

/**
 * Load a presentation config and deep-merge any local untracked override.
 *
 * @param {{ cwd: string, presentationName: string }} options Load inputs.
 * @returns {Promise<{ config: Awaited<ReturnType<typeof loadConfig>>, filePath: string, paths: ReturnType<typeof resolvePresentationPaths> }>}
 */
export async function loadPresentationConfig(options) {
  const paths = resolvePresentationPaths(options);
  const baseConfig = await readJsonFile(paths.configPath);
  let filePath = paths.configPath;
  let mergedConfig = baseConfig;

  try {
    await access(paths.localConfigPath);
    const localConfig = await readJsonFile(paths.localConfigPath);
    mergedConfig = mergeConfigOverlay(baseConfig, localConfig);
    filePath = paths.localConfigPath;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const config = normalizeConfig(mergedConfig, { baseDir: paths.root });
  await assertOwnedAppFilesExist(config);

  return {
    config,
    filePath,
    paths,
  };
}
