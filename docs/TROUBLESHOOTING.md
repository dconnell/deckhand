# Troubleshooting

Operator-facing known issues and recovery steps for the failure modes that
matter at runtime. This is the single home for troubleshooting — for the
literal pre-talk checklist, see [RUNBOOK.md](RUNBOOK.md).

The scope here is issues whose cause is **outside** Deckhand: macOS permission
resets, Chrome profile locks, Hammerspoon revocation, and the cases where
Deckhand's own automation cannot recover (OBS WebSocket drops, Chrome exits,
tab crashes).

## Quick reference: what is automatic and what is not

| Failure | Deckhand auto-recovers? | Operator action |
| --- | --- | --- |
| OBS WebSocket drops mid-session | No | restart Deckhand |
| OBS `Failed to create the scene item` | Yes, one-time reset + retry | if it recurs, re-run `obs:setup` |
| OBS `CreateInput ... already exists` | Yes, 5×100ms retries | none |
| macOS Screen Recording revoked from OBS | No | re-grant, restart OBS |
| Hammerspoon Accessibility revoked mid-talk | No, but next slide recovers | re-grant, reload Hammerspoon |
| Chrome dies or CDP socket closes mid-session | No | restart Deckhand |
| Browser tab crashes or window closed manually | No | restart Deckhand |
| Chrome profile seed fails because Chrome holds a lock | No | quit Chrome, retry |
| Hub restarts | Yes, Hammerspoon reconnects in ~1s | none |
| Driver not connected, hotkey pressed | No (hub replies `driver_unavailable`) | open or refresh the deck tab |

Deckhand does not detect any of: macOS Screen Recording / TCC state, OBS
WebSocket drops after connect, Chrome process death mid-session, tab crashes,
or Hammerspoon Accessibility state. `/status.json` reflects what Deckhand's
internal flags last saw, which can be stale after a silent drop.

## OBS

### OBS WebSocket dropped mid-session

Deckhand makes a single connection attempt at startup and does **not** watch
`ConnectionClosed` or `ConnectionError` from `obs-websocket-js`. After a silent
drop the internal `connected` flag stays `true`, the next OBS call throws a
transport error and is logged as `Failed to switch OBS scene` /
`Failed to apply OBS input settings` / similar, and the slide change continues
without the OBS side landing.

`/status.json` keeps reporting `obs.connected: true` after a drop because
nothing flips the flag. Treat that field as "connected at least once," not
"connected right now."

**Recovery**: stop Deckhand (`Ctrl+C`) and start it again. There is no
in-process recovery.

### `Failed to create the scene item` during reconcile

This is the one OBS error Deckhand recovers from. When OBS returns code `700`
or a message matching `failed to create the scene item` during `obs:setup` or
at runtime startup, Deckhand:

1. removes every `Deckhand_*` scene and input,
2. polls up to 20 × 250ms until the inputs are gone (renaming stragglers to
   `<name>__orphan_<timestamp>_<index>` if OBS refuses),
3. retries the reconcile exactly once.

If the second attempt also fails with the same error, the error is re-thrown.
At that point the manual recovery is:

```bash
# in OBS UI: remove any leftover Deckhand_* scenes and inputs, then
npm run obs:setup -- my-talk
```

### macOS update revoked OBS Screen Recording permission

macOS major updates (and some minor ones) routinely reset TCC permissions for
apps that capture the screen. The symptom is unique to OBS:

- OBS still launches, the WebSocket is up, Deckhand's `/status.json` reports
  `obs.connected: true`,
- but every `window_capture` source renders black or shows the previous frame,
- and Deckhand logs nothing about it (Deckhand does not probe TCC state).

**Recovery**:

1. System Settings → Privacy & Security → Screen Recording.
2. Re-enable **OBS Studio**. If the toggle is already on, toggle it off and
   back on — macOS sometimes shows a stale "on" state after an update.
3. Quit and reopen OBS (a restart is required for OBS to pick up the new TCC
   entry).
4. Confirm in OBS that a `window_capture` source shows live content, then
   restart Deckhand.

Run this check before every talk on a macOS version you did not last test on.

### OBS password wrong / OBS not running

Both surface identically at startup: the OBS client throws, the coordinator
logs `Failed to connect to OBS`, then `Coordinator failed to start: <error>`,
and the process exits 1.

**Recovery**:

- verify OBS is running and `Tools → WebSocket Server Settings` has **Enable
  WebSocket server** checked,
- verify `obs.password` in `presentation/<name>/config.local.json`,
- restart Deckhand.

There is no retry; Deckhand only attempts the WebSocket once at startup.

### macOS window id changes after window recreation (runtime)

At startup the OBS reconcile applies a two-step `window: 0` then exact-id
update that forces OBS to refresh the bound target. **At runtime** that
two-step is not applied: `coordinator.applyObsWindowBindings` issues a single
`SetInputSettings` per source on every slide change. If OBS gets into a state
where the capture target is stuck on the wrong window mid-session, the only
reliable recovery is to re-run `obs:setup` or restart Deckhand.

## Zoom / Share Screen

Not Deckhand failures, but the most common "audience sees the wrong thing"
causes during a remote talk. See [SETUP.md: Sharing to the
meeting](SETUP.md#sharing-to-the-meeting) for the full setup.

### OBS program view is correct but audience sees black or stale content

The Zoom Share Screen target is wrong, or the OBS Projector window was closed
or lost fullscreen. The most common cause is pressing **Esc** while the
fullscreen Projector has focus — Esc closes it. Switch Spaces with
**Ctrl+Left-arrow** or a **three-finger swipe up** instead of Esc to leave the
Projector without closing it.

**Recovery**:

1. In OBS, confirm the Projector window is still open. If not, reopen it via
   right-click the canvas → **Projector** (in Studio Mode, project
   **Program**).
2. In Zoom, stop sharing and re-share. Select the specific **Projector window**
   (under Windows, not Screens) — sharing a display follows whichever Space is
   visible and breaks when you switch Spaces to work.

### Audience sees the feed but it looks soft or low-resolution

You are sharing via OBS Virtual Camera instead of the Projector. Virtual camera
re-encodes and caps the feed around 1080p. Switch Zoom's share target to the
Projector window.

## Chrome session

### Chrome profile seeding failures (`chrome.profileName`)

When `chrome.profileName` is set, Deckhand resolves the matching entry in
`~/Library/Application Support/Google/Chrome/Local State` (matching by
**display name**, not by directory name) and recursively copies that profile
directory into a fresh working directory under `$TMPDIR`.

The copy is a plain `cp -R` with no file-lock handling. If Chrome is currently
running with that profile, files such as `Singleton*`, `LOCK`, and LevelDB /
IndexedDB files may be unreadable, and the copy throws a raw filesystem error
(`EBUSY`, `EPERM`, `ENOENT`) wrapped by Deckhand as
`Coordinator failed to start: <message>`, then exits 1.

**Recovery**:

1. Fully quit Google Chrome (`Cmd+Q`, not just close windows). Closing only the
   profile's windows is **not** sufficient — Chrome keeps singleton handles
   alive while the process is up.
2. Restart Deckhand.

You cannot seed from a profile that has Chrome actively using it. If you need
the source profile online during the talk (e.g. for handing off to a non-talk
browser), seed the working copy once, then quit Chrome and re-open only what
you need outside the seeded profile directory.

### Named profile not found

Error messages from the resolver are specific:

| Error | Cause |
| --- | --- |
| `HOME must be set to resolve chrome.profileName` | `$HOME` is unset or empty |
| `Could not resolve Chrome profile named "<name>" from <path>` | `Local State` is missing or `profile.info_cache` is malformed |
| `Could not find Chrome profile named "<name>"` | the name does not match any `info_cache[*].name` entry |

The match is against the **visible profile name** shown in Chrome's
profile-switcher UI (e.g. `Personal`), not the on-disk directory name (e.g.
`Default` or `Profile 3`). Rename in Chrome's UI if needed.

### Could not locate Google Chrome

If Chrome is not in the default macOS locations and `chrome.executablePath` is
not set, the launcher throws:

> `Could not locate Google Chrome. Set chrome.executablePath in config or the
> DECKHAND_CHROME_PATH environment variable.`

Either set `chrome.executablePath` in `config.local.json`, or export
`DECKHAND_CHROME_PATH` before starting Deckhand. Chromium and Chrome Canary
are also accepted.

### Could not reach Chrome DevTools endpoint

After launch, Deckhand reads `<profileDir>/DevToolsActivePort` and polls
`http://127.0.0.1:<port>/json/version` for ~5 seconds (50 × 100ms). If Chrome
hasn't come up in that window, Deckhand throws:

> `Could not reach Chrome DevTools endpoint at http://127.0.0.1:<port>/json/version: <error>`

Usual causes: Chrome was killed by a background security tool mid-launch, the
`profileDir` is on a filesystem Chrome can't write to, or another process is
holding the debug port range. Address the cause and restart.

### Chrome dies, CDP socket closes, or a tab crashes mid-talk

There is **no** mid-session recovery for any of these. The browser session
flips `connected: false`, logs `Browser session disconnected unexpectedly`,
rejects all pending CDP calls with `CDP transport closed`, and from then on
every subsequent `activateTab` / `navigate` is a no-op that throws.

`/status.json` shows `browserSession.connected: false` with the last-known
source map; reopening tabs is not supported.

**Recovery**: stop Deckhand and start it again. Deckhand relaunches Chrome,
rebuilds the windows, and preloads the declared tabs from scratch.

### Operator accidentally closes a Deckhand Chrome window

Same answer as above: Deckhand does not detect manual window closure and does
not reopen it. If you close a managed window mid-talk, restart Deckhand to get
the source back.

To defuse this risk before a talk: hide Chrome from the Dock and Cmd-Tab chain
by running it in its own Space, or simply keep the managed Chrome windows away
from your normal browser Space.

### Custom `chrome.profileDir` and shutdown sweeps

On shutdown Deckhand kills the Chrome process group by PID and also runs two
belt-and-braces sweeps:

```bash
pkill -9 -f "deckhand-chrome-profiles"
pkill -9 -f "deckhand-profile-"
```

These match the default temp-dir naming. If you override `chrome.profileDir`
to a path that does **not** contain either of those substrings and the spawn
failed to return a PID (`chromePid = -1`), a leaked Deckhand Chrome may
survive shutdown. Either keep the default naming, or always confirm
`chromePid` in `/status.json` is a real PID before relying on shutdown to
clean up.

Never point `chrome.profileDir` at your real Chrome user-data directory. It
would break Deckhand's isolation guarantees at launch.

## Hammerspoon

Hammerspoon owns the macOS work Deckhand cannot do itself: window resize,
focus, raise, minimize, and the global slide hotkeys. None of that is validated
by `presenter:doctor` or `presenter:smoke` — passing both does not mean
Hammerspoon is healthy.

### Hammerspoon Accessibility revoked mid-talk

This is the failure mode most worth rehearsing, because it is silent and the
symptoms are misleading.

When macOS revokes Accessibility from Hammerspoon while Deckhand is running:

- **The slide hotkeys still fire.** `hs.hotkey.bind` uses Carbon's
  `RegisterEventHotKey`, which does not need Accessibility. The websocket
  message still reaches the hub.
- **The deck still advances, OBS scenes still switch, browser tabs still
  navigate.** All of that is driven Deckhand-side.
- **Window resize / focus / raise silently stops working.** `apply_state.lua`
  calls into `hs.window` with no `pcall`; either the calls return `nil`
  (window not found) or they throw a Lua error that Hammerspoon swallows.
- **Deckhand logs nothing unusual.** The Deckhand-side observer registration
  is unchanged.

The only diagnostic is in the Hammerspoon console: lines like
`[deckhand:hammerspoon] Window not found for source <name>` and possibly a Lua
traceback. Open the console from the Hammerspoon menu bar icon.

**Recovery (no restart needed)**:

1. System Settings → Privacy & Security → Accessibility.
2. Re-enable **Hammerspoon**. If it appears already enabled, toggle it off and
   on (macOS sometimes shows a stale "on" state after an update or after a
   Hammerspoon binary update).
3. From the Hammerspoon menu bar icon, choose **Reload Config** (or
   `Cmd+Ctrl+R`).
4. Advance one slide to republish sticky `presentationState`. The next apply
   pass runs cleanly.

Neither Deckhand nor Hammerspoon need to be restarted for this. If the
re-grant does not take, quit and reopen Hammerspoon (which will re-grant on
next launch).

### Hammerspoon not installed, not running, or Lua missing

Deckhand-side startup does not fail. Deckhand's own
`defaultResolveMacWindowBindings` resolves browser windows itself (10 × 500ms
of CGWindowList + Accessibility-title matching), startup completes, and OBS
gets bootstrap bindings.

Symptoms:

- `Ctrl+Shift+Left/Right` do nothing (hotkeys aren't bound).
- Windows never resize or focus on slide changes.
- `/status.json` shows a normal observer count if any other observer (e.g. the
  presenter web app) is connected; you cannot tell from status alone that
  Hammerspoon is missing.

**Recovery**:

```bash
npm run hammerspoon:setup
```

Then open Hammerspoon, grant Accessibility when prompted, and reload its
config. Confirm the Deckhand log shows another observer registration after
Hammerspoon connects.

### Hotkeys fire but slides do not advance

`Ctrl+Shift+Left/Right` send a `driverCommand` over the hub. If no driver is
connected, the hub replies with a protocol error (`driver_unavailable` /
`No active driver connected`) — but the Hammerspoon handler does not read the
reply, so the operator sees nothing.

**Recovery**: open or refresh the deck tab at
`http://127.0.0.1:3000/presentation/<name>/deck/index.html`. The deck's
reveal.js plugin registers as the driver on load. If it is already open, the
websocket may have dropped — reload the tab.

### `presenter:doctor` and `presenter:smoke` pass but Hammerspoon is broken

Both are Deckhand-side checks only. `doctor` validates config, OBS canvas
dimensions, platform, ffmpeg, and whisper paths. `smoke` probes Deckhand's HTTP
and opens its own observer websocket. Neither inspects `~/.hammerspoon/`, the
init.lua sentinel block, the Hammerspoon process, or the Accessibility grant.

Pre-talk, manually confirm:

1. `~/.hammerspoon/deckhand/{deckhand,apply_state,window_match}.lua` exist
   (re-run `npm run hammerspoon:setup` if not),
2. `~/.hammerspoon/init.lua` contains the `-- >>> deckhand >>>` /
   `-- <<< deckhand <<<` block,
3. Hammerspoon is running,
4. Accessibility is granted to Hammerspoon in System Settings,
5. the Hammerspoon console has no `[deckhand:hammerspoon]` errors after a slide
   advance.

See [RUNBOOK.md](RUNBOOK.md) for the literal pre-talk version of this.

### Hub restarts

Not a failure most operators will hit, but worth knowing: Hammerspoon
auto-reconnects to the hub ~1s after a drop, resets its `last_seq` counter to
0, re-registers as an observer, and accepts the freshly republished sticky
`presentationState` even though its seq is lower than the last seen. No manual
intervention is needed.

If the whole Deckhand process is down (not just the hub), Hammerspoon keeps
retrying; hotkeys fire but the send is a silent no-op (`socket == nil`).
Restart Deckhand and Hammerspoon reconnects within a second.

## When `/status.json` lies

Because Deckhand does not actively poll most of its dependencies, the status
payload can be misleading in specific cases:

| Field | Stale after | How to verify for real |
| --- | --- | --- |
| `obs.connected` | OBS WebSocket drop | advance a slide; watch Deckhand's log for `Failed to ... OBS ...` |
| `browserSession.connected` | Chrome exit | the field does flip to `false`, but `chromePid` is not cleared; treat any `connected: false` as terminal |
| `hub.observerCount` | nothing — this is live | n/a |
| `phase` | nothing — this is live | n/a |

When in doubt, advance a slide and watch the Deckhand terminal log. Every OBS
failure, browser failure, and observer publish failure is logged there even
when it does not change status.

## Recovering without losing your place

If you must restart Deckhand mid-talk:

1. Note the current slide id (visible in `/status.json` as `current.slideId`,
   or in the deck URL's `#/<h>.<v>` fragment).
2. Stop Deckhand (`Ctrl+C`).
3. Start it again: `node ./src/index.js <name>`.
4. After startup, navigate the deck to the noted slide id. Deckhand rebuilds
   browser windows and OBS bindings from the current slide's `layout`.

There is no built-in "resume from slide X" yet — the deck itself is the source
of truth for position. The OBS reconcile at startup re-prunes `Deckhand_*`
entities to match config, so it is safe to restart mid-talk without leaving OBS
in a half-state.
