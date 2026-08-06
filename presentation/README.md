# Presentations

Each presentation lives in its own self-contained directory under here. The
shipped samples demonstrate different Deckhand capabilities and are intended as
copy-and-edit starting points.

## Samples

| Directory           | Best for                         | What it demonstrates                                                          |
| ------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| [`example/`](example/)                 | reference starting point | Browser-heavy live-coding talk: dual browser targets, single terminal, OBS slide transitions. |
| [`example2/`](example2/)               | editor + multi-terminal  | VS Code via `kind: "app"`, three owned iTerm2 terminals with per-terminal cwds, editor/terminal layouts. |
| [`example-laptop/`](example-laptop/)   | single-screen laptop     | Same flow as `example` plus per-layout teleprompter overlays with one per-slide override. |

## Choosing A Starting Point

- **Default to [`example/`](example/).** It is the most general baseline and
  the one used by the top-level README's Quick Start.
- Pick **[`example2/`](example2/)** if your talk is editor- and terminal-driven
  with no live browser component.
- Pick **[`example-laptop/`](example-laptop/)** if you present on a single
  laptop screen with no external monitor and need the teleprompter to coexist
  with stage windows.

## Creating Your Own

```bash
cp -R presentation/example presentation/my-talk
```

Each presentation directory holds:

- `deck/index.html`: the `reveal.js` deck
- `config.json`: tracked, shareable presentation config
- `config.local.json`: optional untracked local override for secrets and
  machine-specific values (deep-merged on top of `config.json`)

See [`../docs/CONFIG.md`](../docs/CONFIG.md) for the full config schema and
[`../docs/SETUP.md`](../docs/SETUP.md) for the end-to-end macOS walkthrough.
