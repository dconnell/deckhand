# Deckhand

Deckhand is a **macOS-only** local presentation coordinator for remote talks.
It mixes slides, a live terminal, VS Code, or other apps and switches between
them — including split views — so the audience sees a single composed OBS feed
shared into the meeting (via OBS's Projector window and Zoom's Share Screen).
The operator never exposes their whole desktop.

## What Deckhand keeps in sync

- **Slide position** — from a deck driver (currently `reveal.js`)
- **OBS audience scenes** — switched per slide
- **Presenter-side state** — macOS window layout, focus, teleprompter, optional
  speech-to-text
- **Deckhand-owned Chrome windows and tabs** — activation and navigation, plus
  owned apps it launches (iTerm2, VS Code, and other `open -a` apps)

Browser and terminal sources are reliable. Generic `app` sources are
best-effort: Deckhand launches the window and closes only that window on
shutdown, but app-specific behavior (unsaved-changes sheets, single-instance
handoffs) can break clean launch or close for untested apps. Apps that need
custom logic live in `src/apps/` — one adapter file plus one registry line.
See [Architecture](docs/ARCHITECTURE.md#owned-app-sources) and
[Adapters](docs/ADAPTERS.md#app-adapters).

## Documentation

| Document | Covers |
| --- | --- |
| [Setup](docs/SETUP.md) | Prerequisites, creating a presentation, running a talk |
| [Config](docs/CONFIG.md) | Full `config.json` / `config.local.json` schema |
| [Architecture](docs/ARCHITECTURE.md) | Components, data flow, runtime boundaries |
| [Adapters](docs/ADAPTERS.md) | Contracts for drivers, observers, browser commands, app adapters |
| [Runbook](docs/RUNBOOK.md) | The literal five-minute pre-talk checklist |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Known issues and recovery steps |

## Project layout

- `src/` — coordinator, config, hub, OBS, presenter HTTP, browser session, app
  runtime
- `presentation/` — self-contained presentations; see
  [`presentation/README.md`](presentation/README.md)
- `presenter-web/` — presenter web app served at `/presenter/`
- `hammerspoon/` — macOS window-layout integration
- `reveal/` — `reveal.js` driver bridge
- `docs/` — the documents above
- `test/` — unit and integration tests

The `src/apps/` and `src/launchers/` directories are split by responsibility:
`launchers/` holds generic launch primitives (`open -a` spawning, iTerm2
AppleScript); `apps/` holds per-app adapters that map config onto those
primitives and encode each app's quirks. See
[Architecture: Owned App Sources](docs/ARCHITECTURE.md#owned-app-sources).

## Verification status

- `npm test` — unit and integration suite
- `npm run obs:setup -- <name>` — builds OBS scenes from a presentation config
- `node ./src/index.js <name>` — starts the full managed runtime
- `npm run presenter:doctor -- <name>` — validates local config and environment

Real OBS output, Hammerspoon Accessibility, microphone permission, and
whisper.cpp still require manual smoke testing.
