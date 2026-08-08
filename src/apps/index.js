import { defaultAdapter } from './default.js';
import { iterm2Adapter } from './iterm2.js';
import { vscodeAdapter } from './vscode.js';

const APP_ADAPTERS = [vscodeAdapter, iterm2Adapter];

export function resolveAppAdapter(source) {
  if (source.kind !== 'app') {
    throw new Error(`resolveAppAdapter called for non-app kind: ${source.kind}`);
  }

  return APP_ADAPTERS.find((adapter) => adapter.matches(source)) ?? defaultAdapter;
}

export { defaultAdapter, iterm2Adapter, vscodeAdapter };
