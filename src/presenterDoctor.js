import { access } from 'node:fs/promises';

import { getExpectedPresenterCanvas } from './obsSetupPlan.js';
import { isMainModule, loadPresenterCliContext } from './presenter/cliBootstrap.js';
import { runSubprocess } from './presenter/stt/subprocess.js';

async function pathExists(accessFn, filePath) {
  try {
    await accessFn(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run presenter environment checks.
 *
 * @param {{ accessFn?: typeof access, args?: string[], consoleLike?: Console, cwd?: string, platform?: string, runCommand?: typeof runSubprocess }} [options] CLI options.
 * @returns {Promise<number>}
 */
export async function runPresenterDoctor(options = {}) {
  const accessFn = options.accessFn ?? access;
  const args = options.args ?? process.argv.slice(2);
  const consoleLike = options.consoleLike ?? console;
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? runSubprocess;

  const bootstrap = await loadPresenterCliContext({
    args,
    consoleLike,
    cwd,
  });

  if (!bootstrap.ok) {
    return 1;
  }

  const config = bootstrap.config;
  const problems = [];

  if (config.presenter === null) {
    consoleLike.log('Presenter mode is not enabled in this config.');
    return 0;
  }

  consoleLike.log('Presenter mode enabled');
  consoleLike.log(`Hub: ws://${config.hub.host}:${config.hub.port}`);
  consoleLike.log(`Presenter HTTP: http://${config.presenter.http.host}:${config.presenter.http.port}/presenter/`);

  const canvas = getExpectedPresenterCanvas(config);
  if (canvas !== null) {
    consoleLike.log(`Expected OBS canvas: ${canvas.width}x${canvas.height}`);
  }

  if ((options.platform ?? process.platform) !== 'darwin') {
    problems.push('Presenter mode currently expects macOS (darwin).');
  }

  if (config.presenter.stt !== null) {
    const hasWhisperBin = await pathExists(accessFn, config.presenter.stt.whisperBin);
    if (!hasWhisperBin) {
      problems.push(`Configured whisperBin path is not accessible: ${config.presenter.stt.whisperBin}`);
    }

    const hasModel = await pathExists(accessFn, config.presenter.stt.model);
    if (!hasModel) {
      problems.push(`Configured model path is not accessible: ${config.presenter.stt.model}`);
    }

    if (hasWhisperBin && hasModel) {
      consoleLike.log('Whisper binary and model paths exist');

      try {
        await runCommand(config.presenter.stt.whisperBin, ['--help']);
        consoleLike.log('whisper-stream --help completed');
      } catch (error) {
        problems.push(`whisper-stream --help failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    consoleLike.log('STT is not configured');
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      consoleLike.error(problem);
    }

    return 1;
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  const exitCode = await runPresenterDoctor();
  process.exitCode = exitCode;
}
