# Example 2

A second Deckhand sample that intentionally differs from [`../example`](../example)
in sources and slide layouts. Where `example` is browser-heavy, this one is an
editor + multi-terminal flow.

## How It Differs From `example`

| Concern            | `example`                         | `example2`                                  |
| ------------------ | --------------------------------- | ------------------------------------------- |
| Editor (VS Code)   | not present                       | `Editor` source (`kind: "app"`)             |
| Terminals          | single `Terminal` window          | three: `TerminalA`, `TerminalB`, `TerminalC` |
| Terminal cwds      | one (`/repos/demo`)               | one per terminal (`app`, `infra`, `docs`)   |
| Browser targets    | `BrowserA` + `BrowserB` (dual)    | only the `Slide` deck browser               |
| Dual-browser layout| `dual-browser`                    | none                                        |
| Deck theme         | `black.css`                       | `white.css`                                 |

Each terminal has its own full-screen layout (`full-terminal-a/b/c`), so any one
of them can take the whole audience frame.

## What's Here

- `deck/index.html`: sample `reveal.js` deck
- `config.json`: presenter-capable sample config
- `config.local.json`: git-ignored local override template

## Sources

- `Slide` — the reveal.js deck (Deckhand-owned Chrome)
- `Editor` — Visual Studio Code, opened via `kind: "app"`
- `TerminalA` — iTerm2, cwd `/repos/example2/app`
- `TerminalB` — iTerm2, cwd `/repos/example2/infra`
- `TerminalC` — iTerm2, cwd `/repos/example2/docs`

## Example Flow

Highlights:

- `welcome`: full-slide layout with script
- `editor-walkthrough`: full-editor layout with editor focus
- `terminal-*-deep-dive`: one full-screen terminal per working directory
- `dual-terminal`: two owned terminals side by side, each from its own cwd

## Run It

Run Deckhand:

```bash
node ./src/index.js example2
```

Open the deck:

```text
http://127.0.0.1:3000/presentation/example2/deck/index.html
```

Open the presenter app:

```text
http://127.0.0.1:3001/presenter/
```

## OBS Setup

Create or validate the OBS scenes from the same `layouts` model:

```bash
npm run setup:obs -- example2
npm run setup:obs -- --check example2
```

If you want OBS canvas alignment to match the configured presenter stage:

```bash
npm run setup:obs -- --set-canvas example2
```

## Presenter Add-Ons

- Hammerspoon uses the `presentationState` observer channel to move/focus
  windows and to report exact managed window bindings back to Deckhand.
- `npm run presenter:smoke -- example2` verifies the local presenter HTTP and
  hub surfaces after startup.
- `npm run presenter:doctor -- example2` checks the local presenter environment.

Note: `presentation/example2/config.json` intentionally keeps placeholder STT
paths and an empty OBS password. Put your real OBS password, window selectors,
and optional STT settings in `presentation/example2/config.local.json`
before expecting `node ./src/index.js example2` or STT checks to pass against
your live setup.

See `../../docs/SETUP.md` for the full macOS walkthrough.
