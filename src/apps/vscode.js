const VSCODE_APP_ALIASES = new Set([
  'code',
  'visual studio code',
]);

function isVisualStudioCodeApp(app) {
  if (typeof app !== 'string') {
    return false;
  }

  return VSCODE_APP_ALIASES.has(app.trim().toLowerCase());
}

/**
 * Build launch args for VS Code that guarantee a Deckhand-owned instance.
 *
 * Ensures `--new-window` is always present so a new window is created and can
 * be bound by CGWindowID diff.
 *
 * @param {{ args?: string[] }} options Launch options.
 * @returns {string[]}
 */
export function buildVsCodeLaunchArgs({ args = [] }) {
  const normalized = Array.isArray(args) ? [...args] : [];
  const hasNewWindow = normalized.includes('--new-window');

  const result = [];
  if (!hasNewWindow) {
    result.push('--new-window');
  }

  return [...result, ...normalized];
}

export const vscodeAdapter = {
  id: 'vscode',
  matches(source) {
    return isVisualStudioCodeApp(source.app);
  },
  cgWindowOwnerName() {
    return 'Code';
  },
  buildBootstrapBinding(source, configuredBinding = {}) {
    return {
      ...configuredBinding,
      app: 'Visual Studio Code',
    };
  },
  buildLaunchArgs(source) {
    return buildVsCodeLaunchArgs({ args: source.args });
  },
  confirm: { stableSamples: 2 },
  discardUnsavedChangesOnClose: true,
};

export { isVisualStudioCodeApp };
