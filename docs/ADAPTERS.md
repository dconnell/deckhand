# Adapters

Deckhand is extended at four seams: the deck driver, the browser session,
observer clients, and per-app app adapters for owned app sources. This
document is the contract for each.

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

Deckhand owns browser windows and tabs directly through the Chrome
DevTools Protocol. There is no remote target client role.

The coordinator resolves slide config into typed browser commands and
dispatches them through an injected executor, which maps commands onto the
browser session runtime:

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

Deckhand owns app sources (`kind: "app"`): it launches the window, resolves
the exact macOS window id by diff, and closes it on shutdown. App
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
  injects) or shaping `args` for the default `open -a` path. The default
  launcher already handles `files` (positional documents) and `openArgs`
  (verbatim `open` args), so adapters need these hooks only for genuinely
  custom launch behavior; see [Config: App sources](CONFIG.md#what-the-app-opens)
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

### Shared adapter bases

The `src/apps/electron.js` factory produces an adapter for any
Electron-packaged macOS app. It bakes in the splash-rejection policy
(`confirm: { stableSamples: 2 }`) every Electron app needs and accepts
per-app overrides for aliases, CGWindow owner name, bootstrap app name,
unsaved-changes policy, and arg shaper. Use it instead of duplicating the
splash-rejection knob. VS Code is built on it; future Electron apps
(Discord, Notion, Figma, etc.) should be too.

### Slack and other Electron single-instance apps with no CLI surface

Apps whose CGWindow owner name matches their `open -a` name and that have no
useful CLI or AppleScript handle (Slack is the canonical example) need no
adapter when the operator just wants to launch the app — the default adapter
already handles that.

Slack **does** need an adapter when the operator wants to open a specific
channel or DM, because Deckhand cannot own a window the desktop Slack app
navigates in place. The adapter resolves the operator's config into one of two
modes and declares each via `ownsWindow(source)`:

- **Navigation mode (default).** `open "slack://channel?…"` activates Slack and
  switches to the channel in the existing window. The adapter declares
  `ownsWindow(source) === false`, so the runtime skips the diff resolver and
  the close path for that source.
- **Browser mode (`newWindow: true`).** The adapter creates a new Google Chrome
  window via AppleScript `make new window`, pointing at the Slack web client.
  Chrome's `open -n -a "Google Chrome" URL` does **not** work — Chrome forwards
  the URL to the running instance, which opens a tab — so AppleScript is the
  only reliable way to get a fresh, bindable Chrome window with a URL in an
  existing process. The window is bindable by CGWindowID diff and closed via the
  standard AX path on shutdown, so `ownsWindow(source) === true`.

For config shapes (`slack` vs `uri`, `target`, and how to find Slack
team/channel IDs), see [Config: Slack](CONFIG.md#slack).

### Navigation-only sources and the `ownsWindow` contract

Adapters may declare `ownsWindow(source)` returning `false` for sources
Deckhand should launch but cannot own (Slack navigation mode is the first
example). When it returns `false`, the runtime:

- still calls `adapter.launch(source, ctx)` at startup
- skips the CGWindowID diff resolver for that source (no spurious "window did
  not appear" warnings)
- does not attempt to close anything for that source on shutdown

Sources without `ownsWindow` behave exactly as before — the contract is
strictly opt-in.

## Terminal app prerequisites

iTerm2, Terminal.app, and Ghostty work out of the box — Deckhand drives them
via AppleScript and captures a stable window id at creation time, so close
works even when a long-running command is active inside the window.

Alacritty and kitty ship no AppleScript dictionary and rely on IPC instead,
which imposes an operator-side prerequisite:

- **Alacritty** must already be running with its default IPC socket
  (`$TMPDIR/Alacritty-<PID>.sock`). Deckhand discovers the socket from the
  running PID. There is no IPC destroy-window command, so close falls back to
  the generic AX path using the diff-resolved CGWindowID.
- **kitty** must be running with `allow_remote_control yes` and a listen
  address, and the operator must export `KITTY_LISTEN_ON=unix:/tmp/kitty`
  before starting Deckhand. Both launch and close use `kitty @`, so close
  targets the exact tracked window even mid-command.

If those prerequisites are not met, the launchers throw an error naming the
missing setup.

## Protocol extension strategy

- extend browser behavior via new `command.type` values handled by the executor
- extend observer behavior via new subscription channels
- keep top-level message types generic
- keep app-specific metadata inside adapter-local code or `meta`

## Current built-ins

For operator config examples see
[Config: App recipes](CONFIG.md#app-recipes) and
[Config: Browser recipes](CONFIG.md#browser-recipes).

- driver: `reveal.js`
- browser session: Deckhand-owned Chrome via CDP
- app adapters:
  - `default` (generic `open -a`)
  - `vscode` (built on the shared `electron` factory)
  - `iterm2` (AppleScript `do script` + session-UUID close)
  - `appleTerminal` (Terminal.app; AppleScript `do script` + integer window id)
  - `ghostty` (AppleScript `new window with configuration` + string window id)
  - `kitty` (`kitty @ launch` / `kitty @ close-window`; requires `KITTY_LISTEN_ON`)
  - `alacritty` (`alacritty msg create-window`; requires Alacritty already running; close via AX)
  - `slack` (navigation mode via `slack://` URL; browser mode via Chrome AppleScript with `newWindow: true`)
- observers: presenter web app, Hammerspoon integration, whisper.cpp STT runner

## v1 limits

- no dynamic package discovery
- no remote authentication beyond localhost assumptions
- no attach-to-existing user windows or tabs
