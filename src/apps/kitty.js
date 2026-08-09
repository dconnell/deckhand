import { closeKittyOwnedWindow, launchKittyWindow } from '../launchers/kitty.js';

const KITTY_APP_ALIASES = [
  'kitty',
];

function isKittyApp(app) {
  if (typeof app !== 'string') {
    return false;
  }

  return KITTY_APP_ALIASES.includes(app.trim().toLowerCase());
}

/**
 * kitty app adapter.
 *
 * kitty ships no AppleScript dictionary; Deckhand drives it via the `kitty @`
 * remote-control protocol instead. That requires the operator to configure
 * kitty with `allow_remote_control yes` and `listen_on unix:/tmp/kitty`, then
 * export `KITTY_LISTEN_ON=unix:/tmp/kitty` before starting Deckhand. The
 * launcher throws a clear error if that prerequisite is missing.
 *
 * Unlike the Alacritty adapter (whose IPC has no destroy-window command),
 * kitty's `@ close-window` is symmetric with `@ launch`, so this adapter
 * captures the kitty window id at launch and uses it for close.
 */
export const kittyAdapter = {
  id: 'kitty',
  matches(source) {
    return isKittyApp(source.app);
  },
  cgWindowOwnerName() {
    return 'kitty';
  },
  buildBootstrapBinding(source, configuredBinding = {}) {
    return {
      ...configuredBinding,
      app: 'kitty',
    };
  },
  launch(source, { launchKittyWindow: launchWindowFn = launchKittyWindow } = {}) {
    return launchWindowFn({ command: source.command, cwd: source.cwd });
  },
  close({ binding }, { closeKittyOwnedWindow: closeWindowFn = closeKittyOwnedWindow } = {}) {
    closeWindowFn(binding.kittyWindowId);
    return true;
  },
  discardUnsavedChangesOnClose: false,
};

export { isKittyApp };
