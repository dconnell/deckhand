# Presenter runbook

The literal five-minute pre-talk checklist. Run it in order, top to bottom, on
the laptop you will present from. Every step has a single observable pass/fail
signal; if any step fails, jump to the linked section in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

If you have more than five minutes, run it twice: once ten minutes before the
talk (so you have time to fix things), and once at T-1 minute (so a
last-minute macOS notification or Chrome update has not stolen focus or
permissions).

## Assumptions

- You have already done one-time setup: `npm install`,
  `npm run obs:setup -- <name>`, `npm run hammerspoon:setup`, OBS WebSocket
  enabled, OBS Screen Recording granted, Hammerspoon Accessibility granted. See
  [SETUP.md](SETUP.md).
- `presentation/<name>/config.local.json` has the real `obs.password` and any
  machine-specific selectors for this laptop.
- The talk is `<name>` below.

## T-5: hardware and OS

1. **Power** — laptop on power, not battery. Set the display to never sleep
   while on power (System Settings → Lock Screen → **Turn display off on power
   adapter when inactive**: Never, or plug in a display that prevents sleep).
2. **Do Not Disturb** — System Settings → Focus → **Do Not Disturb** on. This
   suppresses Notification Center banners that would otherwise steal focus
   mid-slide and break Hammerspoon window operations.
3. **Sound** — confirm the audience-path audio device is selected in OBS
   (Settings → Audio). If you demo audio, play a sample now.

   **Pass**: OBS meter responds.
4. **Displays** — set the resolution and arrangement you will use on stage
   **now**, before starting Deckhand. Deckhand's `presenter.stage` rectangle is
   absolute; changing display layout after startup invalidates it.

## T-4: macOS permissions (quick re-check)

macOS updates reset TCC entries unpredictably. Spend thirty seconds here.

1. System Settings → Privacy & Security → **Screen Recording**:
   - **OBS Studio** is enabled. If already enabled on a laptop that just took
     an OS update, toggle off, toggle on.
   - **Pass**: OBS is listed and on. (If not →
     [TROUBLESHOOTING: macOS update revoked OBS Screen Recording](TROUBLESHOOTING.md#macos-update-revoked-obs-screen-recording-permission).)
2. System Settings → Privacy & Security → **Accessibility**:
   - **Hammerspoon** is enabled. Same toggle-off/on if it just took an update.
   - **Pass**: Hammerspoon is listed and on. (If not →
     [TROUBLESHOOTING: Hammerspoon Accessibility revoked mid-talk](TROUBLESHOOTING.md#hammerspoon-accessibility-revoked-mid-talk).)
3. If you use STT, **Microphone** must list your terminal (or `node`) as
   enabled.

## T-3: source apps and profiles

1. **If `chrome.profileName` is set** — fully quit Google Chrome (`Cmd+Q`).
   Chrome must not be running with that profile when Deckhand seeds its working
   copy. Verify with Activity Monitor or `pgrep -f "Google Chrome"`.

   **Pass**: no Chrome process running. (If Chrome won't quit →
   [TROUBLESHOOTING: Chrome profile seeding failures](TROUBLESHOOTING.md#chrome-profile-seeding-failures-chromeprofilename).)
2. **OBS** — open OBS. Confirm the scene collection is the one `obs:setup`
   populated (you should see `Deckhand_*` inputs in the Sources panel of at
   least one scene).
3. **Hammerspoon** — confirm it is running (menu bar icon visible). Open the
   Hammerspoon console now so tracebacks during the talk are visible at a
   glance.

## T-2: start Deckhand

In your dedicated terminal:

```bash
node ./src/index.js <name>
```

Wait for `phase` to flip to `ready`. The startup banner tells you the four
URLs. Watch the log for:

- `Connected to OBS` — if missing or `Failed to connect to OBS`, fix OBS
  WebSocket / password before going further.
- `Browser session ready` (or equivalent) — if missing, see
  [TROUBLESHOOTING: Chrome session](TROUBLESHOOTING.md#chrome-session).
- `Hub ... listening` — required for Hammerspoon and the presenter app.
- The first `driverPositionChanged` line — required for `/status.json` to
  report `phase: ready`.

If startup hangs past ~30s, read the most recent log line: it tells you which
gate is not satisfied (driver, observer, window bindings).

## T-1: verify the four outputs

Open these four things and confirm each is alive. Do not skip this; it is the
only end-to-end check.

1. **Deck** — `http://127.0.0.1:3000/presentation/<name>/deck/index.html`
   - **Pass**: page loads, driver registers (Deckhand terminal logs an
     observer/driver registration; `phase` becomes `ready`).
2. **Presenter app** — `http://127.0.0.1:3001/presenter/`
   - **Pass**: teleprompter shows your script for the current slide; follow
     mode works if you configured it.
3. **Status** — `http://127.0.0.1:3001/status.json`
   - **Pass**: `phase: "ready"`, `obs.connected: true`,
     `browserSession.connected: true`, `hub.observerCount >= 1`.
4. **OBS program view** — visually confirm the current slide's `audienceScene`
   is active and the `Deckhand_*` window_capture sources show live content,
   not black.

Then **advance one slide** using your intended talk input method:

- If you will drive from the deck window: click it and press Space.
- If you will drive from Hammerspoon hotkeys: press `Ctrl+Shift+Right`.

**Pass criteria for the advance**:

- OBS program scene changes to the next layout's `audienceScene`.
- The presenter app's teleprompter updates.
- The Deckhand-managed Chrome windows resize and focus correctly (this is the
  only end-to-end proof that Hammerspoon Accessibility is actually granted).
- The Deckhand terminal log shows no `Failed to ...` lines.

If windows do not move on the advance, Hammerspoon Accessibility is broken
even if it appears granted — see
[TROUBLESHOOTING: Hammerspoon Accessibility revoked mid-talk](TROUBLESHOOTING.md#hammerspoon-accessibility-revoked-mid-talk).
Do **not** assume the doctor or smoke check would have caught this; they do
not validate Hammerspoon.

If everything passes, **go back one slide** (`Ctrl+Shift+Left` or the deck's
back arrow) so you are positioned on your opening slide.

## T-0: final pre-stage

1. Open OBS's Projector for the live program output and share it into the
   meeting. The short version (full rationale in
   [SETUP.md: Sharing to the meeting](SETUP.md#sharing-to-the-meeting)):
   - non-Studio Mode: right-click the canvas → **Projector** → a window; in
     Studio Mode project **Program**, not **Preview**.
   - in Zoom **Share Screen**, select the specific **Projector window** (under
     Windows, not Screens) — never the display.
   - do **not** use OBS Virtual Camera (it re-encodes and caps resolution).
   - if you fullscreened the Projector to its own Space, do **not** press Esc
     to leave it (Esc closes the Projector) — switch Spaces with
     **Ctrl+Left-arrow** or a **three-finger swipe up** instead.
2. Hide the presenter app and the Hammerspoon console from your active Screen /
   Stage Manager layout (or move them to a different Space).
3. Put the deck window and the managed Chrome windows in the Space you will
   present from.
4. Confirm laptop volume, exhibit output, and any in-room mic are routed.
5. Close every app you do not need during the talk — fewer windows means fewer
   accidental focus steals.

## Smoke command (optional, T-2)

Right after starting Deckhand, you can run:

```bash
npm run presenter:smoke -- <name>
npm run presenter:doctor -- <name>
```

Both should pass. **But note what they do not cover**: neither checks OBS
Screen Recording permission, Hammerspoon existence / Accessibility, or whether
managed Chrome windows actually move on a slide advance. The T-1 advance test
above is the only substitute for that, and it is mandatory.

## Common last-minute failures

| Symptom at T-1 | First thing to check |
| --- | --- |
| OBS shows black on a `window_capture` | OBS Screen Recording grant (T-4) |
| Deckhand startup log says `Failed to connect to OBS` | OBS WebSocket enabled + password |
| Deckhand startup log says `Could not find Chrome profile named "..."` | profile name spelled exactly as in Chrome's UI |
| Deckhand startup log says `Could not reach Chrome DevTools endpoint` | antivirus / security tool killed Chrome mid-launch |
| Advance changes OBS scene but windows do not move | Hammerspoon Accessibility (T-4) — reload Hammerspoon config |
| Advance does nothing at all | deck tab lost driver registration — reload the deck tab |
| `/status.json` shows `obs.reconnecting: true` | OBS WebSocket dropped — Deckhand auto-reconnects; ensure OBS is running |

## If you have to restart mid-talk

1. `Ctrl+C` in the Deckhand terminal.
2. `node ./src/index.js <name>` again.
3. The deck resumes on the slide you were on automatically (persisted to
   `presentation/<name>/.deckhand-state.json`).

See [TROUBLESHOOTING: Recovering without losing your
place](TROUBLESHOOTING.md#recovering-without-losing-your-place) for why this is
safe.
