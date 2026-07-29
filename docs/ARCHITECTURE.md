# Architecture

## Model

Deckhand has these runtime boundaries:

- coordinator
- OBS adapter
- driver client boundary
- browser session runtime (CDP-owned Chrome windows and tabs)
- observer client boundary

Observer clients power presenter mode. Current observer implementations are:

- presenter web app
- Hammerspoon presenter controller
- local whisper.cpp STT runner

The coordinator owns the declarative presentation model. Platform-specific
presenter behavior lives outside the coordinator.

## Source Of Truth

The `sources` catalog is the authoritative registry of logical source IDs.
Layouts, slide actions, and presenter bindings all build on that catalog.

The canonical presentation sources are:

- `Slide`
- `Terminal`
- `BrowserA`
- `BrowserB`

These names describe what the operator is coordinating in the talk. They do not
encode position, runtime transport, or OBS implementation details.

Browser sources declare a catalog of named tabs. Deckhand launches one dedicated
Chrome session, creates one window per browser source, and preloads the declared
tabs. Window and tab identity are runtime handles owned by Deckhand, never URL
or title lookup.

The `layouts` catalog builds on `sources` and is the single source of truth for:

- audience OBS scene names
- logical source placement
- presenter-stage rectangles

Slides reference layouts by stable `layout` IDs rather than hardcoding scene
names directly. Browser-oriented slide actions target logical `source` IDs and
source-local tab aliases.

## Flow

1. Driver reports a normalized `positionChanged` event.
2. Coordinator resolves that slide into a full `presentationState` payload.
3. Coordinator increments a monotonic `seq` and stores that payload as sticky
   state.
4. Hub publishes `presentationState` to subscribed observers.
5. Coordinator switches OBS to `presentationState.audienceScene`.
6. Coordinator dispatches typed browser commands (activateTab / navigate) through
   the injected executor, which routes them to the Deckhand-owned browser
   session by runtime handle.

Each step is isolated so OBS failures, observer failures, or browser-session
failures do not suppress the other work.

Normalized driver event shape:

```js
{
  id: 'demo-step-1',
  index: { h: 5, v: 0 },
  meta: { indexh: 5, indexv: 0, idSource: 'data-deckhand-id' }
}
```

Presenter-state payload shape:

```js
{
  type: 'presentationState',
  seq: 17,
  slideId: 'code-walkthrough',
  layoutId: 'left-terminal-right-slide',
  audienceScene: 'Left Terminal Right Slide',
  slots: [
    { source: 'Terminal', position: 'left', rect: { x: 0, y: 0, w: 900, h: 1168 } },
    { source: 'Slide', position: 'right', rect: { x: 900, y: 0, w: 900, h: 1168 } }
  ],
  windowBindings: {
    Terminal: { app: 'iTerm2' },
    Slide: {
      app: 'Google Chrome',
      titleIncludes: 'Deckhand Deck',
      pid: 47213,
      macWindowId: 12345,
      strict: true
    }
  },
  focus: 'Terminal',
  script: 'Walk through the init flow.\nEmphasize line 42.'
}
```

`windowBindings` may begin as bootstrap app/title selectors and then be
republished with exact runtime bindings once a presenter observer resolves the
managed windows.

## Hub Protocol

The local hub binds to localhost only and carries a small JSON protocol.

Messages used in the current design:

- `register`
- `registered`
- `positionChanged`
- `command`
- `presentationState`
- `transcript`
- `error`

Roles are generic:

- `driver`
- `observer`

The earlier `target` role has been removed. Browser windows and tabs are now
owned directly by Deckhand through the Chrome DevTools Protocol; command routing
no longer depends on remote target clients.

Observer registrations include subscriptions, such as:

```json
{
  "type": "register",
  "role": "observer",
  "subscriptions": ["presentationState", "transcript"]
}
```

Sticky behavior:

- the latest `presentationState` is retained
- late-joining observers immediately receive that sticky state on register
- transcripts are relayed live only and are not sticky

## Lifecycle

Startup order:

1. OBS connect
2. hub start
3. browser session start (launches Chrome, creates source windows, preloads tabs)
4. hotkeys start
5. presenter HTTP start, when presenter mode is enabled

Shutdown order:

1. presenter HTTP stop
2. hotkeys stop
3. browser session stop
4. hub stop
5. OBS disconnect

## Driver, Browser Session, And Observer Boundaries

Driver responsibilities:

- emit normalized position events
- accept `next`, `prev`, and optional `goTo(id)` commands

Browser session responsibilities:

- launch and own the dedicated Deckhand Chrome session
- create one window per browser source and preload declared tabs
- maintain the authoritative source/tab runtime-handle registry
- resolve `activateTab` and `navigate` commands to runtime handles, never URL or
  title lookup

Observer responsibilities:

- subscribe to one or more observer channels
- consume sticky `presentationState` safely
- optionally publish `transcript` events

## Presenter Surfaces

- `/presenter/`: first-class presenter web app
- `/status.json`: operator-facing runtime status snapshot
- `hammerspoon/`: macOS window management integration
- `src/presenter/stt/`: local STT runner

## Error Handling

- unknown slides warn and do nothing
- OBS errors are logged and do not crash the coordinator
- browser command failures are logged and the coordinator keeps running
- observer publish failures are logged and do not suppress OBS or browser work
- malformed hub messages return protocol errors instead of crashing the server

## Extensibility Notes

- browser command routing is based on `command.type` (`activateTab`, `navigate`)
- the coordinator dispatches through an injected executor seam so new command
  types stay decoupled from slide-event orchestration
- observer traffic is channel-based and subscription-filtered
- shared modules do not import `reveal.js` bridge code
- shared modules do not import macOS Hammerspoon code
