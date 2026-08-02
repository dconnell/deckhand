# Setup

Deckhand is macOS-only. Each presentation lives under
`presentation/<name>/` and is self-contained there.

## What you're building

Advancing a local deck coordinates:

1. switch OBS scenes for the audience
2. drive Deckhand-owned Chrome windows and tabs (activation and navigation)
3. local presenter-stage window arrangement and focus
4. teleprompter state and optional local STT

## Prerequisites

- Node 24+
- OBS Studio 28+
- Hammerspoon
- `ffmpeg` with macOS `avfoundation` support
- optional: whisper.cpp plus a local model file
- this repo cloned locally

Install dependencies:

```bash
npm install
```

## Create A Presentation

1. Copy `presentation/example/` to a new directory:

```bash
cp -R presentation/example presentation/my-talk
```

2. Update `presentation/my-talk/config.json` for your machine:

- presentation-specific defaults you want to share with the repo

3. Put local-only values in `presentation/my-talk/config.local.json`:

- `obs.password`
- `presenter.stage`
- `presenter.windows`
- optional `presenter.stt`

Everything for that presentation should stay under `presentation/my-talk/`.

## Configure OBS

1. Install OBS Studio from <https://obsproject.com>.
2. Grant macOS Screen Recording permission to OBS.
3. Enable OBS WebSocket in `Tools -> WebSocket Server Settings`.
4. Set the correct OBS password in `presentation/my-talk/config.local.json`:

```json
"obs": {
  "url": "ws://127.0.0.1:4455",
  "password": "<your OBS password>"
}
```

## Build OBS Scenes From Layouts

Deckhand derives OBS scenes from the presentation's `layouts` catalog.

Apply the scene setup:

```bash
npm run setup:obs -- my-talk
```

Read-only validation mode:

```bash
npm run setup:obs -- --check my-talk
```

If you want Deckhand to align the OBS canvas to the configured presenter stage:

```bash
npm run setup:obs -- --set-canvas my-talk
```

`--set-canvas` mutates a global OBS setting. Default behavior is warn-only.

`setup:obs` provisions the scenes and stable input names only. During runtime,
Deckhand pushes macOS `window_capture` settings into those inputs and upgrades
them from bootstrap title matching to exact managed window bindings when
Hammerspoon reports them.

If OBS requires authentication and your local override does not have the right
password yet, `node ./src/index.js my-talk` and presenter smoke checks will fail until
you update `obs.password`.

## Whole-Frame Slide Transitions (Optional)

By default, advancing the deck cuts the audience scene instantly. Optionally,
Deckhand can slide the whole audience frame in directionally (`next` from the
right, `prev` from the left) while a freeze-frame masks the window resize and
page navigation behind a still image. This is off unless you configure it.

### 1. Add the slide transitions in OBS (one-time, manual)

OBS WebSocket cannot create transitions, so you must add them in the OBS UI
once per scene collection:

1. In OBS, open the transitions dropdown (the control near the top-center next
   to the program switcher) and choose **Add**.
2. Pick **Slide** as the type and name it for the direction it will perform,
   for example `Slide Right`. Set its **Direction** in the properties panel.
3. Repeat to add a second Slide transition for the opposite direction, for
   example `Slide Left`.

The exact names are yours; Deckhand references them by name from config.

> Direction is visual: confirm in the OBS program monitor which way each
> transition actually moves the new frame. If `next` brings the new frame in
> from the wrong side, swap the `forward`/`backward` names below -- no code
> change needed.

Deckhand creates the `Deckhand Freeze` scene and its `image_source` itself at
startup, so do **not** create those manually.

### 2. Enable transitions in config

Add an `obs.transitions` block to your config (base or local override):

```json
"obs": {
  "url": "ws://127.0.0.1:4455",
  "password": "<your OBS password>",
  "transitions": {
    "forward": "Slide Right",
    "backward": "Slide Left"
  }
}
```

- `forward` and `backward` are required and must match Slide transition names
  that exist in your OBS scene collection.
- All other fields are optional (see [CONFIG.md](CONFIG.md#slide-transitions)).

With this block present, every slide advance runs the freeze -> resize ->
directional-reveal sequence. With it absent, Deckhand uses the legacy instant
cut and your OBS transitions are never touched.

### 3. Disable reveal.js's own slide animation

The OBS transition should own all perceived motion, so set `transition: 'none'`
in your deck's `Reveal.initialize` call. The shipped example deck already does
this (`presentation/example/deck/index.html`).

### What Deckhand does and does not touch

- Deckhand captures your current default transition at startup and restores it
  after each slide change, so manual OBS use between advances is unaffected.
- The freeze masks window resize, content reflow, and tab navigation. The
  reveal.js deck window still moves the instant you advance (that is the driver
  and is expected); only the audience feed is masked.

## Serve The Deck And Start The Coordinator

You need **one terminal window**.

**Terminal 1 -- managed runtime session:**

```bash
node ./src/index.js my-talk
```

Connects to OBS, starts the deck and presenter HTTP surfaces, and starts the
WebSocket hub.

Then open:

- `http://127.0.0.1:3000/presentation/my-talk/deck/index.html` -- the deck
- `http://127.0.0.1:3001/presenter/` -- teleprompter and follow mode
- `http://127.0.0.1:3001/status.json` -- runtime status

### Navigating Slides

Either:
- Use the deck's own keyboard shortcuts (arrow keys, space) in the browser
- Or use the Hammerspoon global hotkeys: **Ctrl+Shift+Right** = next,
  **Ctrl+Shift+Left** = previous

When you advance, the coordinator switches the OBS scene, publishes presenter
state (Hammerspoon resizes windows, teleprompter updates), and dispatches any
configured browser commands to Deckhand-owned tabs.

When the runtime shuts down, Deckhand closes only the browser windows and tabs
it created for the session.

## Validate The Runtime

Check the local environment and config:

```bash
npm run presenter:doctor -- my-talk
```

Check the running presenter surfaces once Deckhand is up:

```bash
npm run presenter:smoke -- my-talk
```

This checks:

- `GET /presenter/`
- `GET /presenter/bootstrap.json`
- `GET /status.json`
- websocket observer registration against the local hub

## Hammerspoon

1. Create `~/.hammerspoon/deckhand/`.
2. Copy the Deckhand Lua files and fixtures into it:

```bash
mkdir -p ~/.hammerspoon/deckhand
cp hammerspoon/deckhand.lua hammerspoon/apply_state.lua hammerspoon/window_match.lua ~/.hammerspoon/deckhand/
```
3. If you already have `~/.hammerspoon/init.lua`, keep it and append:

```lua
package.path = package.path .. ";" .. hs.configdir .. "/deckhand/?.lua"

require("deckhand").start({
  hubUrl = "ws://127.0.0.1:8765",
})
```

4. If you do not already have `~/.hammerspoon/init.lua`, copy `hammerspoon/init.lua` there.
5. Open Hammerspoon and grant macOS Accessibility permission when prompted.
6. Reload Hammerspoon.
7. Confirm the coordinator log shows another observer registration after Hammerspoon connects.

Whenever you update Deckhand, copy those Lua files again and reload Hammerspoon.
The exact-window-id handshake depends on the current versions of all three
files.

Hammerspoon subscribes to sticky `presentationState` and applies the resolved
window rectangles plus optional focus. It reconnects after hub restarts and
accepts lower `seq` values after reconnect so sticky state can recover cleanly.

For managed windows, Hammerspoon also reports exact runtime bindings back to
Deckhand after it resolves them once. Deckhand then republishes sticky
`presentationState` with `pid`, `macWindowId`, and `strict: true` so later
layout passes no longer depend on title or first-window matching.

Startup now waits briefly for those exact bindings before it does the final OBS
binding pass for browser sources. If Hammerspoon is not updated or not running,
Deckhand warns and OBS browser captures may stay blank.

Deckhand's Hammerspoon integration also binds slide navigation hotkeys:

- `Ctrl+Shift+Right`: next slide
- `Ctrl+Shift+Left`: previous slide

These hotkeys send `driverCommand` messages through the local hub to the active
driver.

## STT Runner

Run the local whisper observer:

```bash
npm run presenter:stt -- my-talk
```

Long-running mode retries capture/transcription failures with a bounded delay.
Tune the retry delay if you want faster local recovery:

```bash
npm run presenter:stt -- --retry-delay-ms 250 my-talk
```

Optional one-shot test:

```bash
npm run presenter:stt -- --once my-talk
```

On first use, macOS may prompt for microphone access for the terminal or Node.

## Browser Sources

Deckhand owns its own Chrome session and the windows/tabs it needs for a
presentation. No userscript is required.

When the coordinator starts, it launches one dedicated Chrome process using a
separate profile (so your personal Chrome usage stays untouched), then creates
one window per browser source and preloads the declared tabs.

Configure browser sources and their tab catalogs under `sources.<id>.browser`
(see [CONFIG.md](CONFIG.md)). Slide actions address logical `source` IDs and
source-local tab aliases, for example:

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

Optional `chrome` settings let you override the executable path, profile
directory, and debugging port:

```json
"chrome": {
  "profileName": "Personal",
  "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "profileDir": "/tmp/deckhand-chrome",
  "debugPort": 9222
}
```

If `profileName` is set, Deckhand seeds a Deckhand-owned working copy from that
named Chrome profile so cookies and sessions are preserved for the presentation
without attaching to your ordinary Chrome instance.

Browser-session health is reported at `/status.json` under `browserSession`.

## Troubleshooting

- presenter page stays blank:
  - verify `node ./src/index.js my-talk`
  - verify `npm run presenter:smoke -- my-talk`
  - verify `/status.json`
  - verify the browser console can connect to `ws://127.0.0.1:8765`
- windows do not move:
  - verify Hammerspoon Accessibility permission
  - verify the Lua files live under `~/.hammerspoon/deckhand/`
  - verify `presenter.windows` app names and bootstrap `titleIncludes` values
- STT publishes nothing:
  - verify `npm run presenter:doctor -- my-talk`
  - verify microphone permission
  - verify whisper/model paths
  - verify `ffmpeg` is installed
