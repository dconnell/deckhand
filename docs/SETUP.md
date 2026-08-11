# Setup

Each presentation is self-contained under `presentation/<name>/`. This document
covers prerequisites, creating a presentation, configuring OBS, and running a
talk end to end. For the full config schema see [CONFIG.md](CONFIG.md); for the
pre-talk checklist see [RUNBOOK.md](RUNBOOK.md); for known issues see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## What you are building

Advancing the local deck coordinates four things:

1. switch OBS scenes for the audience
2. drive Deckhand-owned Chrome windows and tabs (activation and navigation)
3. arrange and focus presenter-side macOS windows
4. update the teleprompter and (optionally) run local speech-to-text

## Prerequisites

- Node 22+
- OBS Studio 28+
- Hammerspoon
- optional: whisper.cpp built with the `whisper-stream` example plus a local
  model file
- this repo cloned locally

```bash
npm install
```

## Create a presentation

1. Copy the sample to a new directory:

   ```bash
   cp -R presentation/example presentation/my-talk
   ```

2. Put local-only values in `presentation/my-talk/config.local.json`
   (git-ignored). It is a deep-merge overlay on `config.json`, so it only needs
   the fields you want to override locally:

   - `obs.password`
   - `presenter.stage`
   - `presenter.windows`
   - optional `presenter.stt`

Everything for that presentation stays under `presentation/my-talk/`. See
[`presentation/README.md`](../presentation/README.md) for choosing a sample.

## Configure OBS

1. Install OBS Studio from <https://obsproject.com>.
2. Grant macOS Screen Recording permission to OBS.
3. Enable the OBS WebSocket in `Tools → WebSocket Server Settings`.
4. Set the OBS password in `config.local.json`:

   ```json
   "obs": {
     "url": "ws://127.0.0.1:4455",
     "password": "<your OBS password>"
   }
   ```

## Build OBS scenes from layouts

Deckhand derives OBS scenes from the presentation's `layouts` catalog.

```bash
npm run obs:setup -- my-talk          # apply the scene setup
npm run obs:setup -- --check my-talk  # read-only validation
npm run obs:setup -- --set-canvas my-talk  # align the OBS canvas to presenter.stage
```

`--set-canvas` mutates a global OBS setting; the default is warn-only.

`obs:setup` provisions scenes and stable input names only. At runtime Deckhand
pushes macOS `window_capture` settings into those inputs and upgrades them from
bootstrap title matching to exact managed window bindings when Hammerspoon
reports them. For strict `macWindowId` updates Deckhand applies a two-step
settings update (`window: 0` then exact id) to force OBS to refresh the bound
target without removing and recreating the source.

If OBS returns `Failed to create the scene item` during reconcile, Deckhand
performs a one-time reset of `Deckhand_*` scenes and inputs and retries
automatically. If OBS authentication fails, runtime startup and smoke checks
fail until `obs.password` is corrected.

## Whole-frame slide transitions

Advancing the deck runs a **freeze → mutate → reveal** sequence: the previous
audience frame is held as a still image while windows resize and tabs navigate
behind it, then the new scene is revealed. This is **on by default**.

| Config | Behavior |
| --- | --- |
| omit `obs.transitions` (or `{}`) | Freeze + plain reveal using OBS's current transition. **Default.** |
| `obs.transitions: false` | Instant cut; OBS transitions and Studio Mode are never touched. |
| `obs.transitions: { forward, backward }` | Freeze + **directional slide** reveal (new frame slides in from the side). Needs the one-time OBS setup below. |

The freeze scene (`Deckhand_Freeze`) and its `image_source` are created
automatically at startup, so the default freeze tier needs no OBS setup. The
**directional slide** is opt-in because OBS WebSocket cannot create transitions
— the `Slide Left` / `Slide Right` transitions must be added in the OBS UI.

### Directional slide reveal setup (one-time, manual)

Only needed if you want the new frame to slide in directionally (`next` from
one side, `prev` from the other) instead of the default plain reveal.

#### 1. Add the Slide transitions in OBS

Add them in the OBS UI once per scene collection:

1. Open the transitions dropdown (top-center, next to the program switcher) and
   choose **Add**.
2. Pick **Slide** as the type and name it for the direction it performs, for
   example `Slide Right`. Set its **Direction** in the properties panel.
3. Repeat for the opposite direction, for example `Slide Left`.

The exact names are yours; Deckhand references them by name from config.

> Direction is visual. If `next` brings the new frame in from the wrong side,
> swap the `forward`/`backward` names below — no code change needed.

Deckhand creates the `Deckhand_Freeze` scene and its `image_source` itself at
startup; do **not** create those manually.

#### 2. Reference the transition names in config

Add an `obs.transitions` block naming the transitions you created (base or
local override):

```json
"obs": {
  "transitions": {
    "forward": "Slide Left",
    "backward": "Slide Right"
  }
}
```

`forward`/`backward` must match Slide transition names in your OBS scene
collection. All other fields are optional (see
[CONFIG.md: Slide Transitions](CONFIG.md#slide-transitions)).

### Disabling transitions entirely

Set `obs.transitions: false` for an instant cut with no freeze and no OBS
interaction:

```json
"obs": { "transitions": false }
```

### Disable reveal.js's own slide animation

Set `transition: 'none'` in your deck's `Reveal.initialize` call so OBS owns
all perceived motion. The shipped sample deck already does this
(`presentation/example/deck/index.html`).

Deckhand captures your default transition at startup and restores it after each
slide change, so manual OBS use between advances is unaffected.

## Hammerspoon

Hammerspoon owns the macOS work Deckhand cannot do itself: window resize,
focus, raise, minimize, and the global slide hotkeys.

```bash
npm run hammerspoon:setup
```

This copies `deckhand.lua`, `apply_state.lua`, and `window_match.lua` into
`~/.hammerspoon/deckhand/` and patches `~/.hammerspoon/init.lua` to load them
on startup. The patch is non-destructive: existing content is preserved, the
Deckhand section is wrapped in `-- >>> deckhand >>>` / `-- <<< deckhand <<<`
sentinels, re-runs replace that section in place, and a fresh install appends
cleanly.

Optional overrides:

```bash
npm run hammerspoon:setup -- --hub-url ws://127.0.0.1:9000
npm run hammerspoon:setup -- --hammerspoon-dir /path/to/alt/hammerspoon
```

After installing:

1. Open Hammerspoon and grant Accessibility permission when prompted.
2. Reload Hammerspoon.
3. Confirm the Deckhand log shows another observer registration after
   Hammerspoon connects.

Hammerspoon subscribes to sticky `presentationState`, applies resolved window
rectangles plus optional focus, binds the slide hotkeys (`Ctrl+Shift+Right` =
next, `Ctrl+Shift+Left` = previous), and reports exact runtime window bindings
back to Deckhand. Startup waits briefly for those exact bindings before the
final OBS binding pass; if Hammerspoon is missing or outdated, Deckhand warns
and OBS browser captures may stay blank.

Whenever you update Deckhand, re-run `npm run hammerspoon:setup` and reload
Hammerspoon. The exact-window-id handshake depends on the current versions of
all three Lua files.

## Browser sources

Deckhand owns its own Chrome session and the windows/tabs it needs for a
presentation — no userscript is required. At startup it launches one dedicated
Chrome process using a separate profile (so your personal Chrome stays
untouched), then creates one window per browser source and preloads the
declared tabs.

Configure browser sources and their tab catalogs under `sources.<id>.browser`
(see [CONFIG.md: Browser Sources](CONFIG.md#browser-sources)). Slide actions
address logical `source` IDs and source-local tab aliases, for example:

```json
"slides": {
  "dual-demo": {
    "layout": "dual-browser",
    "browser": [
      { "source": "BrowserA", "action": "activateTab", "tab": "checkout" },
      { "source": "BrowserB", "action": "activateTab", "tab": "main" }
    ]
  }
}
```

Optional `chrome` settings override the executable path, profile directory, and
debugging port. If `chrome.profileName` is set, Deckhand seeds a Deckhand-owned
working copy from that named Chrome profile so cookies and sessions are
available without attaching to your ordinary Chrome instance. Browser-session
health is reported at `/status.json` under `browserSession`.

## STT runner (optional)

Build `whisper-stream` and download a local whisper.cpp model first:

```bash
git clone https://github.com/ggml-org/whisper.cpp.git
cmake -B whisper.cpp/build -DWHISPER_SDL2=ON whisper.cpp
cmake --build whisper.cpp/build -j --config Release
```

```bash
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Run the local whisper observer:

```bash
npm run presenter:stt -- my-talk                         # long-running
npm run presenter:stt -- --retry-delay-ms 250 my-talk    # tune retry delay
npm run presenter:stt -- --once my-talk                  # one-shot test
```

Deckhand's presenter STT config now targets `whisper-stream` directly. The
default sample settings use `mode: "step"` with `stepMs: 1500`,
`lengthMs: 6000`, and `keepMs: 250`, which keeps follow mode responsive while
still giving the decoder enough context to stabilize short phrases.

Use `mode: "vad"` when you want speech-activity-triggered bursts instead of a
steady cadence. In `vad` mode, tune `lengthMs`, `vadThreshold`, and
`freqThreshold` first; in `step` mode, tune `stepMs` and `keepMs` first.

On first use, macOS may prompt for microphone access for the terminal or Node.

## Serve the deck and start the coordinator

You need **one terminal window**:

```bash
node ./src/index.js my-talk
```

This connects to OBS and starts the deck HTTP server, the presenter HTTP
surface, and the WebSocket hub. Startup waits for the first real driver
position before reporting readiness (and, in presenter mode, for exact
Hammerspoon window bindings before the final OBS binding pass).

Then open:

- `http://127.0.0.1:3000/presentation/my-talk/deck/index.html` — the deck
- `http://127.0.0.1:3001/presenter/` — teleprompter and follow mode
- `http://127.0.0.1:3001/status.json` — runtime status

On shutdown, Deckhand closes only the windows it launched for the session:
managed browser windows/tabs and owned `app` windows (including iTerm2
terminals). For owned `app` windows it targets only the tracked exact macOS
window id and never terminates the whole app process; if an unsaved-changes
sheet appears, it attempts Don't Save/Discard for that tracked window.

### Navigating slides

Either:

- use the deck's own keyboard shortcuts (arrow keys, space) in the browser, or
- use the Hammerspoon global hotkeys: **Ctrl+Shift+Right** = next,
  **Ctrl+Shift+Left** = previous.

When you advance, the coordinator switches the OBS scene, publishes presenter
state (Hammerspoon resizes windows, teleprompter updates), and dispatches any
configured browser commands to Deckhand-owned tabs.

## Sharing to the meeting

The OBS program output is shared into the meeting via OBS's **Projector**
feature, not as a virtual camera:

1. In OBS (non-Studio Mode), right-click the canvas and pick **Projector** → a
   window or display. The single canvas is the live program output, so the
   Projector tracks every scene Deckhand switches to. In Studio Mode, project
   **Program** instead of **Preview** — Preview is not live there.
2. In Zoom (or equivalent), **Share Screen** and select the specific
   **Projector window** (under Windows, not Screens). Always share the window:
   sharing a display follows whichever Space is visible, which breaks the
   moment you switch Spaces back to your work.

If you fullscreened the Projector to its own Space, do **not** press Esc to
leave — Esc closes the Projector and breaks the share. Switch Spaces with
**Ctrl+Left-arrow** or a **three-finger swipe up** instead; Zoom keeps
capturing the window by id.

Use the Projector path rather than OBS Virtual Camera: the Projector preserves
the native canvas resolution, while a virtual camera re-encodes and caps the
feed around 1080p, which defeats Deckhand's crisp-capture goal.

## Validate the runtime

```bash
npm run presenter:doctor -- my-talk  # validate config and environment
npm run presenter:smoke -- my-talk   # check the running presenter surfaces
```

`presenter:smoke` checks `GET /presenter/`, `GET /presenter/bootstrap.json`,
`GET /status.json`, and a websocket observer registration against the local
hub. Neither command validates OBS Screen Recording permission, Hammerspoon,
or whether managed Chrome windows actually move on a slide advance — the
end-to-end advance test in [RUNBOOK.md](RUNBOOK.md#t-1-verify-the-four-outputs)
is the only substitute for those.

When `presenter.stt` is configured, `presenter:doctor` validates the configured
`whisperBin` and model paths and then runs `whisper-stream --help` as a light
smoke check.

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for known issues and recovery
steps.
