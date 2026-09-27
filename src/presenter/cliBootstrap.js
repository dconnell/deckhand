import { ConfigError } from '../config.js';
import { errorMessage } from '../lib/errors.js';
import { loadPresentationConfig, parsePresentationCliArgs } from '../presentations.js';

/**
 * Check whether the calling module is the process entry point.
 *
 * @param {string} metaUrl The calling module's `import.meta.url`.
 * @returns {boolean} True when the module was launched directly.
 */
export function isMainModule(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === new URL(`file://${process.argv[1]}`).href;
}

/**
 * Shared bootstrap for presenter CLI entry points: parse the standard
 * presentation-name arguments and load the presentation config, reporting
 * failures through the supplied console. Each entry point keeps its own
 * command behavior; this helper only covers the repeated parse/load/report
 * block.
 *
 * @param {{ args: string[], consoleLike: Console, cwd: string, options?: Record<string, { type: 'boolean' | 'string', default?: boolean | string }> }} options Bootstrap inputs.
 * @returns {Promise<{ ok: false } | { ok: true, parsed: ReturnType<typeof parsePresentationCliArgs>, config: Awaited<ReturnType<typeof loadPresentationConfig>>['config'] }>}
 *   A discriminated result: `ok: false` means the failure was already reported
 *   and the caller should exit with a non-zero status.
 */
export async function loadPresenterCliContext(options) {
  let parsed;

  try {
    parsed = parsePresentationCliArgs({
      args: options.args,
      options: options.options ?? {},
    });
  } catch (error) {
    options.consoleLike.error(errorMessage(error));
    return { ok: false };
  }

  let config;

  try {
    config = (await loadPresentationConfig({ cwd: options.cwd, presentationName: parsed.presentationName })).config;
  } catch (error) {
    if (error instanceof ConfigError) {
      options.consoleLike.error(`Invalid configuration at ${error.path}: ${error.message}`);
      return { ok: false };
    }

    options.consoleLike.error(`Failed to load configuration: ${errorMessage(error)}`);
    return { ok: false };
  }

  return { ok: true, parsed, config };
}
