import { spawn } from 'node:child_process';

/**
 * Error raised when a subprocess fails to start or exits unsuccessfully.
 */
export class SubprocessError extends Error {
  /**
   * @param {{ command: string, args: string[], exitCode?: number | null, signal?: string | null, stdout?: string, stderr?: string, cause?: Error }} details Error details.
   */
  constructor(details) {
    const commandText = [details.command, ...details.args].join(' ');
    const failure = details.exitCode !== undefined && details.exitCode !== null
      ? `exit code ${details.exitCode}`
      : details.signal !== undefined && details.signal !== null
        ? `signal ${details.signal}`
        : details.cause?.message ?? 'unknown failure';

    super(`Subprocess failed (${failure}): ${commandText}`);
    this.name = 'SubprocessError';
    this.args = details.args;
    this.command = details.command;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? '';
    this.stderr = details.stderr ?? '';

    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

/**
 * Run a subprocess and capture utf-8 stdout/stderr.
 *
 * @param {string} command Executable name or absolute path.
 * @param {string[]} args CLI arguments.
 * @param {{ signal?: AbortSignal }} [options] Execution options.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runSubprocess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.once('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      if (error instanceof Error && error.name === 'AbortError') {
        reject(error);
        return;
      }

      reject(new SubprocessError({
        args,
        cause: error instanceof Error ? error : new Error(String(error)),
        command,
        stderr,
        stdout,
      }));
    });

    child.once('close', (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      if (exitCode === 0) {
        resolve({
          stdout,
          stderr,
          exitCode: 0,
        });
        return;
      }

      reject(new SubprocessError({
        args,
        command,
        exitCode,
        signal,
        stderr,
        stdout,
      }));
    });
  });
}
