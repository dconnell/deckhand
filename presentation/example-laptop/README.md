# Example Laptop

This example is a laptop-oriented variant of `presentation/example`. It shares
the browser/terminal flow of `example` and adds two things `example` does not
cover:

- a **generic `app` source** — Preview launched on a bundled photograph, to show
  the captured-window path (no tab or navigation control, unlike a browser
  source)
- **per-layout teleprompter overlays** on a single-screen laptop where the
  presenter teleprompter has nowhere to live, with one per-slide override

- layout-driven OBS audience scenes
- presenter script updates
- per-slide focus hints
- Deckhand-owned Chrome windows and tabs with preloaded, switchable tabs
- a Deckhand-launched Preview window showing a photo (`Photo` app source)
- **per-layout teleprompter overlays** with one per-slide override

## What's Here

- `deck/index.html`: sample `reveal.js` deck (adds a `closing` slide)
- `pexels-marin-tulard-1632272-9931969.jpg`: the photograph opened by the
  `Photo` (Preview) source
- `config.json`: presenter-capable sample config with teleprompter overlays and
  a Preview app source

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
- `right-terminal-left-slide`, `left-browser-right-terminal`,
  `left-slide-right-photo`: upper left `{ 0, 0, 150 × 584 }` — over the
  passive/left pane, away from the terminal or photo.

### Per-slide override

`full-slide` is used by two slides so you can see the default vs. the override:

- `welcome`: inherits the `full-slide` default → upper right.
- `closing`: overrides → lower left `{ 0, 584, 150 × 584 }`.

Advancing from `welcome` to `closing` moves the teleprompter from the upper
right to the lower left without disturbing the stage windows.

### Photo source

The `photo-split` slide uses the `left-slide-right-photo` layout: slide on the
left, the bundled photograph on the right via a `Photo` source of `kind: "app"`
launched as Preview. This is the generic captured-window path — unlike a
`browser` source, Deckhand launches the window and captures it but does not
manage tabs or navigation.

`Photo.files` is a path relative to the presentation directory
(`pexels-marin-tulard-1632272-9931969.jpg`, shipped alongside `config.json`),
resolved at config-load time, so the example opens the image out of the box.
Absolute paths are also accepted.

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
