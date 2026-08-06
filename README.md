## Deckhand

Deckhand exists to easily mix slides, a terminal for live input, VS Code if
desired, or other apps — and seamlessly switch back and forth between them,
including split views. It is macOS-only and focused on remote presentations:
the audience sees a single composed OBS feed, shared into the meeting via
OBS's Projector window and Zoom's Share Screen, so captures stay crisp and
the operator never has to expose their whole desktop.

Deckhand is a local presentation coordinator that keeps these outputs in sync:

- slide position from a driver
- OBS audience scenes
- presenter-side state on macOS
- Deckhand-owned Chrome windows and tabs (activation and navigation), plus
  terminals and apps it launches (e.g. iTerm2, VS Code)

Browser and terminal sources are reliable. Generic `app` sources (anything
launched via `open -a`, such as VS Code or other editors) are best-effort:
Deckhand tracks the launched window and closes only that window on shutdown,
but app-specific behavior — unsaved-changes sheets, single-instance handoffs,
custom shutdown prompts — can break clean launch or close for untested apps.
Expect to need small code tweaks in `src/` for apps that do not behave.

Presentations are self-contained under
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

### Sharing to the Meeting

The OBS program output is shared into the meeting via OBS's **Projector**
feature, not as a virtual camera:

1. In OBS (non-Studio Mode), right-click the canvas and pick **Projector**
   → a window or display. In non-Studio Mode the single canvas is the live
   program output, so the Projector tracks every scene Deckhand switches to.
   If you use Studio Mode, project **Program** instead of **Preview** —
   Preview is the not-yet-live surface there and will not track Deckhand's
   scene switches.
2. In Zoom (or equivalent), **Share Screen** and select the specific
   **Projector window** (under Windows, not Screens). Always share the window,
   never the display: sharing a display follows whichever Space is visible,
   which breaks the moment you switch Spaces back to your work.

If you fullscreened the Projector to its own Space, do **not** press Esc to
navigate away afterward — Esc closes the Projector window and breaks the
share. Switch Spaces with **Ctrl+Left-arrow** or a **three-finger swipe up**
to get back to your work. Zoom keeps capturing the Projector by window id
regardless of which Space is visible.

Use the Projector path rather than OBS Virtual Camera: the Projector preserves
the native canvas resolution, while a virtual camera re-encodes and caps the
feed around 1080p, which defeats Deckhand's crisp-capture goal.

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
- [Presenter runbook (pre-talk checklist)](docs/RUNBOOK.md)
- [Troubleshooting / known issues](docs/TROUBLESHOOTING.md)

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
