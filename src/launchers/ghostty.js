import { execSync } from 'node:child_process';

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
 * @returns {number | null}
 */
export function findGhosttyPid() {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const script = 'tell application "System Events" to get unix id of first process whose name is "Ghostty"';
    const output = execSync(`osascript -e '${script}'`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    const pid = Number.parseInt(output, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Launch a new Ghostty window running an optional command at an optional cwd.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {Promise<{ pid?: number, ghosttyWindowId?: string }>}
 */
export async function launchGhosttyWindow({ command, cwd } = {}) {
  if (process.platform !== 'darwin') {
    return {};
  }

  const script = buildGhosttyAppleScript({ command, cwd });

  const output = execSync('osascript', {
    encoding: 'utf8',
    timeout: 10000,
    input: script,
  }).trim();

  const pid = findGhosttyPid();

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
 * @returns {void}
 */
export function closeGhosttyOwnedWindow(ghosttyWindowId) {
  if (process.platform !== 'darwin') {
    return;
  }

  if (typeof ghosttyWindowId !== 'string' || ghosttyWindowId === '') {
    return;
  }

  const script = `tell application "Ghostty"\n  close window (first window whose id is "${applescriptEscape(ghosttyWindowId)}")\nend tell`;

  try {
    execSync('osascript', {
      encoding: 'utf8',
      timeout: 5000,
      input: script,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch {
    // best-effort — the window may have already been closed by the user
  }
}
