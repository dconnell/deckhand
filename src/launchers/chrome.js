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
 * Build the AppleScript that creates a new Google Chrome window and loads the
 * given URL in its active tab.
 *
 * Why AppleScript and not `open -na "Google Chrome" URL`:
 *
 * Chrome on macOS silently forwards URLs to the running instance and opens a
 * tab in an existing window rather than spawning a new window — `open -n` is
 * absorbed by Chrome's single-instance behavior. The only reliable way to
 * create a fresh, separately-bindable Chrome window with a specific URL is
 * AppleScript's `make new window` plus a `set URL` against the new window's
 * active tab.
 *
 * Chrome's AppleScript support only sees windows it created itself, so this
 * launcher cannot enumerate or close arbitrary operator windows — callers
 * track the new CGWindowID via diff and close it through the AX path.
 *
 * @param {string} url The URL to load in the new window's active tab.
 * @returns {string}
 */
export function buildChromeWindowAppleScript(url) {
  return `tell application "Google Chrome"
  set newWin to (make new window)
  set URL of active tab of newWin to "${applescriptEscape(url)}"
end tell`;
}

/**
 * Discover the PID of the running Google Chrome process, if any.
 *
 * Used so the diff resolver can target the right PID when enumerating
 * candidate windows.
 *
 * @returns {number | null}
 */
export function findChromePid() {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const script = 'tell application "System Events" to get unix id of first process whose name is "Google Chrome"';
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
 * Launch a new Google Chrome window in the operator's running Chrome process
 * and load the given URL.
 *
 * The new window belongs to the existing Chrome PID, so the operator's normal
 * Chrome profile is in use — any logged-in sessions (Slack web client,
 * internal tools) carry over without a separate profile.
 *
 * Chrome must already be running. If it is not, the AppleScript will start
 * Chrome and create the window, but the launch takes substantially longer
 * (multiple seconds for cold start) and the diff resolver may need more
 * polling attempts than usual.
 *
 * @param {string} url The URL to load in the new window.
 * @returns {Promise<{ pid?: number }>}
 */
export async function launchChromeWindowWithUrl(url) {
  if (process.platform !== 'darwin') {
    return {};
  }

  if (typeof url !== 'string' || url === '') {
    throw new Error('launchChromeWindowWithUrl requires a non-empty URL');
  }

  const script = buildChromeWindowAppleScript(url);

  execSync('osascript', {
    encoding: 'utf8',
    timeout: 10000,
    input: script,
  });

  const pid = findChromePid();

  return {
    ...(pid !== null ? { pid } : {}),
  };
}
