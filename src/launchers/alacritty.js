import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import os from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * Default osascript executor: async and event-loop non-blocking.
 *
 * The script travels as a single `-e` argv element to `execFile` (no shell).
 * Timeouts kill the child and reject, mirroring the previous sync `timeout`
 * semantics.
 *
 * @param {string} script AppleScript source to run.
 * @param {{ timeoutMs: number }} options Run options.
 * @returns {Promise<string>} Resolves with osascript stdout.
 */
function defaultExecOsascript(script, { timeoutMs }) {
  return execFileAsync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
  }).then(({ stdout }) => stdout);
}

/**
 * Spawn a command and resolve only after it exits 0.
 *
 * Rejects on non-zero exit or spawn error. Stdio is ignored — callers that
 * need stdout capture should use the `execFile`-based executor instead.
 *
 * @param {string} command Binary to spawn.
 * @param {string[]} args Argv.
 * @param {string} [cwd] Working directory.
 * @param {string} label Human-readable label for error messages.
 * @param {typeof spawn} [spawnFn] Injectable spawn for tests.
 * @returns {Promise<void>}
 */
function spawnAndWaitZero(command, args, cwd, label, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: cwd ?? undefined,
      stdio: 'ignore',
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited with code ${code}`));
      }
    });
  });
}

/**
 * Build the argv for an `alacritty msg create-window` invocation.
 *
 * Alacritty's `--command` flag consumes the rest of argv (multi-token), so the
 * operator-supplied command string is wrapped in `sh -c` to preserve shell
 * quoting semantics. Without that wrap, a command like `npm run dev` would be
 * tokenized by Node's spawn as a single argv element and Alacritty would try
 * to exec a binary literally named `npm run dev`.
 *
 * When `socketPath` is omitted the `alacritty` binary's default socket
 * discovery runs (which usually finds the running instance via
 * `$ALACRITTY_SOCKET` or the conventional `$TMPDIR/Alacritty-<PID>.sock`).
 *
 * @param {{ command?: string, cwd?: string, socketPath?: string }} [options] Launch options.
 * @returns {string[]}
 */
export function buildAlacrittyMsgArgs({ command, cwd, socketPath } = {}) {
  const args = ['msg'];

  if (socketPath) {
    args.push('--socket', socketPath);
  }

  args.push('create-window');

  if (cwd !== undefined && cwd !== null) {
    args.push('--working-directory', String(cwd));
  }

  if (command !== undefined && command !== null) {
    args.push('--command', 'sh', '-c', String(command));
  }

  return args;
}

/**
 * Discover the IPC socket of a running Alacritty instance.
 *
 * Alacritty writes its socket to `$TMPDIR/Alacritty-<PID>.sock` by convention
 * when launched without an explicit `--socket`. We enumerate Alacritty PIDs
 * via the macOS System Events process list and return the first matching
 * socket path that exists on disk.
 *
 * Returns `null` when Alacritty is not running or no socket file is present —
 * the caller (the Alacritty adapter) surfaces a clear error in that case
 * because the operator must launch Alacritty before Deckhand can own a window
 * in it.
 *
 * @param {{ execOsascriptFn?: typeof defaultExecOsascript, tmpDir?: string }} [options] Injectable executor and tmp dir for tests.
 * @returns {Promise<string | null>} Resolves `null` on any probe failure instead of rejecting.
 */
export async function findAlacrittySocket({ execOsascriptFn = defaultExecOsascript, tmpDir = os.tmpdir() } = {}) {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const script = 'tell application "System Events" to get unix id of every process whose name is "Alacritty"';
    const output = (await execOsascriptFn(script, { timeoutMs: 5000 })).trim();

    if (output === '' || output === 'missing value') {
      return null;
    }

    const pids = output
      .split(', ')
      .map((token) => Number.parseInt(token, 10))
      .filter((pid) => Number.isFinite(pid));

    for (const pid of pids) {
      const candidate = `${tmpDir}/Alacritty-${pid}.sock`;
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Launch a new Alacritty window in the already-running Alacritty process via
 * its IPC socket.
 *
 * Alacritty's `msg create-window` does NOT print a window id and there is no
 * corresponding `destroy-window` IPC, so the returned binding carries no
 * adapter-local close handle — close is handled by the generic AX path using
 * the diff-resolved CGWindowID and the existing Alacritty process PID.
 *
 * Throws when Alacritty is not running or has no IPC socket. The operator
 * must launch Alacritty separately before Deckhand can bind a window in it —
 * this is the documented prerequisite for the Alacritty adapter.
 *
 * @param {{ command?: string, cwd?: string, execOsascriptFn?: typeof defaultExecOsascript, tmpDir?: string, spawnFn?: typeof spawn }} [options] Launch options; injectable for tests.
 * @returns {Promise<{ pid?: number }>}
 */
export async function launchAlacrittyWindow({ command, cwd, execOsascriptFn = defaultExecOsascript, tmpDir, spawnFn = spawn } = {}) {
  if (process.platform !== 'darwin') {
    return {};
  }

  const socketPath = await findAlacrittySocket({ execOsascriptFn, tmpDir });

  if (socketPath === null) {
    throw new Error(
      'Alacritty is not running with an IPC socket. Launch Alacritty first so Deckhand can create a window in the existing process.',
    );
  }

  const args = buildAlacrittyMsgArgs({ command, cwd, socketPath });

  await spawnAndWaitZero('alacritty', args, undefined, 'alacritty msg create-window', spawnFn);

  const pid = await findAlacrittyPid({ execOsascriptFn });

  return {
    ...(pid !== null ? { pid } : {}),
  };
}

/**
 * Discover the PID of the running Alacritty process, if any.
 *
 * Returned so the diff resolver can target the right PID when enumerating
 * candidate windows.
 *
 * @param {{ execOsascriptFn?: typeof defaultExecOsascript }} [options] Injectable executor for tests.
 * @returns {Promise<number | null>} Resolves `null` on any probe failure instead of rejecting.
 */
export async function findAlacrittyPid({ execOsascriptFn = defaultExecOsascript } = {}) {
  if (process.platform !== 'darwin') {
    return null;
  }

  const script = 'tell application "System Events" to get unix id of first process whose name is "Alacritty"';

  try {
    const output = (await execOsascriptFn(script, { timeoutMs: 5000 })).trim();

    const pid = Number.parseInt(output, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
