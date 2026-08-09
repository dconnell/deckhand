import { createElectronAdapter } from './electron.js';

const VSCODE_APP_ALIASES = [
  'code',
  'visual studio code',
];

function isVisualStudioCodeApp(app) {
  if (typeof app !== 'string') {
    return false;
  }

  return VSCODE_APP_ALIASES.includes(app.trim().toLowerCase());
}

/**
 * Build launch args for VS Code that guarantee a Deckhand-owned instance.
 *
 * Ensures `--new-window` is always present so a new window is created and can
 * be bound by CGWindowID diff. Without it, the Electron single-instance
 * handoff reuses an existing window and the diff resolver finds nothing.
 *
 * @param {{ args?: string[] }} options Launch options.
 * @returns {string[]}
 */
export function buildVsCodeLaunchArgs({ args = [] } = {}) {
  const normalized = Array.isArray(args) ? [...args] : [];
  const hasNewWindow = normalized.includes('--new-window');

  const result = [];
  if (!hasNewWindow) {
    result.push('--new-window');
  }

  return [...result, ...normalized];
}

export const vscodeAdapter = createElectronAdapter({
  id: 'vscode',
  aliases: VSCODE_APP_ALIASES,
  cgWindowOwnerName: 'Code',
  bootstrapAppName: 'Visual Studio Code',
  discardUnsavedChangesOnClose: true,
  buildLaunchArgs: (source) => buildVsCodeLaunchArgs({ args: source.args }),
});

export { isVisualStudioCodeApp };
