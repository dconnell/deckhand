import { execSync } from 'node:child_process';

/**
 * Single-quote a value for safe interpolation into a shell command.
 *
 * Wraps the value in single quotes and escapes any embedded single quotes using
 * the standard `'\''` sequence so an operator-supplied cwd cannot break out of
 * the generated `write text` command.
 *
 * @param {string} value The value to quote.
 * @returns {string}
 */
function shellQuoteSingle(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Build the shell text to write into a freshly-created iTerm2 session.
 *
 * Composes `cd '<cwd>'` and `<command>` with `&&` so a configured command runs
 * inside the configured working directory. Returns `null` when neither is
 * configured, meaning the window should be left at a plain shell prompt.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {string | null}
 */
export function buildIterm2WriteText({ command, cwd } = {}) {
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
 * Escape a value for safe embedding inside an AppleScript double-quoted string.
 *
 * @param {string} value The value to escape.
 * @returns {string}
 */
function applescriptEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build the AppleScript that creates a new iTerm2 window and, when a command or
 * cwd is configured, runs the composed shell text inside its first session.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {string}
 */
export function buildIterm2AppleScript({ command, cwd } = {}) {
  const writeText = buildIterm2WriteText({ command, cwd });

  let body = '  set newWindow to (create window with default profile)\n';

  if (writeText !== null) {
    body += '  tell current session of newWindow\n';
    body += `    write text "${applescriptEscape(writeText)}"\n`;
    body += '  end tell\n';
  }

  return `tell application "iTerm2"\n  activate\n${body}end tell`;
}

/**
 * Discover the PID of the running iTerm2 process, if any.
 *
 * Used to snapshot iTerm2 windows before launch so the terminal Deckhand was
 * launched from is captured in the before-set and therefore never bound
 * (`plans/app-sources.md` decision 2).
 *
 * @returns {number | null}
 */
export function findIterm2Pid() {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const script = 'tell application "System Events" to get unix id of first process whose name is "iTerm2"';
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
 * Launch a new iTerm2 window running an optional command at an optional cwd.
 *
 * Returns the iTerm2 PID (discovered after launch) so the caller can poll
 * windows by PID and diff against the pre-launch snapshot. No-ops off macOS so
 * the launch layer is safe to construct on non-darwin hosts.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {Promise<{ pid?: number }>}
 */
export async function launchIterm2Window({ command, cwd } = {}) {
  if (process.platform !== 'darwin') {
    return {};
  }

  const script = buildIterm2AppleScript({ command, cwd });

  execSync('osascript', {
    encoding: 'utf8',
    timeout: 10000,
    input: script,
  });

  const pid = findIterm2Pid();
  return pid !== null ? { pid } : {};
}
