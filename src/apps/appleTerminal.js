import { closeTerminalOwnedWindow, launchTerminalWindow } from '../launchers/appleTerminal.js';

const APPLE_TERMINAL_ALIASES = [
  'terminal',
  'terminal.app',
  'apple terminal',
  'appleterminal',
];

function isAppleTerminalApp(app) {
  if (typeof app !== 'string') {
    return false;
  }

  return APPLE_TERMINAL_ALIASES.includes(app.trim().toLowerCase());
}

export const appleTerminalAdapter = {
  id: 'appleTerminal',
  matches(source) {
    return isAppleTerminalApp(source.app);
  },
  cgWindowOwnerName() {
    return 'Terminal';
  },
  buildBootstrapBinding(source, configuredBinding = {}) {
    return {
      ...configuredBinding,
      app: 'Terminal',
    };
  },
  launch(source, { launchTerminalWindow: launchWindowFn = launchTerminalWindow } = {}) {
    return launchWindowFn({ command: source.command, cwd: source.cwd });
  },
  close({ binding }, { closeTerminalOwnedWindow: closeWindowFn = closeTerminalOwnedWindow } = {}) {
    closeWindowFn(binding.terminalWindowId);
    return true;
  },
  discardUnsavedChangesOnClose: false,
};

export { isAppleTerminalApp };
