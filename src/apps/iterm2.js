import { closeIterm2OwnedWindow, launchIterm2Window } from '../launchers/iterm2.js';

const ITERM_APP_ALIASES = new Set([
  'iterm',
  'iterm2',
]);

function isIterm2App(app) {
  if (typeof app !== 'string') {
    return false;
  }

  return ITERM_APP_ALIASES.has(app.trim().toLowerCase());
}

export const iterm2Adapter = {
  id: 'iterm2',
  matches(source) {
    return isIterm2App(source.app);
  },
  cgWindowOwnerName() {
    return 'iTerm';
  },
  buildBootstrapBinding(source, configuredBinding = {}) {
    return {
      ...configuredBinding,
      app: 'iTerm2',
    };
  },
  async launch(source, { launchIterm2Window: launchWindowFn = launchIterm2Window } = {}) {
    return launchWindowFn({ command: source.command, cwd: source.cwd });
  },
  async close({ binding }, { closeIterm2OwnedWindow: closeWindowFn = closeIterm2OwnedWindow } = {}) {
    await closeWindowFn(binding.sessionId);
    return true;
  },
  discardUnsavedChangesOnClose: false,
};

export { isIterm2App };
