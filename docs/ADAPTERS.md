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

## Target Contract

Targets are command sinks.

Shared descriptor shape used in the package:

```js
{
  name: 'browser-tab',
  kind: 'target',
  capabilities: ['navigate']
}
```

Expected runtime behavior:

- register with the hub as `role: "target"`
- provide `controllerId` and optional `tabId`
- advertise capabilities such as `navigate`
- receive generic `command` messages

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

- extend target behavior via new `command.type` values
- extend observer behavior via new subscription channels
- keep top-level message types generic
- keep app-specific metadata inside adapter-local code or `meta`

## Current Built-Ins

- driver: `reveal.js`
- target: browser tab userscript
- observers: presenter web app, Hammerspoon integration, whisper.cpp STT runner

## v1 Limits

- no dynamic package discovery
- no remote authentication beyond localhost assumptions
- no built-in non-browser target types yet
- presenter integrations are macOS-only for v1
