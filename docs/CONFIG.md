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
      "whisperBin": "/absolute/path/to/whisper-cli",
      "model": "/absolute/path/to/ggml-base.en.bin",
      "chunkSeconds": 2.5,
      "language": "en"
    },
    "teleprompter": {
      "followEnabledByDefault": true,
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
- `obs.transitions` — optional block enabling whole-frame slide transitions;
  absent means the instant cut is used and OBS transitions are never touched.
  See [Slide Transitions](#slide-transitions).
- `hub.port` — localhost WebSocket port for driver and observer clients

## Sources

`sources` is the authoritative catalog of logical source IDs. Layouts, slide
actions, and presenter bindings all reference IDs declared here. The canonical
presentation sources are `Slide`, `Terminal`, `BrowserA`, and `BrowserB`. These
names describe what the operator is coordinating; they do not encode position,
transport, or OBS implementation details. Source IDs are position-agnostic and
stay stable across layouts — if you need two live browser windows, declare two
browser sources such as `BrowserA` and `BrowserB`.

Each entry declares a `kind`:

- `browser` — a source Deckhand owns end-to-end through its own Chrome session
- `app` — a macOS app Deckhand launches via `open -a` (an editor, iTerm2)

All non-`browser` sources are *owned* sources: Deckhand launches the window,
captures its exact macOS window id by diffing the window list before and after
launch, and binds it strictly. Identity is the runtime window handle, never the
title.

App-specific launch/close quirks live in per-app adapters under `src/apps/`.
Adding an app that misbehaves is one adapter file plus one registry line in
`src/apps/index.js`; generic apps fall through to the default adapter and need
no file. See [Architecture: Owned App Sources](ARCHITECTURE.md#owned-app-sources)
and [Adapters: App Adapters](ADAPTERS.md#app-adapters).

### Browser sources

A `browser` source declares a `browser` catalog with a `tabs` map. Deckhand
creates one Chrome window per browser source and preloads the declared tabs at
startup. Identity is a runtime handle owned by Deckhand, never URL or title
lookup.

```json
"BrowserA": {
  "kind": "browser",
  "browser": {
    "window": { "label": "browser-a" },
    "tabs": {
      "home": { "url": "https://example.com/demo/home", "initial": true },
      "checkout": { "url": "https://example.com/demo/checkout" }
    }
  }
}
```

- `window.label` — optional source label carried in the runtime registry for
  managed-window bookkeeping
- `tabs` — non-empty map of source-local tab aliases to tab descriptors
- each tab descriptor takes:
  - `url` — absolute `http` or `https` URL
  - `initial` — optional boolean; exactly one tab (or none, defaulting to the
    first declared) is the active tab at startup
  - `preload` — optional boolean that currently must remain `true`; Deckhand
    preloads every declared tab at startup

### App sources

An `app` source is a macOS app Deckhand launches via `open -a`. The new window
is captured by owner-name diff (PID-based diff is unreliable for Electron
single-instance apps such as VS Code, which hand off to an already-running
process).

At shutdown, Deckhand closes only the tracked window for each `app` source by
exact `macWindowId` (not the whole app process). If the app shows an
unsaved-changes sheet, Deckhand attempts to press Don't Save/Discard for that
tracked window so shutdown can complete without manual prompts.

#### What the app opens

An `app` source launches as `open -n -a <app>`. Three optional fields control
what follows the app name — **pick one**; `args`, `files`, and `openArgs` are
mutually exclusive:

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
- `cwd` — optional absolute working directory where relevant
- `command` — optional shell command run inside the new window (used by
  terminal apps like iTerm2; ignored by apps that don't need it)

#### iTerm2

iTerm2 is an `app` source with `app: "iTerm2"`. Deckhand creates a new iTerm2
window via AppleScript, optionally runs a shell command at a working directory,
and closes it by session UUID on shutdown (not by process kill). The `command`
field is what distinguishes iTerm2 from a generic app; it is read by the iTerm2
adapter in `src/apps/iterm2.js`.

```json
"Terminal": {
  "kind": "app",
  "app": "iTerm2",
  "command": "npm run dev",
  "cwd": "/repos/demo"
}
```

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

`obs.transitions` is optional. When present, advancing the deck runs a
freeze → resize → directional-reveal sequence instead of an instant cut: the
previous audience frame is held as a still while windows resize and tabs
navigate behind it, then the new scene slides in. When absent, Deckhand uses
the instant cut and never touches OBS transitions. See
[SETUP.md: Whole-frame slide transitions](SETUP.md#whole-frame-slide-transitions-optional)
for the one-time OBS setup.

```json
"obs": {
  "transitions": {
    "forward": "Slide Left",
    "backward": "Slide Right"
  }
}
```

Required:

- `forward` — OBS Slide transition name used for `next`/forward moves
- `backward` — OBS Slide transition name used for `prev`/backward moves

Optional (with defaults):

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

Behavior notes:

- Every slide advance runs the sequence when this block is present, including
  same-scene advances, for a consistent experience.
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
  config is removed — so switching to a presentation with fewer sources prunes
  the dropped ones automatically;
- non-`Deckhand_*` entities are never modified or removed;
- freeze assets (`Deckhand_Freeze` / `Deckhand_Freeze Frame`) are retained
  while `obs.transitions` is configured and pruned when a presentation drops
  transitions.

This is stateless: there is no manifest or state directory, and the
reconciliation is driven entirely by the current config and the `Deckhand_`
prefix. Because earlier builds named OBS entities without the prefix, a
one-time manual cleanup of those old names may be needed after upgrading.

## Presenter

`presenter` is optional as a whole. If omitted, Deckhand still supports the
audience-only flow. When present:

- `platform` must be `macos`
- `stage` defines the presenter-stage rectangle; width must be even
- `windows` maps logical sources to macOS window selectors; every key must
  exist in `sources`. A selector is optional for owned source kinds
  (`browser`, `app`): their owner name is derived from the source descriptor
  and their exact `macWindowId` is resolved at launch, so `titleIncludes` is
  not required
- `stt` configures the local whisper.cpp observer
- `teleprompter.followEnabledByDefault` controls initial follow mode
- `teleprompter.window` is the presenter-window selector used to bind the
  teleprompter window; required when any layout or slide uses `overlays` for
  `Presenter`
- `http` configures the presenter web app/status surface

Window selectors contain:

- `app` — required app name
- `titleIncludes` — optional substring to disambiguate multiple windows during
  bootstrap resolution

At runtime, presenter observers may upgrade these bootstrap selectors to exact
session bindings by reporting `pid`, `macWindowId`, and `strict: true` back to
Deckhand. Those exact fields are runtime state, not part of committed config.
Deckhand uses the bootstrap selectors to seed OBS `window_capture` settings,
then upgrades them in place to exact managed bindings when runtime window
handles are available. The teleprompter window is not an OBS source; its
selector is used only for the local presenter window-management path.

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
