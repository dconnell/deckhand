import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createElectronAdapter } from './electron.js';

const execFileAsync = promisify(execFile);

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

/**
 * Parse the workspace names from `code --status` output.
 *
 * Only `Folder (NAME)` rows after the `Workspace Stats:` header count. Those
 * rows are the aggregated union of open workspace roots across ALL windows
 * (deduped), so they are the authoritative "what's open" signal — a bare
 * `Window (dc-enclave)` is still covered via its `Folder (dc-enclave)` row.
 * `Window (NAME)` rows are deliberately NOT collected: they are display
 * titles (`folder` when no file is focused, `file — folder` otherwise), so
 * raw collection invites false positives — a window titled
 * `app.js — my-site` must not count as project `app` being open.
 * `File types`/`Conf files` rows and everything before the header are
 * ignored. Names are deduped; case is preserved.
 *
 * @param {string} output Raw stdout of `code --status`.
 * @returns {string[]} Unique open workspace folder names; empty when the section is absent.
 */
export function parseVsCodeStatusWorkspaces(output) {
  if (typeof output !== 'string') {
    return [];
  }

  const lines = output.split('\n');
  const sectionStart = lines.findIndex((line) => line.trim() === 'Workspace Stats:');

  if (sectionStart === -1) {
    return [];
  }

  // `Folder (name): 165 files` carries a trailing colon before the file count;
  // the greedy capture plus optional colon keeps just the name.
  const nameLinePattern = /^\|\s*Folder\s+\((.+)\):?/;
  const names = [];
  const seen = new Set();

  for (const line of lines.slice(sectionStart + 1)) {
    const match = nameLinePattern.exec(line);

    if (match === null || seen.has(match[1])) {
      continue;
    }

    seen.add(match[1]);
    names.push(match[1]);
  }

  return names;
}

/**
 * Default probe executor: run `code --status` asynchronously.
 *
 * `execFile` (no shell) keeps the CLI argv out of shell parsing while
 * preserving the previous 5s timeout; resolves with just stdout.
 *
 * @returns {Promise<string>} Resolves with the raw `code --status` stdout; rejects on spawn failure, non-zero exit, or timeout.
 */
function defaultStatusExec() {
  return execFileAsync('code', ['--status'], { encoding: 'utf8', timeout: 5000 })
    .then(({ stdout }) => stdout);
}

/**
 * Probe VS Code for its currently open workspace folders via the `code` CLI.
 *
 * The result is authoritative when it is an array: the probe needs no Screen
 * Recording permission (unlike `kCGWindowName` titles, which come back empty
 * without it) and sees multi-root workspace folders. `null` is deliberately
 * distinct from `[]`: `null` means the probe FAILED (no `code` CLI, non-zero
 * exit, timeout, unparsable output) and the caller must fall back to window
 * enumeration, while `[]` means the probe ran fine and nothing is open.
 *
 * @param {{ execFn?: () => string | Promise<string> }} [options] Injectable executor for tests; may return the output directly or a promise of it.
 * @returns {Promise<string[] | null>} Parsed names, or `null` on any probe failure.
 */
export async function listOpenVsCodeWorkspaces({ execFn = defaultStatusExec } = {}) {
  let output;

  try {
    output = await execFn();
  } catch {
    return null;
  }

  if (typeof output !== 'string' || output.trim() === '') {
    return null;
  }

  // A working `code --status` always prints the `Workspace Stats:` section.
  // Output without it is unparsable rather than "nothing open": returning []
  // here would read as an authoritative all-clear from a tool that never
  // actually reported.
  if (!output.includes('Workspace Stats:')) {
    return null;
  }

  return parseVsCodeStatusWorkspaces(output);
}

export const vscodeAdapter = {
  ...createElectronAdapter({
    id: 'vscode',
    aliases: VSCODE_APP_ALIASES,
    cgWindowOwnerName: 'Code',
    bootstrapAppName: 'Visual Studio Code',
    discardUnsavedChangesOnClose: true,
    buildLaunchArgs: (source) => buildVsCodeLaunchArgs({ args: source.args }),
  }),
  // Why the preflight prefers this probe over window enumeration: `code
  // --status` needs no Screen Recording permission (titles come back empty
  // without it) and also reports folders inside multi-root windows, which
  // titles never show. Only a probe failure falls back to enumeration.
  listOpenWorkspaceNames: listOpenVsCodeWorkspaces,
};

export { isVisualStudioCodeApp };
