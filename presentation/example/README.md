# Example

This example demonstrates the full Deckhand flow:

- layout-driven OBS audience scenes
- presenter script updates
- per-slide focus hints
- Deckhand-owned Chrome windows and tabs with preloaded, switchable tabs

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

Serve the deck:

```bash
npm run presentation:serve -- example
```

Run Deckhand:

```bash
npm start example
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
npm run setup:obs -- example
npm run setup:obs -- --check example
```

If you want OBS canvas alignment to match the configured presenter stage:

```bash
npm run setup:obs -- --set-canvas example
```

## Presenter Add-Ons

- Hammerspoon uses the `presentationState` observer channel to move/focus
  windows.
- `npm run presenter:smoke -- example` verifies the local presenter HTTP and hub
  surfaces after startup.
- `npm run presenter:stt -- example` starts the whisper observer.
- `npm run presenter:doctor -- example` checks the local presenter environment.

Note: `presentation/example/config.json` intentionally keeps placeholder STT
paths and an empty OBS password. Put your real OBS password, window selectors,
and optional STT settings in `presentation/<your-presentation-name>/config.local.json`
before expecting `npm start <your-presentation-name>` or STT checks to pass
against your live setup.

See `../../docs/SETUP.md` for the full macOS walkthrough.
