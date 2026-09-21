# Config

Each presentation lives under `presentation/<name>/` and uses one layout-driven
model for OBS, the presenter stage, and slide actions.

- `presentation/<name>/config.json` — tracked, shareable presentation config
- `presentation/<name>/config.local.json` — optional, untracked local override
  for secrets and machine-specific values; deep-merged on top of `config.json`

## Shape

```json
{
  "driver": { "type": "revealjs" },
  "obs": { "url": "ws://127.0.0.1:4455", "password": "" },
  "hub": { "port": 8765 },
  "sources": {
    "Slide": {
      "kind": "browser",
      "browser": {
        "window": { "label": "slide" },
        "tabs": {
          "deck": { "url": "http://127.0.0.1:3000/deck/index.html", "initial": true }
        }
      }
    },
    "Terminal": { "kind": "app", "app": "iTerm2", "command": "npm run dev", "cwd": "/repos/demo" },
    "Editor": { "kind": "app", "app": "Visual Studio Code", "args": ["--new-window", "/repos/demo"] },
    "BrowserA": {
      "kind": "browser",
      "browser": {
        "window": { "label": "browser-a" },
        "tabs": {
          "home": { "url": "https://example.com/demo/home", "initial": true },
          "checkout": { "url": "https://example.com/demo/checkout" }
        }
      }
    },
    "BrowserB": {
      "kind": "browser",
      "browser": {
        "window": { "label": "browser-b" },
        "tabs": {
          "main": { "url": "https://example.com/demo/secondary", "initial": true }
        }
      }
    }
  },
  "layouts": {
    "full-slide": {
      "audienceScene": "Full Slide",
      "slots": [{ "source": "Slide", "position": "full" }],
      "overlays": [
        { "source": "Presenter", "rect": { "x": 1600, "y": 50, "w": 250, "h": 400 } }
      ]
    },
    "dual-browser": {
      "audienceScene": "Dual Browser",
      "slots": [
        { "source": "BrowserA", "position": "left" },
        { "source": "BrowserB", "position": "right" }
      ]
    }
  },
  "slides": {
    "intro": {
      "layout": "full-slide"
    },
    "demo": {
      "layout": "dual-browser",
      "focus": "BrowserB",
      "script": "Walk through the demo.\nCall out BrowserB.",
      "overlays": [
        { "source": "Presenter", "hidden": true }
      ],
      "browser": [
        { "source": "BrowserA", "action": "activateTab", "tab": "checkout" },
        { "source": "BrowserB", "action": "navigate", "tab": "main", "url": "https://example.com/demo/v2" }
      ]
    }
  },
  "chrome": {
    "profileName": "Personal",
    "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "profileDir": "/tmp/deckhand-chrome",
    "debugPort": 9222
  },
  "presenter": {
    "platform": "macos",
    "stage": { "x": 0, "y": 0, "width": 1800, "height": 1168 },
    "windows": {
      "Slide": { "app": "Google Chrome", "titleIncludes": "Deckhand Deck" },
      "BrowserA": { "app": "Google Chrome", "titleIncludes": "Primary" },
      "BrowserB": { "app": "Google Chrome", "titleIncludes": "Secondary" }
    },
    "stt": {
      "whisperBin": "/opt/homebrew/bin/whisper-stream",
      "model": "/absolute/path/to/ggml-large-v3-turbo.bin",
      "mode": "step",
      "captureId": -1,
      "stepMs": 1000,
      "lengthMs": 4000,
      "keepMs": 250,
      "threads": 4,
      "audioCtx": 0,
      "beamSize": -1,
      "keepContext": false,
      "noFallback": true,
      "useGpu": true,
      "flashAttn": true,
      "language": "en"
    },
    "teleprompter": {
      "followEnabledByDefault": true,
      "tracking": {
        "farJumpLines": 8,
        "offScriptMs": 3000,
        "lostMs": 8000,
        "minConfidence": 0.35
      },
      "window": { "app": "Google Chrome", "titleIncludes": "Deckhand Presenter" }
    },
    "http": {
      "host": "127.0.0.1",
      "port": 3001
    }
  }
}
```

## Core fields

- `driver.type` — currently `revealjs`
- `obs.url` — OBS WebSocket URL
- `obs.password` — OBS WebSocket password
- `obs.prune` — boolean, default `true`. Deckhand reconciles OBS to the current
  config, removing any `Deckhand_*` inputs/scenes it created that this
  presentation no longer references. Non-`Deckhand_*` content is never touched.
  Set `false` to leave stale entities in place. See
  [OBS Reconciliation](#obs-reconciliation).
- `obs.transitions` — slide transitions are **enabled by default**. Omit the
  block (or pass an empty object `{}`) to use the defaults; set `false` to
  disable transitions entirely (instant cut, OBS transitions never touched).
  See [Slide Transitions](#slide-transitions).
- `hub.port` — localhost WebSocket port for driver and observer clients

## Sources

`sources` is the authoritative catalog of logical source IDs; layouts, slide
actions, and presenter bindings all reference IDs declared here. The canonical
presentation sources are `Slide`, `Terminal`, `BrowserA`, and `BrowserB`. Names
describe what the operator coordinates — not position, transport, or OBS
implementation — and IDs stay stable across layouts. To run two live browser
windows, declare two browser sources such as `BrowserA` and `BrowserB`.

Each entry declares a `kind`:

- `browser` — a source Deckhand owns end-to-end through its own Chrome session
- `app` — a macOS app Deckhand launches via `open -a` (an editor, iTerm2)

For copy-paste snippets see [Browser recipes](#browser-recipes) and
[App recipes](#app-recipes). For the full field reference see
[Browser sources](#browser-sources) and [App sources](#app-sources).

All non-`browser` sources are *owned* sources: Deckhand launches the window,
captures its exact macOS window id by diffing the window list before and after
launch, and binds it strictly. Identity is the runtime window handle, never the
title.

App-specific launch/close quirks live in per-app adapters under `src/apps/`.
Adding an app that misbehaves is one adapter file plus one registry line in
`src/apps/index.js`; generic apps fall through to the default adapter and need
no file. See [Architecture: Owned App Sources](ARCHITECTURE.md#owned-app-sources)
and [Adapters: App Adapters](ADAPTERS.md#app-adapters).

### Browser recipes

A `browser` source is a Chrome window Deckhand owns end-to-end. Declare one
under `sources`, give it a tab catalog, then address it from layouts and slide
actions. These snippets cover the common shapes; see
[Browser sources](#browser-sources) for the full field reference.

#### Minimal — one tab

```json
"Slide": {
  "kind": "browser",
  "browser": {
    "window": { "label": "slide" },
    "tabs": {
      "deck": { "url": "http://127.0.0.1:3000/presentation/my-talk/deck/index.html", "initial": true }
    }
  }
}
```

#### Multiple tabs (preloaded, switch without reloading)

```json
"BrowserA": {
  "kind": "browser",
  "browser": {
    "window": { "label": "browser-a" },
    "tabs": {
      "home":     { "url": "https://example.com/demo/home",     "initial": true },
      "checkout": { "url": "https://example.com/demo/checkout" }
    }
  }
}
```

#### Driving a browser source from a slide

`activateTab` switches to a preloaded tab without reloading it; `navigate`
loads a new URL in a named tab.

```json
"slides": {
  "demo": {
    "layout": "dual-browser",
    "browser": [
      { "source": "BrowserA", "action": "activateTab", "tab": "checkout" },
      { "source": "BrowserB", "action": "navigate", "tab": "main", "url": "https://example.com/demo/v2" }
    ]
  }
}
```

See [Slides](#slides) for the full `browser` action reference.

### Browser sources

A `browser` source declares a `browser` catalog with a `tabs` map. Deckhand
creates one Chrome window per browser source and preloads the declared tabs at
startup. Identity is a runtime handle owned by Deckhand, never URL or title
lookup.

- `window.label` — optional source label carried in the runtime registry for
  managed-window bookkeeping
- `tabs` — non-empty map of source-local tab aliases to tab descriptors
- each tab descriptor takes:
  - `url` — absolute `http` or `https` URL
  - `initial` — optional boolean; exactly one tab (or none, defaulting to the
    first declared) is the active tab at startup
  - `preload` — optional boolean that currently must remain `true`; Deckhand
    preloads every declared tab at startup

### App recipes

An `app` source launches a macOS app via `open -a`; Deckhand captures the new
window by owner-name diff and closes only that window on shutdown. The table
maps every supported `app` value to its adapter, prerequisite, and a
copy-paste block. Apps not listed fall through to the `default` adapter (see
[Generic apps](#generic-apps-default) at the end of this section).

| `app` value | Adapter | Prerequisite |
| --- | --- | --- |
| [`iTerm2`](#iterm2) | `iterm2` | none |
| [`Terminal`](#apple-terminal) | `appleTerminal` | none |
| [`Ghostty`](#ghostty) | `ghostty` | none |
| [`kitty`](#kitty) | `kitty` | `KITTY_LISTEN_ON` env |
| [`Alacritty`](#alacritty) | `alacritty` | already running |
| [`Visual Studio Code`](#visual-studio-code) | `vscode` | none |
| [`Slack`](#slack) | `slack` | none |
| *anything else* | [`default`](#generic-apps-default) | none |

Terminal adapters honor `command` + `cwd`; non-terminal adapters ignore them.
See [Other app fields](#other-app-fields) for the field reference, and
[What the app opens](#what-the-app-opens) for the `args` / `files` / `openArgs`
split.

#### iTerm2

```json
"Terminal": {
  "kind": "app",
  "app": "iTerm2",
  "command": "npm run dev",
  "cwd": "/repos/demo"
}
```

AppleScript-driven: Deckhand creates a new iTerm2 window, runs the optional
shell command at the working directory, and closes by session UUID on shutdown
(not by process kill). Adapter: `src/apps/iterm2.js`. No prerequisite.

#### Apple Terminal

```json
"AppleTerminal": { "kind": "app", "app": "Terminal", "command": "npm run dev", "cwd": "/repos/demo" }
```

AppleScript-driven; works out of the box. The `app` value `Terminal` also
matches `Terminal.app`, `Apple Terminal`, and `AppleTerminal`.

#### Ghostty

```json
"Ghostty": { "kind": "app", "app": "Ghostty", "command": "npm run dev", "cwd": "/repos/demo" }
```

AppleScript-driven; works out of the box.

#### kitty

```json
"Kitty": { "kind": "app", "app": "kitty", "command": "npm run dev", "cwd": "/repos/demo" }
```

Driven via `kitty @` remote control. Requires `allow_remote_control yes` and a
listen address configured in kitty, plus `KITTY_LISTEN_ON=unix:/tmp/kitty`
exported in Deckhand's environment before startup. See
[Adapters: Terminal app prerequisites](ADAPTERS.md#terminal-app-prerequisites)
for the exact setup.

#### Alacritty

```json
"Alacritty": { "kind": "app", "app": "Alacritty", "command": "npm run dev", "cwd": "/repos/demo" }
```

Driven via `alacritty msg create-window` IPC. **Alacritty must already be
running** so Deckhand can discover its IPC socket. Alacritty's IPC has no
destroy-window command, so close falls back to the generic AX path using the
diff-resolved CGWindowID. See
[Adapters: Terminal app prerequisites](ADAPTERS.md#terminal-app-prerequisites).

#### Visual Studio Code

```json
"Editor": { "kind": "app", "app": "Visual Studio Code", "args": ["--new-window", "/repos/demo"] }
```

Electron app built on the shared splash-rejection base. `--new-window` is
auto-injected if omitted, so the snippet works with or without it. `cwd` is
ignored. The `app` value also matches `Code`. Adapter: `src/apps/vscode.js`.

#### Slack

Slack accepts either a structured `slack` field or a raw `uri`, and runs in
one of two modes:

```json
"QnA": {
  "kind": "app",
  "app": "Slack",
  "slack": { "target": "channel", "team": "T14AN54JA", "id": "C07HV1N2N31" }
}
```

```json
"QnA": {
  "kind": "app",
  "app": "Slack",
  "uri": "slack://channel?team=T14AN54JA&id=C07HV1N2N31",
  "newWindow": true
}
```

- `target` — `channel` (default; channels and group DMs) or `user` (one-on-one
  DMs)
- `team` / `id` — find them in any Slack web URL:
  `https://app.slack.com/client/{TEAM_ID}/{CHANNEL_ID}`
- **Navigation mode** (default, no `newWindow`): `open "slack://…"` activates
  Slack and switches to the channel in the existing window. No new window, no
  close — Deckhand cannot own a window Slack does not create, so it skips diff
  binding and matches the Slack window by app + `titleIncludes`.
- **Browser mode** (`newWindow: true`): a new Chrome window opens the Slack web
  client at the same channel, `https://app.slack.com/client/{team}/{id}`, using
  your normal Chrome profile (already logged in). That window is Deckhand-owned
  and closed on shutdown.
- Bare `app: "Slack"` with no `slack` / `uri` field falls through to the
  default adapter and just launches the app.

#### Generic apps (default)

Any macOS app not listed above uses the `default` adapter (`open -a`) —
Preview, Safari, TextEdit, and QuickTime Player all work without an adapter
file. Pick exactly one of `args`, `files`, or `openArgs` (or none for a bare
new window):

```json
"Photo": { "kind": "app", "app": "Preview", "files": ["image.jpg"] },
"Site":  { "kind": "app", "app": "Safari",  "openArgs": ["https://example.com"] }
```

Apps that misbehave (unsaved-changes sheets, single-instance handoffs) may need
a dedicated adapter — see [Adapters: App adapters](ADAPTERS.md#app-adapters).

### App sources

An `app` source is a macOS app Deckhand launches via `open -a`. The new window
is captured by owner-name diff (PID-based diff is unreliable for Electron
single-instance apps such as VS Code, which hand off to an already-running
process).

At shutdown, Deckhand closes only the tracked window for each `app` source by
exact `macWindowId` (not the whole app process). If the app shows an
unsaved-changes sheet, Deckhand attempts to press Don't Save/Discard for that
tracked window so shutdown can complete without manual prompts.

For copy-paste snippets by app see [App recipes](#app-recipes).

#### What the app opens

An `app` source launches as `open -n -a <app>`. Three optional fields control
what follows the app name; `args`, `files`, and `openArgs` are mutually
exclusive:

| Field | Use when | How Deckhand passes it to `open` |
| --- | --- | --- |
| `args` | The app reads its own flags at launch (VS Code's `--new-window`) | After `--args`, forwarded to the app's `main()`: `… --args <args…>` |
| `files` | The app opens documents by path (Preview, QuickTime Player, TextEdit) | As positional args: `… <files…>`. Relative paths resolve to the presentation directory; existence is checked at load |
| `openArgs` | You need exact `open` grammar the other two can't express (`-g`, `--env`, a URL for Safari) | Verbatim: `… <openArgs…>`. No `--args`, no path resolution, no existence check |

With none of them, Deckhand opens a bare new window. The split exists because
macOS `open` treats positional files and `--args`-forwarded values differently:
document-centric apps ignore `--args`, so `files` is the only way to make
Preview, TextEdit, or QuickTime Player actually open anything.

```json
"sources": {
  "Editor": { "kind": "app", "app": "Visual Studio Code", "args": ["--new-window", "/repos/demo"] },
  "Photo":  { "kind": "app", "app": "Preview", "files": ["image.jpg"] },
  "Site":   { "kind": "app", "app": "Safari", "openArgs": ["https://example.com"] }
}
```

#### Other app fields

- `app` — required macOS app name as `open -a` expects it (e.g.
  `Visual Studio Code`, `iTerm2`, `Preview`)
- `cwd` — optional absolute working directory; honored only by terminal
  adapters (`iTerm2`, `Terminal`, `Ghostty`, `kitty`, `Alacritty`). Ignored by
  non-terminal apps
- `command` — optional shell command run inside the new window; honored only by
  terminal adapters. Ignored by apps that don't need it

## Chrome session

The optional top-level `chrome` section customizes the dedicated Chrome process
Deckhand launches for browser sources:

- `executablePath` — absolute path to a Chrome or Chromium binary
- `profileDir` — absolute path to a dedicated user-data directory; when
  omitted, Deckhand creates a fresh per-run working directory under the system
  temp dir
- `profileName` — optional visible Chrome profile name to seed that working
  copy from, such as `Personal`
- `debugPort` — remote debugging port (a random port in 9222-9322 by default)
- `extraArgs` — array of extra Chrome command-line arguments

Deckhand only ever controls windows and tabs it created in this session; the
operator's ordinary Chrome usage is left untouched. When `profileName` is set,
Deckhand resolves that named Chrome profile and launches a Deckhand-owned
working copy seeded from it. DevTools port discovery uses the launched
profile's `DevToolsActivePort` file so the actual port wins even when Chrome
chooses a different one than requested.

## Layouts

`layouts` is the source of truth for audience scene names and logical source
placement. Each layout contains:

- `audienceScene` — OBS scene name
- `slots` — array of logical window positions
- `overlays` — optional array of presenter-only overlays

Each slot contains:

- `source` — logical source ID declared in `sources`
- `position` — `full`, `left`, or `right`

Rules:

- each layout must define at least one slot
- slot source names must be unique within a layout
- every slot source must exist in `sources`
- overlay source names must be unique within a layout
- `Presenter` is reserved for presenter-only overlays and is not allowed in
  `slots`
- `audienceScene` should be unique across layouts

Overlay entries currently support only the reserved source `Presenter` and must
declare exactly one of:

- `rect` — absolute macOS desktop rect `{ x, y, w, h }`
- `hidden: true` — minimize the teleprompter for that layout or slide

## Slides

Each slide entry supports:

- `layout` — required layout ID
- `focus` — optional logical source to focus after the presenter layout is
  applied
- `script` — optional teleprompter text; absent means clear the presenter
  script
- `overlays` — optional presenter-only overlay overrides, merged by source on
  top of the layout's `overlays`
- `browser` — optional array of browser actions executed against Deckhand-owned
  tabs

Each `browser` action contains:

- `source` — browser-capable source ID declared in `sources`
- `action` — `activateTab` or `navigate`
- `tab` — source-local tab alias declared in the source's `browser.tabs`
- `url` — required when `action` is `navigate`; absolute `http` or `https` URL

`activateTab` switches to a preloaded tab by its runtime handle without
reloading it. `navigate` loads a new URL in the named tab.

## Slide transitions

Slide transitions are **enabled by default**: advancing the deck runs a
freeze → resize → directional-reveal sequence instead of an instant cut. The
previous audience frame is held as a still while windows resize and tabs
navigate behind it, then the new scene is revealed.

Set `obs.transitions: false` to disable transitions entirely (instant cut,
OBS transitions and Studio Mode never touched):

```json
"obs": {
  "transitions": false
}
```

All fields are optional — an empty block `"transitions": {}` enables the
freeze with defaults:

```json
"obs": {
  "transitions": {
    "forward": "Slide Left",
    "backward": "Slide Right"
  }
}
```

Optional fields (with defaults):

- `forward` — OBS transition name used for `next`/forward moves (`null`; when
  unset, the reveal uses OBS's current transition). Must already exist in OBS —
  OBS WebSocket cannot create transitions, so add it in the OBS UI once.
- `backward` — OBS transition name used for `prev`/backward moves (`null`; same
  rules as `forward`).
- `freezeScene` — OBS scene name for the freeze still (`Deckhand_Freeze`);
  created automatically at startup
- `freezeImage` — `image_source` input name inside the freeze scene
  (`Deckhand_Freeze Frame`); created automatically
- `freezeImagePath` — PNG path for the freeze still; defaults to
  `deckhand-freeze-frame.png` under the system temp dir
- `durationMs` — slide transition duration in milliseconds (`300`)
- `settleMs` — pause after the freeze appears and after pure-resize mutates,
  before revealing (`200`)
- `freezeDimPercent` — opacity reduction (0–100) applied to the freeze still
  while a slide change is masked behind it (`5`); gives the presenter a subtle
  cue that the advance registered. `0` disables the dim entirely.
- `navigationWaitMs` — cap waited behind the freeze for slides that navigate a
  tab, before revealing regardless of load state (`1000`)

Because transitions default on, run `npm run obs:setup -- <name>` once per
presentation so OBS has the freeze scene/input (`Deckhand_Freeze` /
`Deckhand_Freeze Frame`) the sequence expects. See
[SETUP.md: Whole-frame slide transitions](SETUP.md#whole-frame-slide-transitions)
for the one-time directional-transition setup.

Behavior notes:

- Every slide advance runs the sequence while transitions are enabled,
  including same-scene advances.
- Deckhand captures your default transition at startup and restores it after
  each change, so manual OBS use between advances is unaffected.
- Set `transition: 'none'` in the deck's `Reveal.initialize` so OBS owns all
  perceived motion.

## OBS reconciliation

Every OBS entity Deckhand creates is named with a `Deckhand_` prefix (for
example the `BrowserA` source becomes the `Deckhand_BrowserA` input, and the
`Full Browser` audience scene becomes `Deckhand_Full Browser`). The prefix is
the ownership marker that lets Deckhand reconcile safely against the operator's
own OBS content.

On `obs:setup` and at runtime (controlled by `obs.prune`, default `true`),
Deckhand reconciles OBS to the current presentation:

- inputs and scenes for every source/scene in the current layouts are created
  or updated;
- any existing `Deckhand_*` input or scene no longer referenced by the current
  config is removed;
- non-`Deckhand_*` entities are never modified or removed;
- freeze assets (`Deckhand_Freeze` / `Deckhand_Freeze Frame`) are retained
  while `obs.transitions` is configured and pruned when a presentation drops
  transitions.

This is stateless: there is no manifest or state directory, and the
reconciliation is driven entirely by the current config and the `Deckhand_`
prefix. Because earlier builds named OBS entities without the prefix, a
one-time manual cleanup of those old names may be needed after upgrading.

## Presenter

`presenter` is optional; if omitted, Deckhand still supports the audience-only
flow. When present:

- `platform` must be `macos`
- `stage` defines the presenter-stage rectangle; width must be even
- `windows` maps logical sources to macOS window selectors; every key must
  exist in `sources`. A selector is optional for owned source kinds
  (`browser`, `app`): their owner name is derived from the source descriptor
  and their exact `macWindowId` is resolved at launch, so `titleIncludes` is
  not required
- `stt` configures the local `whisper-stream` observer
- `teleprompter.followEnabledByDefault` controls initial follow mode
- `teleprompter.tracking` tunes follow-mode recovery: `farJumpLines`,
  `offScriptMs`, `lostMs`, and `minConfidence`
- `teleprompter.window` is the presenter-window selector used to bind the
  teleprompter window; required when any layout or slide uses `overlays` for
  `Presenter`
- `http` configures the presenter web app/status surface

Window selectors contain:

- `app` — required app name
- `titleIncludes` — optional substring to disambiguate multiple windows during
  bootstrap resolution

At runtime, presenter observers may report `pid`, `macWindowId`, and
`strict: true` back to Deckhand; those fields are runtime state, not part of
committed config. Deckhand uses the bootstrap selectors to seed OBS
`window_capture` settings, then upgrades them in place to exact managed
bindings when runtime window handles are available. The teleprompter window is
not an OBS source; its selector is used only for the local presenter
window-management path.

`presenter.stt` fields:

- `whisperBin` — absolute path to `whisper-stream`
- `model` — absolute path to the local ggml model file
- `mode` — `step` or `vad`; default `step`
- `captureId` — microphone capture device id passed to `whisper-stream`;
  default `-1`
- `stepMs` — decode cadence in milliseconds; default `1000`
- `lengthMs` — audio window length in milliseconds; default `4000`; must be
  greater than or equal to `stepMs`
- `keepMs` — overlap retained between step windows; default `250`; must be less
  than or equal to `stepMs`
- `threads` — decode threads; default `4`
- `audioCtx` — whisper audio context size; default `0`
- `beamSize` — whisper beam search size; default `-1` for greedy/default
- `keepContext` — keep decoder prompt context between step windows; default
  `false`
- `noFallback` — disable temperature fallback; default `true`
- `useGpu` — enable GPU inference when available; default `true`
- `flashAttn` — enable flash attention when supported; default `true`
- `language` — optional explicit whisper language
- `vadThreshold` — optional VAD speech threshold from `0` to `1`
- `freqThreshold` — optional high-pass cutoff threshold in Hz; must be
  non-negative

Tuning guidance:

- `step` mode is the default for teleprompter follow mode because it produces a
  steady transcript cadence.
- The defaults (`stepMs: 1000`, `lengthMs: 4000`) favor teleprompter
  responsiveness: a shorter step means fresher transcripts reach follow mode
  sooner, and the shorter window keeps the decoder from lagging well behind
  live speech. The coordinator derives a prediction lead of
  `max(stepMs * 3, 3000)` so the teleprompter can bridge the gap between
  transcript updates rather than snapping forward only when each update lands.
- Raise `lengthMs` only if phrases are getting chopped too aggressively; keep it
  as close to `stepMs` as your decoder tolerates so windows stay fresh.
- Increase `keepMs` modestly to preserve word boundaries between windows.
- Use `vad` mode when you prefer speech-burst transcription and can tolerate
  less frequent updates.

## Slide ID scheme

For the `reveal.js` driver:

- canonical ID source is `data-deckhand-id`
- fallback is `indexh.indexv`
- fallback always includes `.0` for horizontal-only slides
- raw indices are still carried in `meta` for logs and debugging

## Validation

The config loader returns path-based errors for invalid input, including:

- missing or invalid `driver.type`
- missing or empty `sources`
- unknown source `kind`
- `app` sources with invalid `command`/`args`/`cwd`/`files`/`openArgs`/`app`
  fields, or `openArgs` combined with `args` or `files`
- `app` source `files` paths that do not exist on disk at load time
- missing `layouts`
- unknown `slides.<id>.layout`
- layout slots that reference unknown sources
- invalid slot positions
- `navigate`/`browser` actions that reference unknown sources, tabs, or
  non-browser-capable sources
- invalid `focus` source for the chosen layout
- invalid overlay source or overlay shape
- legacy `presenter.stt.chunkSeconds`; use `mode`/`stepMs`/`lengthMs`/`keepMs`
- `presenter.windows` entries that reference unknown sources
- missing `presenter.teleprompter.window` when overlays are configured
- malformed browser action selectors or URLs
- browser sources that omit a tab catalog
- browser catalogs with zero or multiple initial tabs
- invalid presenter stage dimensions
- malformed window selectors
- relative STT paths

## Sample artifacts

- `presentation/example/config.json` — presenter-capable sample
- `presentation/<name>/config.local.json` — local-only override, ignored by git

Committed sample artifacts use placeholders only. Do not commit real OBS
passwords, machine-specific model paths, or personal window-title selectors.
