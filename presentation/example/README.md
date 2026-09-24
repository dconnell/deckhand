# Example

The reference Deckhand sample. A browser-heavy live-coding talk with a single
terminal and dual browser targets, plus optional whole-frame OBS slide
transitions. If you are copying a starting point, start here.

This example demonstrates the full Deckhand flow:

- layout-driven OBS audience scenes
- presenter script updates
- per-slide focus hints
- Deckhand-owned Chrome windows and tabs with preloaded, switchable tabs

## How It Differs From The Other Examples

| Concern               | `example`                                                           | `example2`                                   | `example-laptop`                    |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------- |
| Editor (VS Code)      | not present                                                         | `Editor` source (`kind: "app"`)              | not present                         |
| Terminals             | single `Terminal` window                                            | three: `TerminalA`, `TerminalB`, `TerminalC` | single `Terminal` window            |
| Terminal cwds         | one (`/repos/demo`)                                                 | one per terminal (`app`, `infra`, `docs`)    | one (`/repos/demo`)                 |
| Browser targets       | `BrowserA` + `BrowserB` (dual)                                      | only the `Slide` deck browser                | `BrowserA` + `BrowserB` (dual)      |
| Dual-browser layout   | `dual-browser`                                                      | none                                         | `dual-browser`                      |
| Deck theme            | `black.css`                                                         | `white.css`                                  | `black.css`                         |
| Presenter overlays    | presenter-level: OBS top-left, Presenter top-right, Console beneath | none                                         | per-layout + one per-slide override |
| OBS slide transitions | configured (`Slide Right` / `Left`)                                 | not configured (instant cut)                 | configured (`Slide Right` / `Left`) |
| Intended display      | multi-monitor presenter stage                                       | multi-monitor presenter stage                | single-screen laptop                |

See [`../README.md`](../README.md) for the side-by-side index of all examples.

## What's Here

- `deck/index.html`: sample `reveal.js` deck
- `config.json`: presenter-capable sample config

## Example Flow

The sample config uses the `layouts` catalog and slide-level `layout` refs.

Highlights:

- `welcome`: full-slide layout with script
- `code-walkthrough`: split layout with terminal focus and script
- `dual-demo`: dual-browser layout using `BrowserA` and `BrowserB`

## Run It

Run Deckhand:

```bash
node ./src/index.js example
```

Open the deck:

```text
http://127.0.0.1:3000/presentation/example/deck/index.html
```

Open the presenter app:

```text
http://127.0.0.1:3001/presenter/
```

## OBS Setup

Create or validate the OBS scenes from the same `layouts` model:

```bash
npm run obs:setup -- example
npm run obs:setup -- --check example
```

If you want OBS canvas alignment to match the configured presenter stage:

```bash
npm run obs:setup -- --set-canvas example
```

## Presenter Add-Ons

- Hammerspoon uses the `presentationState` observer channel to move/focus
  windows and to report exact managed window bindings back to Deckhand.
- `npm run presenter:smoke -- example` verifies the local presenter HTTP and hub
  surfaces after startup.
- `npm run presenter:stt -- example` starts the whisper observer.
- `npm run presenter:doctor -- example` checks the local presenter environment.

Note: `presentation/example/config.json` intentionally keeps placeholder STT
paths and an empty OBS password. Put your real OBS password, window selectors,
and optional STT settings in `presentation/<your-presentation-name>/config.local.json`
before expecting `node ./src/index.js <your-presentation-name>` or STT checks to pass
against your live setup.

See `../../docs/SETUP.md` for the full macOS walkthrough.
