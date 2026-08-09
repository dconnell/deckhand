import { launchAlacrittyWindow } from '../launchers/alacritty.js';

const ALACRITTY_APP_ALIASES = [
  'alacritty',
];

function isAlacrittyApp(app) {
  if (typeof app !== 'string') {
    return false;
  }

  return ALACRITTY_APP_ALIASES.includes(app.trim().toLowerCase());
}

/**
 * Alacritty app adapter.
 *
 * Differs from the Apple-script terminals (iTerm2, Terminal.app, Ghostty) in
 * two ways that shape this adapter:
 *
 * 1. **Launch** is via the `alacritty msg create-window` IPC, not AppleScript.
 *    Alacritty ships no AppleScript dictionary, and `open -a Alacritty` is
 *    unreliable because Alacritty's multi-window session-restore can spawn
 *    many windows from one `open` invocation.
 *
 * 2. **Close** has no IPC counterpart (Alacritty's IPC has no destroy-window
 *    command), so this adapter defines no `close`. The runtime falls through
 *    to the generic AX close path using the diff-resolved CGWindowID and the
 *    running Alacritty process PID.
 *
 * The launch hook will throw a clear error when Alacritty is not running with
 * an IPC socket — the operator must launch Alacritty first.
 */
export const alacrittyAdapter = {
  id: 'alacritty',
  matches(source) {
    return isAlacrittyApp(source.app);
  },
  cgWindowOwnerName() {
    return 'Alacritty';
  },
  buildBootstrapBinding(source, configuredBinding = {}) {
    return {
      ...configuredBinding,
      app: 'Alacritty',
    };
  },
  launch(source, { launchAlacrittyWindow: launchWindowFn = launchAlacrittyWindow } = {}) {
    return launchWindowFn({ command: source.command, cwd: source.cwd });
  },
  discardUnsavedChangesOnClose: false,
};

export { isAlacrittyApp };
