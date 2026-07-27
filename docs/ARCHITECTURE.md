# Architecture

## Model

Deckhand has five runtime boundaries:

- coordinator
- OBS adapter
- driver client boundary
- target client boundary
- observer client boundary

Observer clients power presenter mode. Current observer implementations are:

- presenter web app
- Hammerspoon presenter controller
- local whisper.cpp STT runner

The coordinator owns the declarative presentation model. Platform-specific
presenter behavior lives outside the coordinator.

## Source Of Truth

The `layouts` catalog is the single source of truth for:

- audience OBS scene names
- logical source placement
- presenter-stage rectangles

Slides reference layouts by stable `layout` IDs rather than hardcoding scene
names directly.

## Flow

1. Driver reports a normalized `positionChanged` event.
2. Coordinator resolves that slide into a full `presentationState` payload.
3. Coordinator increments a monotonic `seq` and stores that payload as sticky
   state.
4. Hub publishes `presentationState` to subscribed observers.
5. Coordinator switches OBS to `presentationState.audienceScene`.
6. Coordinator dispatches generic target commands.

Each step is isolated so OBS failures, observer failures, or target failures do
not suppress the other work.

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
    Slide: { app: 'Safari', titleIncludes: 'Deckhand Deck' }
  },
  focus: 'Terminal',
  script: 'Walk through the init flow.\nEmphasize line 42.'
}
```

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
- `target`
- `observer`

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
3. hotkeys start
4. presenter HTTP start, when presenter mode is enabled

Shutdown order:

1. presenter HTTP stop
2. hotkeys stop
3. hub stop
4. OBS disconnect

## Driver, Target, And Observer Boundaries

Driver responsibilities:

- emit normalized position events
- accept `next`, `prev`, and optional `goTo(id)` commands

Target responsibilities:

- register identity and capabilities
- accept generic commands, starting with `navigate`

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
- target command failures are logged and the coordinator keeps running
- observer publish failures are logged and do not suppress OBS or target work
- malformed hub messages return protocol errors instead of crashing the server

## Extensibility Notes

- command routing is based on `command.type`
- observer traffic is channel-based and subscription-filtered
- shared modules do not import browser userscript code
- shared modules do not import `reveal.js` bridge code
- shared modules do not import macOS Hammerspoon code
