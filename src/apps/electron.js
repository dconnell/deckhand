/**
 * Create an app adapter for an Electron-based macOS application.
 *
 * Electron apps share two launch-time quirks the generic `open -a` path needs
 * help with, and this factory encodes the shared corrections so per-app
 * adapter files only declare what differs:
 *
 * 1. **Splash / overlay window noise.** Electron emits transient utility
 *    windows (GPU, helper, tooltip, DevTools) around the main window. The
 *    diff resolver rejects those transients by requiring the same set of new
 *    window ids across two consecutive samples — the `confirm: { stableSamples: 2 }`
 *    policy every Electron adapter inherits here. Apps cannot opt out without
 *    a concrete reason.
 *
 * 2. **Single-instance handoff.** `open -n` is silently absorbed by an
 *    already-running Electron process. The generic launcher already forces
 *    `-n`, but most Electron apps also need a CLI flag (e.g. VS Code's
 *    `--new-window`) to actually create a new window rather than activate an
 *    existing one. Apps that have such a flag pass `buildLaunchArgs`.
 *
 * 3. **Exclusive instance required.** Offscreen window capture of an Electron
 *    app degrades silently (observed: black freeze frames) when another
 *    instance owns windows, and the `open -n` ownership model means deckhand
 *    can only reliably own windows it launched itself. Adapters built here
 *    therefore declare `requiresExclusiveInstance: true` so the startup
 *    preflight can refuse to run while the operator still has the app open.
 *
 * What is intentionally NOT shared: aliases, the CGWindow owner name, the
 * `open -a` / Hammerspoon bootstrap app name, and the unsaved-changes close
 * policy. Those differ per app even within the Electron family (Slack has no
 * documents to discard; VS Code does), so each call site owns them.
 *
 * @param {object} options
 * @param {string} options.id Stable adapter id used in logs and tests.
 * @param {string[]} options.aliases Lower-cased app name aliases that route to this adapter.
 * @param {string} options.cgWindowOwnerName CGWindow `kCGWindowOwnerName` used for window enumeration.
 * @param {string} options.bootstrapAppName App name for `open -a` and Hammerspoon bootstrap lookup.
 * @param {boolean} [options.discardUnsavedChangesOnClose] Whether close presses Don't Save/Discard on sheets. Omitted when not declared so the close runtime decides.
 * @param {(source: object) => string[]} [options.buildLaunchArgs] Optional launcher arg shaper.
 * @returns {{
 *   id: string,
 *   matches: (source: { app?: unknown }) => boolean,
 *   cgWindowOwnerName: () => string,
 *   buildBootstrapBinding: (source: object, configuredBinding?: object) => object,
 *   confirm: { stableSamples: number },
 *   requiresExclusiveInstance: true,
 *   buildLaunchArgs?: (source: object) => string[],
 *   discardUnsavedChangesOnClose?: boolean,
 * }}
 */
export function createElectronAdapter({
  id,
  aliases,
  cgWindowOwnerName,
  bootstrapAppName,
  discardUnsavedChangesOnClose,
  buildLaunchArgs,
}) {
  const aliasSet = new Set(aliases);

  const adapter = {
    id,
    matches(source) {
      return typeof source?.app === 'string'
        && aliasSet.has(source.app.trim().toLowerCase());
    },
    cgWindowOwnerName() {
      return cgWindowOwnerName;
    },
    buildBootstrapBinding(source, configuredBinding = {}) {
      return {
        ...configuredBinding,
        app: bootstrapAppName,
      };
    },
    confirm: { stableSamples: 2 },
    // Offscreen window-capture reliability and the `open -n` ownership model
    // both require that no pre-existing instance of the app is running, so
    // the startup preflight gates on this flag.
    requiresExclusiveInstance: true,
  };

  if (typeof buildLaunchArgs === 'function') {
    adapter.buildLaunchArgs = buildLaunchArgs;
  }

  if (typeof discardUnsavedChangesOnClose === 'boolean') {
    adapter.discardUnsavedChangesOnClose = discardUnsavedChangesOnClose;
  }

  return adapter;
}
