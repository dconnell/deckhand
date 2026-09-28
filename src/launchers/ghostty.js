import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Default osascript executor: async and event-loop non-blocking.
 *
 * The script travels as a single `-e` argv element to `execFile` (no shell),
 * so composed AppleScript text can never re-enter shell parsing. Timeouts kill
 * the child and reject, mirroring the previous sync `timeout` semantics.
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
 * Escape a value for safe embedding inside an AppleScript double-quoted string.
 *
 * @param {string} value The value to escape.
 * @returns {string}
 */
function applescriptEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build the Ghostty surface-configuration record body for a launch.
 *
 * Ghostty's `new window` command accepts a `surface configuration` record that
 * bundles `initial working directory`, `command`, and `initial input` into the
 * window-creation call — there is no separate `write text` step as in iTerm2
 * or Terminal.app, so the configuration is composed up front.
 *
 * Returns `null` when neither cwd nor command is configured, meaning the
 * window should be left at a plain shell prompt using Ghostty's defaults.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {string | null}
 */
export function buildGhosttySurfaceConfig({ command, cwd } = {}) {
  const fields = [];

  if (cwd !== undefined && cwd !== null) {
    fields.push(`initial working directory:"${applescriptEscape(String(cwd))}"`);
  }

  if (command !== undefined && command !== null) {
    fields.push(`command:"${applescriptEscape(String(command))}"`);
  }

  if (fields.length === 0) {
    return null;
  }

  return `{${fields.join(', ')}}`;
}

/**
 * Build the AppleScript that creates a new Ghostty window.
 *
 * Uses Ghostty's `new window with configuration <record>` form so the command
 * and cwd are baked into the window at creation time, which avoids the race
 * between `make new window` and a follow-up `input text` call. The script
 * returns the new window's stable string id (e.g. `tab-group-XYZ`, distinct
 * from the CGWindowID used by the diff resolver) so the caller can later close
 * that exact window on shutdown.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {string}
 */
export function buildGhosttyAppleScript({ command, cwd } = {}) {
  const config = buildGhosttySurfaceConfig({ command, cwd });

  let body = '  activate\n';

  if (config !== null) {
    body += `  set newWin to (new window with configuration ${config})\n`;
  } else {
    body += '  set newWin to (new window)\n';
  }

  body += '  return id of newWin\n';

  return `tell application "Ghostty"\n${body}end tell`;
}

/**
 * Discover the PID of the running Ghostty process, if any.
 *
 * Used to snapshot Ghostty windows before launch so any pre-existing operator
 * window is captured in the before-set and therefore never bound.
 *
 * @param {{ execOsascriptFn?: typeof defaultExecOsascript }} [options] Injectable executor for tests.
 * @returns {Promise<number | null>} Resolves `null` on any probe failure instead of rejecting.
 */
export async function findGhosttyPid({ execOsascriptFn = defaultExecOsascript } = {}) {
  if (process.platform !== 'darwin') {
    return null;
  }

  const script = 'tell application "System Events" to get unix id of first process whose name is "Ghostty"';

  try {
    const output = (await execOsascriptFn(script, { timeoutMs: 5000 })).trim();

    const pid = Number.parseInt(output, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Launch a new Ghostty window running an optional command at an optional cwd.
 *
 * @param {{ command?: string, cwd?: string, execOsascriptFn?: typeof defaultExecOsascript }} [options] Launch options.
 * @returns {Promise<{ pid?: number, ghosttyWindowId?: string }>}
 */
export async function launchGhosttyWindow({ command, cwd, execOsascriptFn = defaultExecOsascript } = {}) {
  if (process.platform !== 'darwin') {
    return {};
  }

  const script = buildGhosttyAppleScript({ command, cwd });

  const output = (await execOsascriptFn(script, { timeoutMs: 10000 })).trim();

  const pid = await findGhosttyPid({ execOsascriptFn });

  return {
    ...(pid !== null ? { pid } : {}),
    ...(output !== '' ? { ghosttyWindowId: output } : {}),
  };
}

/**
 * Close the Ghostty window whose stable id matches the given value.
 *
 * Ghostty window ids are opaque strings (`tab-group-XYZ`) assigned at creation
 * and stable for the lifetime of the window, making them a reliable close
 * target even when a long-running command is active inside.
 *
 * Best-effort: any AppleScript error is swallowed so shutdown cannot hang.
 *
 * @param {string} ghosttyWindowId The Ghostty window id returned by {@link launchGhosttyWindow}.
 * @param {{ execOsascriptFn?: typeof defaultExecOsascript }} [options] Injectable executor for tests.
 * @returns {Promise<void>}
 */
export async function closeGhosttyOwnedWindow(ghosttyWindowId, { execOsascriptFn = defaultExecOsascript } = {}) {
  if (process.platform !== 'darwin') {
    return;
  }

  if (typeof ghosttyWindowId !== 'string' || ghosttyWindowId === '') {
    return;
  }

  const script = `tell application "Ghostty"\n  close window (first window whose id is "${applescriptEscape(ghosttyWindowId)}")\nend tell`;

  try {
    await execOsascriptFn(script, { timeoutMs: 5000, discardOutput: true });
  } catch {
    // best-effort — the window may have already been closed by the user
  }
}
