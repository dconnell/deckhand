# Config

## Shape

Each presentation lives under `presentation/<name>/` and uses one layout-driven
model for OBS, presenter stage, and slide actions.

- `presentation/<name>/config.json`: tracked shareable presentation config
- `presentation/<name>/config.local.json`: optional untracked local override for
  secrets and machine-specific values

```json
{
  "driver": { "type": "revealjs" },
  "obs": { "url": "ws://127.0.0.1:4455", "password": "" },
  "hub": { "port": 8765 },
  "hotkeys": { "next": "F13", "prev": "F14" },
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
    "Terminal": { "kind": "terminal" },
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
      "slots": [{ "source": "Slide", "position": "full" }]
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
      "browser": [
        { "source": "BrowserA", "action": "activateTab", "tab": "checkout" },
        { "source": "BrowserB", "action": "navigate", "tab": "main", "url": "https://example.com/demo/v2" }
      ]
    }
  },
  "chrome": {
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
      "followEnabledByDefault": true
    },
    "http": {
      "host": "127.0.0.1",
      "port": 3001
    }
  }
}
```

## Core Fields

- `driver.type`: currently `revealjs`
- `obs.url`: OBS WebSocket URL
- `obs.password`: OBS WebSocket password
- `hub.port`: localhost WebSocket port for driver and observer clients
- `hotkeys.next` / `hotkeys.prev`: key names understood by `uiohook-napi`

## Sources

`sources` is the authoritative catalog of logical source IDs. Layouts, slide
actions, and presenter bindings all reference IDs declared here.

The canonical presentation sources are:

- `Slide`
- `Terminal`
- `BrowserA`
- `BrowserB`

Each entry declares a `kind`. Current kinds:

- `browser`: a source Deckhand owns end-to-end through its own Chrome session
- `terminal`: terminal source

Source IDs are position-agnostic and stay stable across layouts. They do not
encode OBS scene names, transport identifiers, or window-match hints. If you
need two live browser windows, declare two browser sources such as `BrowserA`
and `BrowserB`.

### Browser Sources

A `browser` source must declare a `browser` catalog with a `tabs` map. Deckhand
creates one Chrome window per browser source and preloads the declared tabs into
that window at startup. Identity is a runtime handle owned by Deckhand, never
URL or title lookup.

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

- `window.label`: optional label carried in the runtime registry (future
  window-capture binding detail)
- `tabs`: non-empty map of source-local tab aliases to tab descriptors
- each tab descriptor takes:
  - `url`: absolute `http` or `https` URL
  - `initial`: optional boolean; exactly one tab (or none, defaulting to the
    first declared) is the active tab at startup
  - `preload`: optional boolean (default `true`); when `false` the tab is not
    created until a slide action references it

## Chrome Session

The optional top-level `chrome` section customizes the dedicated Chrome process
Deckhand launches for browser sources:

- `executablePath`: absolute path to a Chrome or Chromium binary
- `profileDir`: absolute path to a dedicated user-data directory (defaults to a
  presentation-scoped directory under the system temp dir)
- `debugPort`: remote debugging port (a random port in 9222-9322 by default)
- `extraArgs`: array of extra Chrome command-line arguments

Deckhand only ever controls windows and tabs it created in this session; the
operator's ordinary Chrome usage is left untouched.

## Layouts

`layouts` is the source of truth for audience scene names and logical source
placement.

Each layout contains:

- `audienceScene`: OBS scene name
- `slots`: array of logical window positions

Each slot contains:

- `source`: logical source ID declared in `sources`
- `position`: `full`, `left`, or `right`

Rules:

- each layout must define at least one slot
- slot source names must be unique within a layout
- every slot source must exist in `sources`
- `audienceScene` should be unique across layouts

## Slides

Each slide entry supports:

- `layout`: required layout ID
- `focus`: optional logical source to focus after presenter layout is applied
- `script`: optional teleprompter text; absent means clear the presenter script
- `browser`: optional array of browser actions executed against Deckhand-owned
  tabs

Each `browser` action contains:

- `source`: browser-capable source ID declared in `sources`
- `action`: `activateTab` or `navigate`
- `tab`: source-local tab alias declared in the source's `browser.tabs`
- `url`: required when `action` is `navigate`; absolute `http` or `https` URL

`activateTab` switches to a preloaded tab by its runtime handle without
reloading it. `navigate` loads a new URL in the named tab.

## Presenter

`presenter` is optional as a whole. If omitted, Deckhand still supports the
audience-only flow.

When present:

- `platform` must be `macos`
- `stage` defines the presenter-stage rectangle; width must be even
- `windows` maps each logical source to a macOS window selector; every key must
  exist in `sources`
- `stt` configures the local whisper.cpp observer
- `teleprompter.followEnabledByDefault` controls initial follow mode
- `http` configures the presenter web app/status surface

Window selectors contain:

- `app`: required app name
- `titleIncludes`: optional substring to disambiguate multiple windows

## Slide ID Scheme

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
- missing `layouts`
- unknown `slides.<id>.layout`
- layout slots that reference unknown sources
- invalid slot positions
- `navigate`/`browser` actions that reference unknown sources, tabs, or
  non-browser-capable sources
- invalid `focus` source for the chosen layout
- `presenter.windows` entries that reference unknown sources
- malformed browser action selectors or URLs
- browser sources that omit a tab catalog
- browser catalogs with zero or multiple initial tabs
- invalid presenter stage dimensions
- malformed window selectors
- relative STT paths

## Sample Artifacts

- `presentation/example/config.json`: presenter-capable sample
- `presentation/<name>/config.local.json`: local-only override, ignored by git

Committed sample artifacts use placeholders only. Do not commit real OBS
passwords, machine-specific model paths, or personal window-title selectors.
