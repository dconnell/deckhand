import { ConfigError } from '../../config.js';
import { loadPresentationConfig, parsePresentationCliArgs } from '../../presentations.js';
import { runSttObserver } from './runner.js';

function createConsoleLogger(consoleLike) {
  return {
    error(message, context) {
      consoleLike.error(context === undefined ? message : `${message} ${JSON.stringify(context)}`);
    },
    info(message, context) {
      consoleLike.log(context === undefined ? message : `${message} ${JSON.stringify(context)}`);
    },
    warn(message, context) {
      consoleLike.warn(context === undefined ? message : `${message} ${JSON.stringify(context)}`);
    },
  };
}

function normalizeRetryDelayMs(value) {
  if (value === undefined) {
    return 1000;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError('--retry-delay-ms must be a non-negative integer');
  }

  return parsed;
}

function isMainModule(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === new URL(`file://${process.argv[1]}`).href;
}

/**
 * Run the presenter STT CLI.
 *
 * @param {{ args?: string[], consoleLike?: Console, cwd?: string, installSignalHandlers?: boolean }} [options] CLI options.
 * @returns {Promise<number>}
 */
export async function runPresenterStt(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const consoleLike = options.consoleLike ?? console;
  const cwd = options.cwd ?? process.cwd();
  const installSignalHandlers = options.installSignalHandlers ?? true;
  let parsed;

  try {
    parsed = parsePresentationCliArgs({
      args,
      options: {
        input: { type: 'string' },
        once: { type: 'boolean', default: false },
        'retry-delay-ms': { type: 'string' },
      },
    });
  } catch (error) {
    consoleLike.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let config;

  try {
    config = (await loadPresentationConfig({ cwd, presentationName: parsed.presentationName })).config;
  } catch (error) {
    if (error instanceof ConfigError) {
      consoleLike.error(`Invalid configuration at ${error.path}: ${error.message}`);
      return 1;
    }

    consoleLike.error(`Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (config.presenter === null || config.presenter.stt === null) {
    consoleLike.error('Presenter STT is not configured in this config file.');
    return 1;
  }

  const controller = new AbortController();

  if (installSignalHandlers) {
    process.once('SIGINT', () => {
      controller.abort();
    });
    process.once('SIGTERM', () => {
      controller.abort();
    });
  }

  try {
    await runSttObserver({
      chunkInput: parsed.values.input,
      hubUrl: `ws://${config.hub.host}:${config.hub.port}`,
      logger: createConsoleLogger(consoleLike),
      once: parsed.values.once,
      restartDelayMs: normalizeRetryDelayMs(parsed.values['retry-delay-ms']),
      signal: controller.signal,
      stt: config.presenter.stt,
    });
    return 0;
  } catch (error) {
    consoleLike.error(`Presenter STT failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  const exitCode = await runPresenterStt();
  process.exitCode = exitCode;
}
