# Adapters

## Driver Contract

Drivers are event sources and navigation boundaries.

Shared descriptor shape used in the package:

```js
{
  name: 'revealjs',
  kind: 'driver',
  capabilities: ['next', 'prev', 'goTo']
}
```

Expected runtime behavior:

- register with the hub as `role: "driver"`
- emit normalized `positionChanged` messages
- receive generic `command` messages
- implement `next`, `prev`, and optionally `goTo`

## Browser Session (Deckhand-Owned)

Browser windows and tabs are owned directly by Deckhand through the Chrome
DevTools Protocol. There is no remote target client role anymore.

The coordinator resolves slide config into typed browser commands and dispatches
them through an injected executor. The executor maps commands onto the browser
session runtime:

- `activateTab` activates a preloaded tab by its runtime handle
- `navigate` loads a new URL in a named tab handle

Command routing never relies on page title, URL lookup, or remote identity.

## Observer Contract

Observers consume presenter-side runtime state.

Expected runtime behavior:

- register with the hub as `role: "observer"`
- declare `subscriptions` for observer channels
- receive sticky `presentationState` immediately after registration when
  subscribed
- optionally publish `transcript` messages

Current observer channels:

- `presentationState`
- `transcript`

Example observer registration:

```json
{
  "type": "register",
  "role": "observer",
  "subscriptions": ["presentationState", "transcript"]
}
```

Example observer transcript publish:

```json
{
  "type": "transcript",
  "source": "whisper",
  "text": "walk through the init flow",
  "capturedAtMs": 1720000000000
}
```

## Protocol Extension Strategy

- extend browser behavior via new `command.type` values handled by the executor
- extend observer behavior via new subscription channels
- keep top-level message types generic
- keep app-specific metadata inside adapter-local code or `meta`

## Current Built-Ins

- driver: `reveal.js`
- browser session: Deckhand-owned Chrome via CDP
- observers: presenter web app, Hammerspoon integration, whisper.cpp STT runner

## v1 Limits

- no dynamic package discovery
- no remote authentication beyond localhost assumptions
- no attach-to-existing user windows or tabs
- presenter integrations are macOS-only for v1
