# Example Laptop

This example is a laptop-oriented variant of `presentation/example`. It is
identical except that it demonstrates per-slide **teleprompter overlays** on a
single-screen laptop where the presenter teleprompter has nowhere to live.

- layout-driven OBS audience scenes
- presenter script updates
- per-slide focus hints
- Deckhand-owned Chrome windows and tabs with preloaded, switchable tabs
- **per-layout teleprompter overlays** with one per-slide override

## What's Here

- `deck/index.html`: sample `reveal.js` deck (adds a `closing` slide)
- `config.json`: presenter-capable sample config with teleprompter overlays

## Teleprompter Overlay Scheme

Each layout declares a default teleprompter rect under `overlays`, chosen to
keep the operator's interactive region clear for that scene type. The
teleprompter is presenter-only and never an OBS source, so parking it over a
stage window locally does not affect what the audience sees.

Stage is `1800 × 1168` at `(0, 0)` — sized for a 14" MacBook Pro at the "More
Space" scaled resolution (1800 × 1169), so the stage fills the screen with one
pixel to spare.

Overlays use half-height columns (height `584`, width `150`) placed in a screen
quadrant on the passive side of the scene, so they never reach the bottom edge
(where the Dock sits) and don't cover the operator's interactive region. Because
overlays are applied *after* stage focus, the teleprompter is always raised on
top of the focused stage window.

Defaults by scene type:

- `full-slide`, `full-browser`, `full-terminal`: upper right
  `{ 1650, 0, 150 × 584 }` — passive content the operator narrates over; for the
  full terminal the upper area avoids the prompt at the bottom.
- `left-terminal-right-slide`, `left-terminal-right-browser`, `dual-browser`:
  upper right `{ 1650, 0, 150 × 584 }` — over the passive/right pane, away from
  the terminal.
- `right-terminal-left-slide`, `left-browser-right-terminal`: upper left
  `{ 0, 0, 150 × 584 }` — over the passive/left pane, away from the terminal.

### Per-slide override

`full-slide` is used by two slides so you can see the default vs. the override:

- `welcome`: inherits the `full-slide` default → upper right.
- `closing`: overrides → lower left `{ 0, 584, 150 × 584 }`.

Advancing from `welcome` to `closing` moves the teleprompter from the upper
right to the lower left without disturbing the stage windows.

## Run It

Run Deckhand:

```bash
node ./src/index.js example-laptop
```

Open the deck:

```text
http://127.0.0.1:3000/presentation/example-laptop/deck/index.html
```

Open the presenter app:

```text
http://127.0.0.1:3001/presenter/
```

## OBS Setup

Create or validate the OBS scenes from the same `layouts` model:

```bash
npm run obs:setup -- example-laptop
npm run obs:setup -- --check example-laptop
```

If you want OBS canvas alignment to match the configured presenter stage:

```bash
npm run obs:setup -- --set-canvas example-laptop
```

## Presenter Add-Ons

- Hammerspoon uses the `presentationState` observer channel to move/focus
  windows and to report exact managed window bindings back to Deckhand.
- `npm run presenter:smoke -- example-laptop` verifies the local presenter HTTP
  and hub surfaces after startup.
- `npm run presenter:stt -- example-laptop` starts the whisper observer.
- `npm run presenter:doctor -- example-laptop` checks the local presenter
  environment.

Note: `presentation/example-laptop/config.json` intentionally keeps placeholder
STT paths and an empty OBS password. Put your real OBS password, window
selectors, and optional STT settings in
`presentation/<your-presentation-name>/config.local.json` before expecting
`node ./src/index.js <your-presentation-name>` or STT checks to pass against
your live setup.

See `../../docs/SETUP.md` for the full macOS walkthrough.
