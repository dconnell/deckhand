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

4. Build the OBS scenes from the presentation's `layouts` catalog:

```bash
npm run setup:obs -- my-talk
```

5. Install Hammerspoon for window management:

```bash
mkdir -p ~/.hammerspoon/deckhand
cp hammerspoon/deckhand.lua hammerspoon/apply_state.lua hammerspoon/window_match.lua ~/.hammerspoon/deckhand/
cp hammerspoon/init.lua ~/.hammerspoon/init.lua
```

Open Hammerspoon, grant Accessibility permission when prompted, then reload
its config. Hammerspoon connects to the hub and automatically resizes/focuses
windows when slides change.

### Running A Presentation

You need **one terminal window**.

**Terminal 1 -- managed runtime session**:

```bash
npm start my-talk
```

This starts:
- Presentation deck at `http://127.0.0.1:3000/presentation/my-talk/deck/index.html`
- OBS connection
- WebSocket hub at `ws://127.0.0.1:8765`
- Presenter app at `http://127.0.0.1:3001/presenter/`
- Status page at `http://127.0.0.1:3001/status.json`

Startup waits for the real deck driver position before enabling hotkeys or
reporting readiness.

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
- `npm run setup:obs -- <presentation-name>` connects to OBS and applies
  layout-derived scenes from that presentation config.
- `npm start <presentation-name>` starts the managed runtime session, including
  the deck HTTP server and presenter HTTP surface.
- `npm run presenter:doctor -- <presentation-name>` validates the local
  presentation config and reports missing STT dependencies clearly.
- Real OBS, Hammerspoon Accessibility, microphone permission, and whisper.cpp
  validation still require local manual smoke testing on macOS.
