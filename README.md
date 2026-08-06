## Deckhand

Deckhand is a local presentation coordinator that keeps four outputs in sync:

- slide position from a driver
- OBS audience scenes
- presenter-side state on macOS
- Deckhand-owned Chrome windows and tabs (activation and navigation)

Deckhand is macOS-only. Presentations are self-contained under
`presentation/<name>/` while shared runtime integrations live at the repo root.

## Quick Start

### One-Time Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the example presentation to your own name:

```bash
cp -R presentation/example presentation/my-talk
```

3. Put your OBS password and machine-specific values in a local override:

```bash
# presentation/my-talk/config.local.json  (git-ignored)
{
  "obs": { "password": "<your OBS password>" }
}
```

`config.local.json` is a deep merge overlay on top of `config.json`, so it only
needs the fields you want to override locally.

If you want Deckhand to start from an existing signed-in Chrome profile, set
`chrome.profileName` in config. Deckhand will launch a Deckhand-owned working
copy seeded from that profile so cookies and sessions are available without
attaching to your normal Chrome process.

4. Build the OBS scenes from the presentation's `layouts` catalog:

```bash
npm run obs:setup -- my-talk
```

`obs:setup` provisions the scenes and named inputs. During runtime, Deckhand
pushes macOS `window_capture` settings into those inputs and upgrades them from
bootstrap app/title selectors to exact managed window bindings when available.

Optional: for whole-frame slide transitions instead of instant cuts, add two
Slide transitions in the OBS UI and an `obs.transitions` block to your config.
See [docs/SETUP.md](docs/SETUP.md#whole-frame-slide-transitions-optional).

5. Install Hammerspoon for window management:

```bash
npm run hammerspoon:setup
```

This copies `deckhand.lua`, `apply_state.lua`, and `window_match.lua` into
`~/.hammerspoon/deckhand/` and patches `~/.hammerspoon/init.lua` to load them
on startup. The init.lua patch is non-destructive: it preserves your existing
config, identifies the Deckhand section with `-- >>> deckhand >>>` /
`-- <<< deckhand <<<` sentinels, replaces the section in place on re-runs, and
appends cleanly when no prior section exists. Re-run the same command whenever
you update Deckhand.

Optional overrides:

```bash
# point Hammerspoon at a non-default hub port
npm run hammerspoon:setup -- --hub-url ws://127.0.0.1:9000
```

Open Hammerspoon, grant Accessibility permission when prompted, then reload
its config. Hammerspoon connects to the hub and automatically resizes/focuses
windows when slides change.

When you update Deckhand, re-run `npm run hammerspoon:setup` and reload
Hammerspoon. The exact-window-id flow depends on the current
`hammerspoon/deckhand.lua`, `hammerspoon/apply_state.lua`, and
`hammerspoon/window_match.lua` files; run `npm run hammerspoon:setup` again
after updating Deckhand so the copies stay in sync.

### Running A Presentation

You need **one terminal window**.

**Terminal 1 -- managed runtime session**:

```bash
node ./src/index.js my-talk
```

This starts:
- Presentation deck at `http://127.0.0.1:3000/presentation/my-talk/deck/index.html`
- OBS connection
- WebSocket hub at `ws://127.0.0.1:8765`
- Presenter app at `http://127.0.0.1:3001/presenter/`
- Status page at `http://127.0.0.1:3001/status.json`

Startup waits for the real deck driver position before reporting readiness.

In presenter mode it also waits for Hammerspoon to report exact window ids for
the managed browser windows before doing the final OBS binding pass. This can
add a short startup delay and is intentional.

On shutdown, Deckhand closes only windows it launched for the session: managed
browser windows/tabs, owned iTerm2 windows, and owned `app` windows.

For owned `app` windows (for example VS Code), Deckhand targets only the tracked
exact macOS window id and never intentionally terminates the whole app process.
If an unsaved-changes sheet appears, it attempts Don't Save/Discard for that
tracked window.

If you are using Hammerspoon, it also owns the macOS global slide hotkeys.

### Navigating Slides

Either:
- Use the deck's own keyboard shortcuts (arrow keys, space) in the browser
- Or use the Hammerspoon global hotkeys: **Ctrl+Shift+Right** = next,
  **Ctrl+Shift+Left** = previous

When you advance, the coordinator switches the OBS scene, publishes presenter
state (Hammerspoon resizes windows, teleprompter updates), and sends any
configured target commands.

### Useful Commands

- `npm run presenter:doctor -- my-talk` -- validate config and environment
- `npm run presenter:smoke -- my-talk` -- check presenter HTTP + hub are live
- `npm run presenter:stt -- my-talk` -- start the whisper STT observer (optional)

## Project Layout

- `src/`: coordinator, config, protocol, hub, OBS setup, presenter HTTP, STT,
  CDP transport, and browser session runtime
- `presentation/`: self-contained presentations; see
  [`presentation/README.md`](presentation/README.md) for the sample index
- `presentation/<name>/`: self-contained presentation config, deck, and docs
- `presenter-web/`: first-class presenter app served at `/presenter/`
- `hammerspoon/`: macOS window-layout integration
- `reveal/`: `reveal.js` driver bridge
- `docs/`: setup, config, architecture, and adapter contracts
- `test/`: unit and integration coverage

## Docs

- [Setup](docs/SETUP.md)
- [Config](docs/CONFIG.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Adapters](docs/ADAPTERS.md)

## Verification Status

- Automated unit and integration tests pass with `npm test`.
- `npm run obs:setup -- <presentation-name>` connects to OBS and applies
  layout-derived scenes from that presentation config.
- `node ./src/index.js <presentation-name>` starts the managed runtime session, including
  the deck HTTP server and presenter HTTP surface.
- `npm run presenter:doctor -- <presentation-name>` validates the local
  presentation config and reports missing STT dependencies clearly.
- Real OBS, Hammerspoon Accessibility, microphone permission, and whisper.cpp
  validation still require local manual smoke testing on macOS.
