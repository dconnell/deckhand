import { closeGhosttyOwnedWindow, launchGhosttyWindow } from '../launchers/ghostty.js';

const GHOSTTY_APP_ALIASES = [
  'ghostty',
];

function isGhosttyApp(app) {
  if (typeof app !== 'string') {
    return false;
  }

  return GHOSTTY_APP_ALIASES.includes(app.trim().toLowerCase());
}

export const ghosttyAdapter = {
  id: 'ghostty',
  matches(source) {
    return isGhosttyApp(source.app);
  },
  cgWindowOwnerName() {
    return 'Ghostty';
  },
  buildBootstrapBinding(source, configuredBinding = {}) {
    return {
      ...configuredBinding,
      app: 'Ghostty',
    };
  },
  async launch(source, { launchGhosttyWindow: launchWindowFn = launchGhosttyWindow } = {}) {
    return launchWindowFn({ command: source.command, cwd: source.cwd });
  },
  async close({ binding }, { closeGhosttyOwnedWindow: closeWindowFn = closeGhosttyOwnedWindow } = {}) {
    // Awaited so shutdown does not proceed before the best-effort close lands.
    await closeWindowFn(binding.ghosttyWindowId);

    return true;
  },
  discardUnsavedChangesOnClose: false,
};

export { isGhosttyApp };
