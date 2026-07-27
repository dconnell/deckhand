import path from 'node:path';
import { parseArgs } from 'node:util';
import { access } from 'node:fs/promises';

import { loadConfig } from './config.js';

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
 * Load a presentation config, preferring a local untracked override when present.
 *
 * @param {{ cwd: string, presentationName: string }} options Load inputs.
 * @returns {Promise<{ config: Awaited<ReturnType<typeof loadConfig>>, filePath: string, paths: ReturnType<typeof resolvePresentationPaths> }>}
 */
export async function loadPresentationConfig(options) {
  const paths = resolvePresentationPaths(options);
  let filePath = paths.localConfigPath;

  try {
    await access(filePath);
  } catch {
    filePath = paths.configPath;
  }

  return {
    config: await loadConfig({ filePath }),
    filePath,
    paths,
  };
}
