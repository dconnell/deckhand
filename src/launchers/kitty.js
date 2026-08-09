import { execFileSync, execSync } from 'node:child_process';

/**
 * Build the argv for a `kitty @ launch --type os-window` invocation.
 *
 * Uses `--type os-window` to guarantee a new top-level OS window (not a tab
 * or split inside an existing window) so the diff resolver can bind a fresh
 * CGWindowID. The operator command is wrapped in `sh -c` so shell semantics
 * (pipes, env, &&) work as writers expect.
 *
 * The argv is the kitty-CLI form (`['@', 'launch', ...]`) — the leading `@`
 * selects kitty's remote-control subcommand mode. The caller resolves the
 * target kitty instance via the `KITTY_LISTEN_ON` environment variable that
 * `kitty @` consults by default; this launcher does NOT pass `--to` so that
 * the operator's chosen listen address is the single source of truth.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {string[]}
 */
export function buildKittyAtLaunchArgs({ command, cwd } = {}) {
  const args = ['@', 'launch', '--type', 'os-window'];

  if (cwd !== undefined && cwd !== null) {
    args.push('--cwd', String(cwd));
  }

  if (command !== undefined && command !== null) {
    args.push('sh', '-c', String(command));
  }

  return args;
}

/**
 * Build the argv for a `kitty @ close-window --match id:<N>` invocation.
 *
 * Returns `null` for an invalid id so callers can skip the spawn entirely.
 *
 * @param {string} kittyWindowId Stable kitty window id returned by `kitty @ launch`.
 * @returns {string[] | null}
 */
export function buildKittyAtCloseArgs(kittyWindowId) {
  if (typeof kittyWindowId !== 'string' || kittyWindowId === '') {
    return null;
  }

  return ['@', 'close-window', '--match', `id:${kittyWindowId}`];
}

/**
 * Discover the listen address of a kitty instance reachable via remote control.
 *
 * `kitty @` consults `KITTY_LISTEN_ON` by default; we surface the same value
 * here so the adapter can produce a clear error when the operator has not
 * configured remote control.
 *
 * @returns {string | null}
 */
export function findKittyListenAddress() {
  const value = process.env.KITTY_LISTEN_ON;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Discover the PID of the running kitty process, if any.
 *
 * Note: macOS reports the kitty process name as lowercase `kitty`.
 *
 * @returns {number | null}
 */
export function findKittyPid() {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const script = 'tell application "System Events" to get unix id of first process whose name is "kitty"';
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
 * Launch a new kitty OS window via the `kitty @` remote-control protocol.
 *
 * Requires `KITTY_LISTEN_ON` to point at a kitty instance configured with
 * `allow_remote_control yes`. Throws a clear error otherwise — the operator
 * must configure kitty separately before Deckhand can own a window in it.
 *
 * Returns the kitty-internal window id (printed on stdout by `kitty @ launch`)
 * which is distinct from the CGWindowID used by the diff resolver. That id is
 * stable for the lifetime of the window and is the close target.
 *
 * @param {{ command?: string, cwd?: string }} [options] Launch options.
 * @returns {Promise<{ pid?: number, kittyWindowId?: string }>}
 */
export async function launchKittyWindow({ command, cwd } = {}) {
  if (process.platform !== 'darwin') {
    return {};
  }

  if (findKittyListenAddress() === null) {
    throw new Error(
      'KITTY_LISTEN_ON is not set. Configure kitty with `allow_remote_control yes` and `listen_on unix:/tmp/kitty`, then export KITTY_LISTEN_ON=unix:/tmp/kitty before running Deckhand.',
    );
  }

  const args = buildKittyAtLaunchArgs({ command, cwd });

  const output = execFileSync('kitty', args, {
    encoding: 'utf8',
    timeout: 10000,
  }).trim();

  const pid = findKittyPid();

  return {
    ...(pid !== null ? { pid } : {}),
    ...(output !== '' ? { kittyWindowId: output } : {}),
  };
}

/**
 * Close the kitty window whose stable id matches the given value.
 *
 * Uses `kitty @ close-window --match id:<N>` so the close targets the exact
 * tracked window even when a long-running command is active inside. This is
 * the symmetric counterpart to `launchKittyWindow`'s use of remote control.
 *
 * Best-effort: any error is swallowed so shutdown cannot hang.
 *
 * @param {string} kittyWindowId The kitty window id returned by {@link launchKittyWindow}.
 * @returns {void}
 */
export function closeKittyOwnedWindow(kittyWindowId) {
  if (process.platform !== 'darwin') {
    return;
  }

  const args = buildKittyAtCloseArgs(kittyWindowId);
  if (args === null) {
    return;
  }

  try {
    execFileSync('kitty', args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // best-effort — the window may have already been closed by the user
  }
}
