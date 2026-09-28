import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Default osascript executor: async and event-loop non-blocking.
 *
 * The script travels as a single `-e` argv element to `execFile` (no shell),
 * so composed AppleScript text — including operator-supplied cwd/command
 * fragments — can never re-enter shell parsing. Timeouts kill the child and
 * reject, mirroring the previous sync `timeout` semantics.
 *
 * @param {string} script AppleScript source to run.
 * @param {{ timeoutMs: number, discardOutput?: boolean }} options Run options; `discardOutput` drops stdout/stderr for fire-and-forget calls.
 * @returns {Promise<string>} Resolves with osascript stdout.
 */
function defaultExecOsascript(script, { timeoutMs, discardOutput = false }) {
  return execFileAsync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    ...(discardOutput ? { stdio: ['pipe', 'ignore', 'ignore'] } : {}),
  }).then(({ stdout }) => stdout);
}

/**
 * Single-quote a value for safe interpolation into a shell command.
 *
 * Wraps the value in single quotes and escapes any embedded single quotes using
 * the standard `'\''` sequence so an operator-supplied cwd cannot break out of
 * the generated `do script` command.
 *
 * @param {string} value The value to quote.
 * @returns {string}
 */
function shellQuoteSingle(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a value for safe embedding inside an AppleScript double-quoted string.
 *
 * @param {string} value The value to escape.
 * @returns {string}
 */
function applescriptEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build the shell text to write into a freshly-created Terminal.app window.
 *
 * Composes `cd '<cwd>'` and `<command>` with `&&` so a configured command runs
 * inside the configured working directory. Returns `null` when neither is
 * configured, meaning the window should be left at a plain shell prompt.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {string | null}
 */
export function buildTerminalWriteText({ command, cwd } = {}) {
  const parts = [];

  if (cwd !== undefined && cwd !== null) {
    parts.push(`cd ${shellQuoteSingle(cwd)}`);
  }

  if (command !== undefined && command !== null) {
    parts.push(command);
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' && ');
}

/**
 * Build the AppleScript that creates a new Terminal.app window and, when a
 * command or cwd is configured, runs the composed shell text inside it.
 *
 * Terminal.app's `do script` command both creates a window and runs the command
 * in one call, which is why this differs from the iTerm2 launcher (separate
 * `create window` + `write text` steps). The script returns the new window's
 * stable AppleScript-level integer `id` (distinct from the CGWindowID used by
 * the diff resolver) so the caller can later close that exact window on
 * shutdown.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {string}
 */
export function buildTerminalAppleScript({ command, cwd } = {}) {
  const writeText = buildTerminalWriteText({ command, cwd });

  let body = '  activate\n';

  if (writeText !== null) {
    body += `  do script "${applescriptEscape(writeText)}"\n`;
    body += '  return id of window 1\n';
  } else {
    body += '  set newWin to (make new window)\n';
    body += '  return id of newWin\n';
  }

  return `tell application "Terminal"\n${body}end tell`;
}

/**
 * Discover the PID of the running Terminal.app process, if any.
 *
 * Used to snapshot Terminal windows before launch so any shell Deckhand was
 * launched from is captured in the before-set and therefore never bound.
 *
 * @param {{ execOsascriptFn?: typeof defaultExecOsascript }} [options] Injectable executor for tests.
 * @returns {Promise<number | null>} Resolves `null` on any probe failure instead of rejecting.
 */
export async function findTerminalPid({ execOsascriptFn = defaultExecOsascript } = {}) {
  if (process.platform !== 'darwin') {
    return null;
  }

  const script = 'tell application "System Events" to get unix id of first process whose name is "Terminal"';

  try {
    const output = (await execOsascriptFn(script, { timeoutMs: 5000 })).trim();

    const pid = Number.parseInt(output, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Launch a new Terminal.app window running an optional command at an optional cwd.
 *
 * @param {{ command?: string, cwd?: string, execOsascriptFn?: typeof defaultExecOsascript }} [options] Launch options.
 * @returns {Promise<{ pid?: number, terminalWindowId?: string }>}
 */
export async function launchTerminalWindow({ command, cwd, execOsascriptFn = defaultExecOsascript } = {}) {
  if (process.platform !== 'darwin') {
    return {};
  }

  const script = buildTerminalAppleScript({ command, cwd });

  const output = (await execOsascriptFn(script, { timeoutMs: 10000 })).trim();

  const pid = await findTerminalPid({ execOsascriptFn });
  const windowId = Number.parseInt(output, 10);

  return {
    ...(pid !== null ? { pid } : {}),
    ...(Number.isFinite(windowId) ? { terminalWindowId: String(windowId) } : {}),
  };
}

/**
 * Close the Terminal.app window whose AppleScript id matches the given value.
 *
 * The AppleScript window id is assigned at creation time and is stable for the
 * lifetime of the window — it does not change when the foreground process
 * changes, making it a reliable close target even when a long-running command
 * (e.g. `npm run dev`) is active inside the window.
 *
 * Best-effort: any AppleScript error is swallowed so shutdown cannot hang.
 *
 * @param {string} terminalWindowId The AppleScript window id returned by {@link launchTerminalWindow}.
 * @param {{ execOsascriptFn?: typeof defaultExecOsascript }} [options] Injectable executor for tests.
 * @returns {Promise<void>}
 */
export async function closeTerminalOwnedWindow(terminalWindowId, { execOsascriptFn = defaultExecOsascript } = {}) {
  if (process.platform !== 'darwin') {
    return;
  }

  if (typeof terminalWindowId !== 'string' || terminalWindowId === '') {
    return;
  }

  const id = Number.parseInt(terminalWindowId, 10);
  if (!Number.isFinite(id)) {
    return;
  }

  const script = `tell application "Terminal"\n  close (every window whose id is ${id})\nend tell`;

  try {
    await execOsascriptFn(script, { timeoutMs: 5000, discardOutput: true });
  } catch {
    // best-effort — the window may have already been closed by the user
  }
}
