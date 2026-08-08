# Adapters

Deckhand is extended at four seams: the deck **driver**, the **browser
session**, **observer** clients, and per-app **app adapters** for owned app
sources. This document is the contract for each.

## Driver contract

Drivers are event sources and navigation boundaries.

Shared descriptor shape used in the package:

```js
{
  name: 'revealjs',
  kind: 'driver',
  capabilities: ['next', 'prev', 'goTo']
}
```

Expected runtime behavior:

- register with the hub as `role: "driver"`
- emit normalized `positionChanged` messages
- receive generic `command` messages
- implement `next`, `prev`, and optionally `goTo`

## Browser session (Deckhand-owned)

Browser windows and tabs are owned directly by Deckhand through the Chrome
DevTools Protocol. There is no remote target client role.

The coordinator resolves slide config into typed browser commands and
dispatches them through an injected executor. The executor maps commands onto
the browser session runtime:

- `activateTab` activates a preloaded tab by its runtime handle
- `navigate` loads a new URL in a named tab handle

Command routing never relies on page title, URL lookup, or remote identity.

## Observer contract

Observers consume presenter-side runtime state.

Expected runtime behavior:

- register with the hub as `role: "observer"`
- declare `subscriptions` for observer channels
- receive sticky `presentationState` immediately after registration when
  subscribed
- optionally publish `transcript` messages

Current observer channels are `presentationState` and `transcript`.

Example observer registration:

```json
{
  "type": "register",
  "role": "observer",
  "subscriptions": ["presentationState", "transcript"]
}
```

Example observer transcript publish:

```json
{
  "type": "transcript",
  "source": "whisper",
  "text": "walk through the init flow",
  "capturedAtMs": 1720000000000
}
```

## App adapters

App sources (`kind: "app"`) are owned by Deckhand: it launches the window,
resolves the exact macOS window id by diff, and closes it on shutdown. App
adapters live in `src/apps/`; generic launch primitives live in `src/launchers/`.
The split is by responsibility — adapters call into launchers, never the
reverse (see [Architecture: Owned App Sources](ARCHITECTURE.md#owned-app-sources)):

- `src/launchers/` — transport only. `app.js` spawns via `open -a` (forcing
  `-n` for a fresh instance); `iterm2.js` builds and runs the iTerm2 AppleScript
  and closes a window by session UUID. No app-specific knowledge lives here.
- `src/apps/` — per-app adapters that map config onto those primitives and
  encode each app's quirks. The registry (`src/apps/index.js`) resolves an
  adapter by app name; generic apps fall through to `src/apps/default.js`.

Each adapter implements:

- `matches(source)` — whether this adapter handles a given app (alias-based,
  case-insensitive)
- `cgWindowOwnerName(source)` — the CGWindow owner name used for window
  enumeration and the OBS `owner_name` fallback
- `buildBootstrapBinding(source, configuredBinding)` — the
  presenter/Hammerspoon bootstrap binding; the adapter owns the `app` field,
  config supplies `titleIncludes`
- `launch(source, ctx)` / `buildLaunchArgs(source)` — custom launch (iTerm2
  AppleScript, invoked via the `ctx.launchIterm2Window` primitive the runtime
  injects) or extra args for the default `open -a` path
- `confirm` — optional identity-confirmation options (e.g. `stableSamples: 2`
  for Electron splash rejection)
- `close(entry, ctx)` — optional custom close; the runtime injects the matching
  primitive in `ctx` (e.g. `ctx.closeIterm2OwnedWindow` for the iTerm2 session
  UUID)
- `discardUnsavedChangesOnClose` — whether the default AX close path presses
  Don't Save/Discard

### Adding a new app

1. Create `src/apps/<name>.js` exporting an adapter object.
2. Add it to the `APP_ADAPTERS` array in `src/apps/index.js`.
3. No edits to `index.js`, `config.js`, `macWindows.js`, or `ownedWindows.js`.

Apps that behave generically need no adapter file — they fall through to
`default.js`.

## Protocol extension strategy

- extend browser behavior via new `command.type` values handled by the executor
- extend observer behavior via new subscription channels
- keep top-level message types generic
- keep app-specific metadata inside adapter-local code or `meta`

## Current built-ins

- driver: `reveal.js`
- browser session: Deckhand-owned Chrome via CDP
- app adapters: `default` (generic `open -a`), `vscode`, `iterm2`
- observers: presenter web app, Hammerspoon integration, whisper.cpp STT runner

## v1 limits

- no dynamic package discovery
- no remote authentication beyond localhost assumptions
- no attach-to-existing user windows or tabs
