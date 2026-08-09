import { alacrittyAdapter } from './alacritty.js';
import { appleTerminalAdapter } from './appleTerminal.js';
import { defaultAdapter } from './default.js';
import { ghosttyAdapter } from './ghostty.js';
import { iterm2Adapter } from './iterm2.js';
import { kittyAdapter } from './kitty.js';
import { slackAdapter } from './slack.js';
import { vscodeAdapter } from './vscode.js';

const APP_ADAPTERS = [
  vscodeAdapter,
  iterm2Adapter,
  appleTerminalAdapter,
  ghosttyAdapter,
  kittyAdapter,
  alacrittyAdapter,
  slackAdapter,
];

export function resolveAppAdapter(source) {
  if (source.kind !== 'app') {
    throw new Error(`resolveAppAdapter called for non-app kind: ${source.kind}`);
  }

  return APP_ADAPTERS.find((adapter) => adapter.matches(source)) ?? defaultAdapter;
}

export {
  alacrittyAdapter,
  appleTerminalAdapter,
  defaultAdapter,
  ghosttyAdapter,
  iterm2Adapter,
  kittyAdapter,
  slackAdapter,
  vscodeAdapter,
};
