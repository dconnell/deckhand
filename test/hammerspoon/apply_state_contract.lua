package.path = package.path
  .. ";./hammerspoon/?.lua"
  .. ";./hammerspoon/fixtures/?.lua"

hs = {
  geometry = {
    rect = function(x, y, w, h)
      return { x = x, y = y, w = w, h = h }
    end,
  },
  window = { animationDuration = 0.2, setFrameCorrectness = false },
}

local apply_state = require("apply_state")
local fixture = require("presentation_state")

local function assert_equal(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s: expected %s, got %s", message, tostring(expected), tostring(actual)))
  end
end

local function assert_truthy(value, message)
  if not value then
    error(message)
  end
end

local function create_app(name, pid)
  return {
    name = function(_)
      return name
    end,
    pid = function(_)
      return pid
    end,
  }
end

local function create_window(name, calls, id, app)
  return {
    minimize = function(_)
      table.insert(calls, "minimize:" .. name)
    end,
    unminimize = function(_)
      table.insert(calls, "unminimize:" .. name)
    end,
    raise = function(_)
      table.insert(calls, "raise:" .. name)
    end,
    sendToBack = function(_)
      table.insert(calls, "back:" .. name)
    end,
    setFrame = function(_, rect)
      table.insert(calls, string.format("frame:%s:%d:%d:%d:%d", name, rect.x, rect.y, rect.w, rect.h))
    end,
    setFrameInScreenBounds = function(_, rect)
      table.insert(calls, string.format("inbounds:%s:%d:%d:%d:%d", name, rect.x, rect.y, rect.w, rect.h))
    end,
    focus = function(_)
      table.insert(calls, "focus:" .. name)
    end,
    id = function(_)
      return id
    end,
    application = function(_)
      return app
    end,
  }
end

local function create_settling_window(name, calls, id, app, settle_frames)
  local index = 1
  return {
    minimize = function(_)
      table.insert(calls, "minimize:" .. name)
    end,
    unminimize = function(_)
      table.insert(calls, "unminimize:" .. name)
    end,
    raise = function(_)
      table.insert(calls, "raise:" .. name)
    end,
    setFrame = function(_, rect)
      table.insert(calls, string.format("frame:%s:%d:%d:%d:%d", name, rect.x, rect.y, rect.w, rect.h))
    end,
    frame = function(_)
      local current = settle_frames[index] or settle_frames[#settle_frames]
      if index < #settle_frames then
        index = index + 1
      end
      table.insert(calls, string.format("readframe:%s:%d:%d:%d:%d", name, current.x, current.y, current.w, current.h))
      return current
    end,
    setFrameInScreenBounds = function(_, rect)
      table.insert(calls, string.format("inbounds:%s:%d:%d:%d:%d", name, rect.x, rect.y, rect.w, rect.h))
    end,
    focus = function(_)
      table.insert(calls, "focus:" .. name)
    end,
    id = function(_)
      return id
    end,
    application = function(_)
      return app
    end,
  }
end

local calls = {}
local terminal_app = create_app("iTerm2", 2001)
local slide_app = create_app("Safari", 2002)
local presenter_app = create_app("Google Chrome", 2003)
local windows = {
  Terminal = create_window("Terminal", calls, 4001, terminal_app),
  Slide = create_window("Slide", calls, 4002, slide_app),
  Presenter = create_window("Presenter", calls, 4003, presenter_app),
}

local result = apply_state.apply(fixture, {
  findWindow = function(binding)
    if binding.app == "iTerm2" then
      return windows.Terminal
    end

    if binding.titleIncludes == "Deckhand Presenter" then
      return windows.Presenter
    end

    return windows.Slide
  end,
})

assert_equal(#result.applied, 3, "expected both slots and one overlay to apply")
assert_equal(calls[1], "frame:Terminal:0:0:900:1168", "expected terminal frame first")
assert_equal(calls[2], "frame:Slide:900:0:900:1168", "expected slide frame second")
assert_equal(calls[3], "raise:Terminal", "expected terminal raise after frame")
assert_equal(calls[4], "raise:Slide", "expected slide raise after frame")
assert_equal(calls[5], "focus:Terminal", "expected stage focus before overlay raise")
assert_equal(calls[6], "unminimize:Presenter", "expected presenter restore before frame")
assert_equal(calls[7], "frame:Presenter:0:1120:1800:48", "expected presenter overlay frame after stage focus")
assert_equal(calls[8], "inbounds:Presenter:0:1120:1800:48", "expected overlay in-bounds call to pass the intended overlay rect")
assert_equal(calls[9], "raise:Presenter", "expected presenter overlay to raise on top of focused stage")
assert_equal(hs.window.animationDuration, 0, "expected animation disabled so frame application is deterministic")
assert_equal(hs.window.setFrameCorrectness, true, "expected the setFrame edge-case workaround to be enabled")
assert_equal(result.resolvedBindings.Terminal.macWindowId, 4001, "expected exact terminal window id")
assert_equal(result.resolvedBindings.Terminal.pid, 2001, "expected exact terminal pid")
assert_equal(result.resolvedBindings.Slide.macWindowId, 4002, "expected exact slide window id")
assert_equal(result.resolvedBindings.Slide.pid, 2002, "expected exact slide pid")
assert_equal(result.resolvedBindings.Presenter.macWindowId, 4003, "expected exact presenter window id")
assert_equal(result.resolvedBindings.Presenter.pid, 2003, "expected exact presenter pid")
assert_equal(result.placementSkipped, nil, "expected the default environment (no hs.screen) to fail open and apply placement")

while #calls > 0 do
  table.remove(calls)
end
local full_slide = apply_state.apply({
  slots = {
    {
      source = "Slide",
      position = "full",
      rect = { x = 0, y = 0, w = 1800, h = 1168 },
    },
  },
  windowBindings = {
    Slide = fixture.windowBindings.Slide,
  },
  focus = nil,
}, {
  findWindow = function(binding)
    if binding.app == "iTerm2" then
      return windows.Terminal
    end

    if binding.titleIncludes == "Deckhand Presenter" then
      return windows.Presenter
    end

    return windows.Slide
  end,
})

assert_equal(#full_slide.applied, 1, "expected slide-only layout to apply one source")
assert_equal(calls[1], "frame:Slide:0:0:1800:1168", "expected full-slide frame")
assert_equal(calls[2], "raise:Slide", "expected active slide to be raised")
assert_equal(calls[3], "focus:Slide", "expected full-slide layout to focus the slide window")

while #calls > 0 do
  table.remove(calls)
end
local hidden_overlay = apply_state.apply({
  slots = fixture.slots,
  overlays = {
    {
      source = "Presenter",
      hidden = true,
    },
  },
  windowBindings = fixture.windowBindings,
  managedWindowBindings = fixture.managedWindowBindings,
  focus = fixture.focus,
}, {
  findWindow = function(binding)
    if binding.app == "iTerm2" then
      return windows.Terminal
    end

    if binding.titleIncludes == "Deckhand Presenter" then
      return windows.Presenter
    end

    return windows.Slide
  end,
})

assert_equal(calls[5], "focus:Terminal", "expected stage focus before hidden overlay")
assert_equal(calls[6], "minimize:Presenter", "expected hidden overlay to minimize after stage focus")
assert_equal(hidden_overlay.focused, "Terminal", "expected overlays not to steal focus")
assert_equal(#hidden_overlay.missing, 0, "expected bound hidden overlay not to be reported missing")

local missing = apply_state.apply(fixture, {
  findWindow = function(binding)
    if binding.app == "iTerm2" then
      return windows.Terminal
    end

    return nil
  end,
})

assert_equal(#missing.missing, 2, "expected slide and presenter overlay to be missing")
assert_equal(missing.missing[1], "Slide", "expected missing slide source")
assert_equal(missing.missing[2], "Presenter", "expected missing presenter overlay source")

local strict_missing = apply_state.apply({
  slots = {
    {
      source = "Slide",
      position = "full",
      rect = { x = 0, y = 0, w = 1800, h = 1168 },
    },
  },
  windowBindings = {
    Slide = {
      app = "Safari",
      macWindowId = 4002,
      pid = 2002,
      strict = true,
    },
  },
  focus = nil,
}, {
  findWindow = function(_)
    return nil
  end,
})

assert_equal(#strict_missing.clearedBindings, 1, "expected stale strict binding to be cleared")
assert_equal(strict_missing.clearedBindings[1], "Slide", "expected slide strict binding clear")

local no_focus = apply_state.apply({
  slots = fixture.slots,
  windowBindings = fixture.windowBindings,
  focus = nil,
}, {
  findWindow = function(binding)
    if binding.app == "iTerm2" then
      return windows.Terminal
    end

    return windows.Slide
  end,
})

assert_equal(no_focus.focused, "Terminal", "expected first visible layout slot to be focused when explicit focus is absent")

-- The sticky frame memory is module state that deliberately outlives one
-- apply, so every scenario block below that settles (or fails to settle)
-- windows starts from a clean slate.
apply_state.reset_frame_memory()
local settle_calls = {}
local settling_slide = create_settling_window("SettlingSlide", settle_calls, 5001, slide_app, {
  { x = 100, y = 0, w = 1700, h = 1168 },
  { x = 40, y = 0, w = 1760, h = 1168 },
  { x = 0, y = 0, w = 1800, h = 1168 },
})

local settled = apply_state.apply({
  slots = {
    {
      source = "Slide",
      position = "full",
      rect = { x = 0, y = 0, w = 1800, h = 1168 },
    },
  },
  windowBindings = {
    Slide = fixture.windowBindings.Slide,
  },
  focus = nil,
}, {
  findWindow = function(_)
    return settling_slide
  end,
  sleep = function() end,
  settleMaxAttempts = 5,
})

-- The skip guard reads the pre-setFrame frame first (calls[1]), so the settle
-- poll observes the frames after the resize.
assert_equal(settle_calls[1], "readframe:SettlingSlide:100:0:1700:1168", "expected the skip guard to read the pre-setFrame frame")
assert_equal(settle_calls[2], "frame:SettlingSlide:0:0:1800:1168", "expected settling slide to be resized first")
assert_equal(settle_calls[3], "readframe:SettlingSlide:40:0:1760:1168", "expected settle check to read intermediate geometry")
assert_equal(settle_calls[4], "readframe:SettlingSlide:0:0:1800:1168", "expected settle check to keep polling until stable and observe the final target geometry")
assert_equal(settled.focused, "Slide", "expected settle polling not to change apply semantics")

-- Overlays are source-agnostic: any managedWindowBindings source (not just the
-- Deckhand-owned Presenter) must be positioned, raised, and reported applied.
while #calls > 0 do
  table.remove(calls)
end
local obs_app = create_app("OBS", 3001)
local obs_window = create_window("Obs", calls, 4010, obs_app)
local external_overlay = apply_state.apply({
  slots = {
    {
      source = "Terminal",
      position = "left",
      rect = { x = 0, y = 0, w = 900, h = 1168 },
    },
  },
  windowBindings = {
    Terminal = { app = "iTerm2" },
  },
  managedWindowBindings = {
    Terminal = { app = "iTerm2" },
    Obs = { app = "OBS", titleIncludes = "OBS" },
  },
  overlays = {
    {
      source = "Obs",
      rect = { x = 0, y = 0, w = 620, h = 560 },
    },
  },
  focus = "Terminal",
}, {
  findWindow = function(binding)
    if binding.app == "iTerm2" then
      return windows.Terminal
    end

    if binding.app == "OBS" then
      return obs_window
    end

    return nil
  end,
})

assert_equal(external_overlay.focused, "Terminal", "expected external overlay not to steal focus")
assert_equal(#external_overlay.applied, 2, "expected slot and external overlay to apply")
assert_equal(external_overlay.applied[2], "Obs", "expected Obs in applied")
assert_equal(calls[4], "unminimize:Obs", "expected external overlay restore before frame")
assert_equal(calls[5], "frame:Obs:0:0:620:560", "expected frame applied for the Obs overlay")
assert_equal(calls[7], "raise:Obs", "expected Obs overlay raised above the stage")

while #calls > 0 do
  table.remove(calls)
end
local console_app = create_app("Google Chrome", 4242)
local console_window = create_window("Console", calls, 777, console_app)
local console_overlay = apply_state.apply({
  slots = {},
  managedWindowBindings = {
    Console = { app = "Google Chrome", pid = 4242, macWindowId = 777, strict = true },
  },
  overlays = {
    {
      source = "Console",
      rect = { x = 40, y = 40, w = 480, h = 720 },
    },
  },
  focus = nil,
}, {
  findWindow = function(binding)
    if binding.app == "Google Chrome" then
      return console_window
    end

    return nil
  end,
})

assert_equal(#console_overlay.applied, 1, "expected the console overlay to apply")
assert_equal(console_overlay.applied[1], "Console", "expected Console in applied")
assert_equal(calls[2], "frame:Console:40:40:480:720", "expected frame applied for the Console overlay")
assert_equal(calls[4], "raise:Console", "expected Console overlay raised")
assert_equal(console_overlay.resolvedBindings.Console.macWindowId, 777, "expected exact console window id resolved")
assert_equal(console_overlay.resolvedBindings.Console.pid, 4242, "expected exact console pid resolved")

local missing_external = apply_state.apply({
  slots = {},
  managedWindowBindings = {},
  overlays = {
    {
      source = "Obs",
      rect = { x = 0, y = 0, w = 620, h = 560 },
    },
  },
  focus = nil,
}, {
  findWindow = function(_)
    return nil
  end,
})

assert_equal(#missing_external.missing, 1, "expected overlay with no binding entry to be reported missing")
assert_equal(missing_external.missing[1], "Obs", "expected the unbound external overlay source in missing")

-- Overlays must settle like slots: setFrame, poll until the window reports the
-- target frame, then clamp the intended rect into screen bounds (never the
-- mid-flight current frame).
apply_state.reset_frame_memory()
local settle_overlay_calls = {}
local settling_overlay = create_settling_window("SettlingPresenter", settle_overlay_calls, 6001, presenter_app, {
  { x = 0, y = 1000, w = 1800, h = 140 },
  { x = 0, y = 1120, w = 1800, h = 48 },
})

local settled_overlay = apply_state.apply({
  slots = {},
  managedWindowBindings = {
    Presenter = { app = "Google Chrome", titleIncludes = "Deckhand Presenter" },
  },
  overlays = {
    {
      source = "Presenter",
      rect = { x = 0, y = 1120, w = 1800, h = 48 },
    },
  },
  focus = nil,
}, {
  findWindow = function(_)
    return settling_overlay
  end,
  sleep = function() end,
  settleMaxAttempts = 5,
})

assert_equal(settled_overlay.applied[1], "Presenter", "expected settling overlay reported applied")
assert_equal(settle_overlay_calls[1], "unminimize:SettlingPresenter", "expected settling overlay restored before frame")
assert_equal(settle_overlay_calls[2], "readframe:SettlingPresenter:0:1000:1800:140", "expected the skip guard to read the pre-setFrame frame")
assert_equal(settle_overlay_calls[3], "frame:SettlingPresenter:0:1120:1800:48", "expected settling overlay resized to the overlay rect")
assert_equal(settle_overlay_calls[4], "readframe:SettlingPresenter:0:1120:1800:48", "expected overlay settle check to observe the target geometry")
assert_equal(settle_overlay_calls[5], "inbounds:SettlingPresenter:0:1120:1800:48", "expected in-bounds call to pass the intended overlay rect, not the mid-flight frame")
assert_equal(settle_overlay_calls[6], "raise:SettlingPresenter", "expected settling overlay to raise after settling")

-- An overlay window that never reaches the target must still be reported as
-- applied and end with the in-bounds clamp plus raise; the settle wait must
-- log the failure instead of failing silently.
apply_state.reset_frame_memory()
local stuck_calls = {}
local stuck_logs = {}
local stuck_overlay = create_settling_window("StuckPresenter", stuck_calls, 6002, presenter_app, {
  { x = 0, y = 900, w = 1800, h = 200 },
})

local stuck_result = apply_state.apply({
  slots = {},
  managedWindowBindings = {
    Presenter = { app = "Google Chrome", titleIncludes = "Deckhand Presenter" },
  },
  overlays = {
    {
      source = "Presenter",
      rect = { x = 0, y = 1120, w = 1800, h = 48 },
    },
  },
  focus = nil,
}, {
  findWindow = function(_)
    return stuck_overlay
  end,
  sleep = function() end,
  settleMaxAttempts = 3,
  logFn = function(message)
    table.insert(stuck_logs, message)
  end,
})

assert_equal(stuck_result.applied[1], "Presenter", "expected never-settling overlay still reported applied")
assert_equal(stuck_calls[1], "unminimize:StuckPresenter", "expected stuck overlay restored before frame")
assert_equal(stuck_calls[2], "readframe:StuckPresenter:0:900:1800:200", "expected the skip guard to read the pre-setFrame frame")
assert_equal(stuck_calls[3], "frame:StuckPresenter:0:1120:1800:48", "expected stuck overlay resized to the overlay rect")
assert_equal(stuck_calls[4], "readframe:StuckPresenter:0:900:1800:200", "expected first settle poll to read the wrong frame")
assert_equal(stuck_calls[5], "readframe:StuckPresenter:0:900:1800:200", "expected second settle poll to read the wrong frame")
assert_equal(stuck_calls[6], "readframe:StuckPresenter:0:900:1800:200", "expected third settle poll to read the wrong frame")
assert_equal(stuck_calls[7], "inbounds:StuckPresenter:0:1120:1800:48", "expected in-bounds call to pass the intended overlay rect after settle timeout")
assert_equal(stuck_calls[8], "raise:StuckPresenter", "expected stuck overlay to raise after settle timeout")
assert_equal(#stuck_logs, 2, "expected the settle failure log plus the slide-actions summary")
assert_truthy(string.find(stuck_logs[1], "did not settle", 1, true), "expected the log message to say the overlay did not settle")
assert_truthy(string.find(stuck_logs[2], "[deckhand:hammerspoon] Slide actions:", 1, true) == 1, "expected the second log message to start with the slide-actions summary prefix")
assert_truthy(string.find(stuck_logs[2], "Presenter", 1, true), "expected the action summary to name the Presenter source")
assert_equal(#stuck_result.frameMismatches, 1, "expected the never-settling overlay to report one frame mismatch")
assert_equal(stuck_result.frameMismatches[1].source, "Presenter", "expected the frame mismatch to name the overlay source")
assert_equal(stuck_result.frameMismatches[1].requested.x, 0, "expected the mismatch requested x to be the overlay rect x")
assert_equal(stuck_result.frameMismatches[1].requested.y, 1120, "expected the mismatch requested y to be the overlay rect y")
assert_equal(stuck_result.frameMismatches[1].requested.w, 1800, "expected the mismatch requested w to be the overlay rect w")
assert_equal(stuck_result.frameMismatches[1].requested.h, 48, "expected the mismatch requested h to be the overlay rect h")
assert_equal(stuck_result.frameMismatches[1].observed.x, 0, "expected the mismatch observed x to be the last polled x")
assert_equal(stuck_result.frameMismatches[1].observed.y, 900, "expected the mismatch observed y to be the last polled y")
assert_equal(stuck_result.frameMismatches[1].observed.w, 1800, "expected the mismatch observed w to be the last polled w")
assert_equal(stuck_result.frameMismatches[1].observed.h, 200, "expected the mismatch observed h to be the last polled h")

-- A slot window that never reaches its target rect must be reported exactly
-- like a stuck overlay, so OBS-style clamping surfaces for slots too.
apply_state.reset_frame_memory()
local stuck_slot_calls = {}
local stuck_slot_logs = {}
local stuck_slot = create_settling_window("StuckSlide", stuck_slot_calls, 6003, slide_app, {
  { x = 0, y = 0, w = 1210, h = 611 },
})

local stuck_slot_result = apply_state.apply({
  slots = {
    {
      source = "Slide",
      position = "full",
      rect = { x = 0, y = 0, w = 1210, h = 560 },
    },
  },
  windowBindings = {
    Slide = fixture.windowBindings.Slide,
  },
  focus = nil,
}, {
  findWindow = function(_)
    return stuck_slot
  end,
  sleep = function() end,
  settleMaxAttempts = 3,
  logFn = function(message)
    table.insert(stuck_slot_logs, message)
  end,
})

assert_equal(stuck_slot_result.applied[1], "Slide", "expected never-settling slot still reported applied")
assert_equal(#stuck_slot_logs, 2, "expected the settle failure log plus the slide-actions summary for the stuck slot")
assert_truthy(string.find(stuck_slot_logs[2], "[deckhand:hammerspoon] Slide actions:", 1, true) == 1, "expected the second log message to start with the slide-actions summary prefix")
assert_truthy(string.find(stuck_slot_logs[2], "Slide", 1, true), "expected the action summary to name the Slide source")
assert_equal(#stuck_slot_result.frameMismatches, 1, "expected the never-settling slot to report one frame mismatch")
assert_equal(stuck_slot_result.frameMismatches[1].source, "Slide", "expected the slot mismatch to name the slot source")
assert_equal(stuck_slot_result.frameMismatches[1].requested.x, 0, "expected the slot mismatch requested x")
assert_equal(stuck_slot_result.frameMismatches[1].requested.y, 0, "expected the slot mismatch requested y")
assert_equal(stuck_slot_result.frameMismatches[1].requested.w, 1210, "expected the slot mismatch requested w")
assert_equal(stuck_slot_result.frameMismatches[1].requested.h, 560, "expected the slot mismatch requested h")
assert_equal(stuck_slot_result.frameMismatches[1].observed.x, 0, "expected the slot mismatch observed x")
assert_equal(stuck_slot_result.frameMismatches[1].observed.y, 0, "expected the slot mismatch observed y")
assert_equal(stuck_slot_result.frameMismatches[1].observed.w, 1210, "expected the slot mismatch observed w")
assert_equal(stuck_slot_result.frameMismatches[1].observed.h, 611, "expected the slot mismatch observed h")

-- A window that settles (or an unmockable window that skips the wait) must not
-- produce any frame mismatch entries.
assert_equal(#settled.frameMismatches, 0, "expected a settling slot to produce no frame mismatches")
assert_equal(#settled_overlay.frameMismatches, 0, "expected a settling overlay to produce no frame mismatches")
assert_equal(#result.frameMismatches, 0, "expected unmockable windows (no frame method) to produce no frame mismatches")

-- Re-applying identical geometry on every slide navigation makes already-placed
-- windows visibly shake (setFrame with setFrameCorrectness is a multi-step
-- resize), so a window already sitting at its target rect within the settle
-- tolerance must skip the geometry calls entirely while the raise/focus
-- choreography and the applied reporting continue unchanged. The skip guard
-- itself reads the current frame once (logged as readframe:), so exactly one
-- readframe is expected for an already-placed window.

-- count_calls below is scoped to the placement-guard section, so the skip
-- tests keep their own prefix counter to assert zero setFrame calls.
local function count_call_prefix(entries, prefix)
  local count = 0
  for _, entry in ipairs(entries) do
    if string.sub(entry, 1, #prefix) == prefix then
      count = count + 1
    end
  end
  return count
end

-- A slot whose frame already equals its target rect: no setFrame, no settle
-- wait, just the skip guard's frame read plus the unchanged choreography.
apply_state.reset_frame_memory()
local placed_calls = {}
local placed_slide = create_settling_window("PlacedSlide", placed_calls, 6101, slide_app, {
  { x = 0, y = 0, w = 1800, h = 1168 },
})

local placed = apply_state.apply({
  slots = {
    {
      source = "Slide",
      position = "full",
      rect = { x = 0, y = 0, w = 1800, h = 1168 },
    },
  },
  windowBindings = {
    Slide = fixture.windowBindings.Slide,
  },
  focus = nil,
}, {
  findWindow = function(_)
    return placed_slide
  end,
  sleep = function() end,
  settleMaxAttempts = 5,
})

assert_equal(count_call_prefix(placed_calls, "frame:"), 0, "expected no setFrame for a slot already at its target rect")
assert_equal(#placed_calls, 3, "expected only the guard's frame read plus raise/focus for an already-placed slot")
assert_equal(placed_calls[1], "readframe:PlacedSlide:0:0:1800:1168", "expected the skip guard to read the current frame before deciding")
assert_equal(placed_calls[2], "raise:PlacedSlide", "expected an already-placed slot to still raise")
assert_equal(placed_calls[3], "focus:PlacedSlide", "expected an already-placed slot to keep the focus choreography")
assert_equal(placed.applied[1], "Slide", "expected an already-placed slot still reported applied")
assert_equal(#placed.frameMismatches, 0, "expected an already-placed slot to produce no frame mismatches")

-- One pixel off is inside the settle tolerance, so the slot must also count as
-- already placed and skip the shake-inducing setFrame.
local near_calls = {}
local near_slide = create_settling_window("NearSlide", near_calls, 6102, slide_app, {
  { x = 1, y = 0, w = 1800, h = 1168 },
})

local near = apply_state.apply({
  slots = {
    {
      source = "Slide",
      position = "full",
      rect = { x = 0, y = 0, w = 1800, h = 1168 },
    },
  },
  windowBindings = {
    Slide = fixture.windowBindings.Slide,
  },
  focus = nil,
}, {
  findWindow = function(_)
    return near_slide
  end,
  sleep = function() end,
  settleMaxAttempts = 5,
})

assert_equal(count_call_prefix(near_calls, "frame:"), 0, "expected a one-pixel offset (inside tolerance) to skip setFrame too")
assert_equal(#near_calls, 3, "expected only the guard's frame read plus raise/focus for the near-target slot")
assert_equal(near_calls[1], "readframe:NearSlide:1:0:1800:1168", "expected the skip guard to read the near-target frame")
assert_equal(near_calls[2], "raise:NearSlide", "expected the near-target slot to still raise")
assert_equal(near_calls[3], "focus:NearSlide", "expected the near-target slot to keep the focus choreography")

-- Two pixels off is outside the tolerance, so the slot must still be framed
-- and settled exactly as before the skip guard existed.
local far_calls = {}
local far_slide = create_settling_window("FarSlide", far_calls, 6103, slide_app, {
  { x = 2, y = 0, w = 1800, h = 1168 },
})

local far = apply_state.apply({
  slots = {
    {
      source = "Slide",
      position = "full",
      rect = { x = 0, y = 0, w = 1800, h = 1168 },
    },
  },
  windowBindings = {
    Slide = fixture.windowBindings.Slide,
  },
  focus = nil,
}, {
  findWindow = function(_)
    return far_slide
  end,
  sleep = function() end,
  settleMaxAttempts = 3,
})

assert_equal(count_call_prefix(far_calls, "frame:"), 1, "expected an out-of-tolerance slot to still be framed")
assert_equal(far_calls[1], "readframe:FarSlide:2:0:1800:1168", "expected the skip guard to read the off-target frame first")
assert_equal(far_calls[2], "frame:FarSlide:0:0:1800:1168", "expected an out-of-tolerance slot to still be resized")
assert_equal(far_calls[3], "readframe:FarSlide:2:0:1800:1168", "expected an out-of-tolerance slot to keep the settle poll")
assert_equal(#far.frameMismatches, 1, "expected an out-of-tolerance stuck slot to report a frame mismatch")

-- An overlay already at its rect skips setFrame, the settle wait, and the
-- in-bounds clamp, but unminimize/raise and the applied reporting continue.
local placed_overlay_calls = {}
local placed_overlay = create_settling_window("PlacedPresenter", placed_overlay_calls, 6104, presenter_app, {
  { x = 0, y = 1120, w = 1800, h = 48 },
})

local placed_overlay_result = apply_state.apply({
  slots = {},
  managedWindowBindings = {
    Presenter = { app = "Google Chrome", titleIncludes = "Deckhand Presenter" },
  },
  overlays = {
    {
      source = "Presenter",
      rect = { x = 0, y = 1120, w = 1800, h = 48 },
    },
  },
  focus = nil,
}, {
  findWindow = function(_)
    return placed_overlay
  end,
  sleep = function() end,
  settleMaxAttempts = 5,
})

assert_equal(count_call_prefix(placed_overlay_calls, "frame:"), 0, "expected no setFrame for an overlay already at its target rect")
assert_equal(count_call_prefix(placed_overlay_calls, "inbounds:"), 0, "expected no in-bounds clamp for an overlay already at its target rect")
assert_equal(#placed_overlay_calls, 3, "expected only unminimize, the guard's frame read, and raise for an already-placed overlay")
assert_equal(placed_overlay_calls[1], "unminimize:PlacedPresenter", "expected an already-placed overlay to still be restored")
assert_equal(placed_overlay_calls[2], "readframe:PlacedPresenter:0:1120:1800:48", "expected the skip guard to read the overlay's current frame")
assert_equal(placed_overlay_calls[3], "raise:PlacedPresenter", "expected an already-placed overlay to still raise")
assert_equal(placed_overlay_result.applied[1], "Presenter", "expected an already-placed overlay still reported applied")
assert_equal(#placed_overlay_result.frameMismatches, 0, "expected an already-placed overlay to produce no frame mismatches")

-- ---------------------------------------------------------------------------
-- Sticky frame memory: a window whose target rect macOS/Chrome refuses parks
-- at a stable achievable frame forever, and re-issuing setFrame on every
-- apply only shakes it. After one failed settle for a target, later applies
-- that find the SAME target and the SAME parked frame must skip the geometry
-- entirely (no setFrame, no settle wait, no settle-failure log, no repeated
-- mismatch report, no framed action) while the applied reporting continues.
-- Anything that changes (the target moved, or the user dragged the window)
-- invalidates the memory and the normal attempt reruns. reset_frame_memory
-- clears the module state between scenarios because the memory deliberately
-- outlives one apply.
-- ---------------------------------------------------------------------------

-- A window whose frame() always reports whatever the test last parked it on:
-- setFrame never changes the observed frame, standing in for macOS refusing
-- the requested rect.
local function create_framed_window(name, calls, id, app)
  local current = { x = 0, y = 0, w = 0, h = 0 }
  local window = {
    isFocused = function(_)
      return true
    end,
    minimize = function(_)
      table.insert(calls, "minimize:" .. name)
    end,
    unminimize = function(_)
      table.insert(calls, "unminimize:" .. name)
    end,
    raise = function(_)
      table.insert(calls, "raise:" .. name)
    end,
    setFrame = function(_, rect)
      table.insert(calls, string.format("frame:%s:%d:%d:%d:%d", name, rect.x, rect.y, rect.w, rect.h))
    end,
    frame = function(_)
      table.insert(calls, string.format("readframe:%s:%d:%d:%d:%d", name, current.x, current.y, current.w, current.h))
      return { x = current.x, y = current.y, w = current.w, h = current.h }
    end,
    setFrameInScreenBounds = function(_, rect)
      table.insert(calls, string.format("inbounds:%s:%d:%d:%d:%d", name, rect.x, rect.y, rect.w, rect.h))
    end,
    focus = function(_)
      table.insert(calls, "focus:" .. name)
    end,
    id = function(_)
      return id
    end,
    application = function(_)
      return app
    end,
  }

  -- Test levers: park the window on its stable achievable frame, or drag it
  -- somewhere else entirely.
  window.parkAt = function(_, x, y, w, h)
    current = { x = x, y = y, w = w, h = h }
  end

  return window
end

apply_state.reset_frame_memory()
local sticky_calls = {}
local sticky_slide = create_framed_window("StickySlide", sticky_calls, 7001, slide_app)
sticky_slide:parkAt(1720, 30, 1720, 1410)

local function sticky_slide_state(target_rect)
  return {
    slots = {
      {
        source = "Slide",
        position = "full",
        rect = target_rect,
      },
    },
    windowBindings = {
      Slide = fixture.windowBindings.Slide,
    },
    focus = nil,
  }
end

local function sticky_slide_deps(logs)
  return {
    findWindow = function(_)
      return sticky_slide
    end,
    orderedWindows = function()
      return { sticky_slide }
    end,
    sleep = function() end,
    settleMaxAttempts = 3,
    logFn = function(message)
      table.insert(logs, message)
    end,
  }
end

-- First apply with target T and parked frame F: the real attempt still runs —
-- setFrame, the settle wait polling the parked frame, the settle-failure log
-- (now naming the target too), one mismatch entry, and the framed action.
local sticky_first_logs = {}
local sticky_first = apply_state.apply(
  sticky_slide_state({ x = 0, y = 0, w = 900, h = 1168 }),
  sticky_slide_deps(sticky_first_logs)
)

assert_equal(sticky_first.applied[1], "Slide", "expected the never-settling slot still reported applied on the first apply")
assert_equal(count_call_prefix(sticky_calls, "frame:"), 1, "expected the first apply to attempt the setFrame")
assert_equal(sticky_calls[1], "readframe:StickySlide:1720:30:1720:1410", "expected the skip guard to read the parked frame first")
assert_equal(sticky_calls[2], "frame:StickySlide:0:0:900:1168", "expected the first apply to resize toward the target")
assert_equal(sticky_calls[3], "readframe:StickySlide:1720:30:1720:1410", "expected the settle wait to poll the parked frame")
assert_equal(#sticky_first.frameMismatches, 1, "expected the first failed settle to report one frame mismatch")
assert_equal(sticky_first.frameMismatches[1].requested.x, 0, "expected the first mismatch to name the requested target x")
assert_equal(sticky_first.frameMismatches[1].observed.x, 1720, "expected the first mismatch to name the parked observed x")
assert_equal(#sticky_first_logs, 2, "expected the settle-failure log plus the slide-actions summary on the first apply")
assert_truthy(
  string.find(sticky_first_logs[1], "did not settle", 1, true),
  "expected the first log to say the window did not settle"
)
assert_truthy(
  string.find(sticky_first_logs[1], "did not settle to target frame x=0 y=0 w=900 h=1168; continuing with observed x=1720 y=30 w=1720 h=1410", 1, true),
  "expected the settle-failure log to name both the target and the observed frame"
)
assert_truthy(string.find(sticky_first_logs[2], "framed Slide", 1, true), "expected the first apply summary to name the framed action (by source)")

-- Second apply, same target and still parked at F: the sticky skip engages —
-- no setFrame, no settle wait, no settle-failure log, no repeated mismatch,
-- no framed action, and therefore no action summary at all — while the slot
-- stays in applied.
while #sticky_calls > 0 do
  table.remove(sticky_calls)
end
local sticky_second_logs = {}
local sticky_second = apply_state.apply(
  sticky_slide_state({ x = 0, y = 0, w = 900, h = 1168 }),
  sticky_slide_deps(sticky_second_logs)
)

assert_equal(sticky_second.applied[1], "Slide", "expected the sticky-skipped slot still reported applied")
assert_equal(count_call_prefix(sticky_calls, "frame:"), 0, "expected the second apply to skip setFrame for the parked window")
assert_equal(#sticky_calls, 2, "expected only the skip guard's and the stacking read's frame reads for the parked window")
assert_equal(sticky_calls[1], "readframe:StickySlide:1720:30:1720:1410", "expected the guard to read the parked frame before skipping")
assert_equal(sticky_calls[2], "readframe:StickySlide:1720:30:1720:1410", "expected the cast-interference check to read the parked frame too")
assert_equal(#sticky_second_logs, 0, "expected no logs at all: no settle failure and no action summary when only the frame was skipped")
assert_equal(#sticky_second.frameMismatches, 0, "expected no repeated frame mismatch for the parked window")

-- Third apply with a CHANGED target: the remembered target differs, so the
-- memory is invalidated and the normal setFrame plus settle wait reruns,
-- then re-memoizes the new target against the parked frame.
while #sticky_calls > 0 do
  table.remove(sticky_calls)
end
local sticky_third_logs = {}
local sticky_third = apply_state.apply(
  sticky_slide_state({ x = 0, y = 0, w = 1800, h = 1168 }),
  sticky_slide_deps(sticky_third_logs)
)

assert_equal(count_call_prefix(sticky_calls, "frame:"), 1, "expected a changed target to rerun the setFrame")
assert_equal(sticky_calls[2], "frame:StickySlide:0:0:1800:1168", "expected the changed target to be applied")
assert_equal(#sticky_third.frameMismatches, 1, "expected the failed settle for the new target to report a mismatch")
assert_equal(sticky_third.frameMismatches[1].requested.w, 1800, "expected the new mismatch to name the new target")
assert_equal(sticky_third.frameMismatches[1].observed.x, 1720, "expected the new mismatch to name the still-parked frame")

-- ...and the freshly stored memory immediately engages again on the next
-- apply with the same new target and parked frame.
while #sticky_calls > 0 do
  table.remove(sticky_calls)
end
local sticky_third_again_logs = {}
local sticky_third_again = apply_state.apply(
  sticky_slide_state({ x = 0, y = 0, w = 1800, h = 1168 }),
  sticky_slide_deps(sticky_third_again_logs)
)

assert_equal(count_call_prefix(sticky_calls, "frame:"), 0, "expected the re-memoized new target to skip setFrame again")
assert_equal(sticky_third_again.applied[1], "Slide", "expected the re-memoized sticky skip to keep the slot applied")
assert_equal(#sticky_third_again_logs, 0, "expected no logs for the re-memoized sticky skip")

-- Fourth apply where the user DRAGGED the window (the frame no longer matches
-- the remembered parked frame): the memory is invalidated and setFrame reruns.
while #sticky_calls > 0 do
  table.remove(sticky_calls)
end
sticky_slide:parkAt(500, 200, 900, 700)
local sticky_fourth_logs = {}
local sticky_fourth = apply_state.apply(
  sticky_slide_state({ x = 0, y = 0, w = 1800, h = 1168 }),
  sticky_slide_deps(sticky_fourth_logs)
)

assert_equal(count_call_prefix(sticky_calls, "frame:"), 1, "expected a dragged window to invalidate the memory and rerun the setFrame")
assert_equal(sticky_calls[2], "frame:StickySlide:0:0:1800:1168", "expected the dragged window to be reframed toward the target")
assert_equal(#sticky_fourth.frameMismatches, 1, "expected the dragged window's failed settle to report a mismatch")
assert_equal(sticky_fourth.frameMismatches[1].observed.x, 500, "expected the dragged window's mismatch to name the new parked frame")
assert_equal(sticky_fourth.frameMismatches[1].observed.y, 200, "expected the dragged window's mismatch to name the new parked y")

-- Overlay path: the same sticky behavior for a visible overlay window, with
-- the unminimize choreography continuing past the geometry skip.
apply_state.reset_frame_memory()
local sticky_ov_calls = {}
local sticky_ov = create_framed_window("StickyPresenter", sticky_ov_calls, 7002, presenter_app)
sticky_ov:parkAt(0, 900, 1800, 200)

local function sticky_overlay_state()
  return {
    slots = {},
    managedWindowBindings = {
      Presenter = { app = "Google Chrome", titleIncludes = "Deckhand Presenter" },
    },
    overlays = {
      {
        source = "Presenter",
        rect = { x = 0, y = 1120, w = 1800, h = 48 },
      },
    },
    focus = nil,
  }
end

local function sticky_overlay_deps(logs)
  return {
    findWindow = function(_)
      return sticky_ov
    end,
    orderedWindows = function()
      return { sticky_ov }
    end,
    sleep = function() end,
    settleMaxAttempts = 3,
    logFn = function(message)
      table.insert(logs, message)
    end,
  }
end

local sticky_ov_first_logs = {}
local sticky_ov_first = apply_state.apply(sticky_overlay_state(), sticky_overlay_deps(sticky_ov_first_logs))

assert_equal(sticky_ov_first.applied[1], "Presenter", "expected the never-settling overlay still reported applied on the first apply")
assert_equal(count_call_prefix(sticky_ov_calls, "frame:"), 1, "expected the first overlay apply to attempt the setFrame")
assert_equal(count_call_prefix(sticky_ov_calls, "inbounds:"), 1, "expected the first overlay apply to keep the in-bounds clamp after the failed settle")
assert_equal(#sticky_ov_first.frameMismatches, 1, "expected the first overlay failed settle to report one frame mismatch")

while #sticky_ov_calls > 0 do
  table.remove(sticky_ov_calls)
end
local sticky_ov_second_logs = {}
local sticky_ov_second = apply_state.apply(sticky_overlay_state(), sticky_overlay_deps(sticky_ov_second_logs))

assert_equal(sticky_ov_second.applied[1], "Presenter", "expected the sticky-skipped overlay still reported applied")
assert_equal(count_call_prefix(sticky_ov_calls, "frame:"), 0, "expected the second overlay apply to skip setFrame for the parked overlay")
assert_equal(count_call_prefix(sticky_ov_calls, "inbounds:"), 0, "expected the second overlay apply to skip the in-bounds clamp too")
assert_equal(count_call_prefix(sticky_ov_calls, "unminimize:"), 1, "expected the restore choreography to continue past the sticky geometry skip")
assert_equal(#sticky_ov_second.frameMismatches, 0, "expected no repeated frame mismatch for the parked overlay")
assert_equal(#sticky_ov_second_logs, 1, "expected only the unminimize action summary for the sticky-skipped overlay")
assert_truthy(string.find(sticky_ov_second_logs[1], "unminimized Presenter", 1, true), "expected the summary to name the restore (by source)")
assert_equal(string.find(sticky_ov_second_logs[1], "framed", 1, true), nil, "expected no framed action in the sticky-skipped overlay summary")
assert_equal(string.find(sticky_ov_second_logs[1], "did not settle", 1, true), nil, "expected no settle-failure log for the sticky-skipped overlay")

-- ---------------------------------------------------------------------------
-- Steady-state proportional actuation
--
-- Each slide defines a cast — its slot windows plus its visible overlays —
-- and every window is touched only when it is individually wrong: geometry
-- only when a frame is off its target rect, minimize/unminimize only when
-- the minimized state is actually wrong, and the raise/focus choreography
-- only when the cast itself is wrong. The cast is judged by two cheap
-- checks: no pair of cast windows whose frames strictly intersect may sit
-- inverted relative to the desired front-to-back order (non-overlapping cast
-- windows — e.g. on different displays — never constrain the order, because
-- the merged macOS window order cannot reproduce it anyway), and no foreign
-- window may sit ABOVE a cast window
-- while strictly overlapping its frame — a benign window on another display
-- (or anywhere non-overlapping) must be ignored, because the old strict
-- top-of-the-global-z-order requirement failed on multi-display setups and
-- ran the flash-inducing raise cycle on every slide navigation. When the
-- cast is right but only keyboard focus was lost, a single focus() plus
-- re-raising the overlays that belong above the focus target suffices.
-- Fail open: any uncertainty (unreadable stacking, unreadable frames,
-- unknown focus state) keeps today's full choreography, so an uncertain
-- stage is always re-stacked rather than left wrong. Every mock window below
-- already sits at its target rect so the geometry skip engages and these
-- tests stay purely about raise/focus/minimize. The default env above (no
-- hs.window.orderedWindows) is itself the fail-open case, so orderedWindows
-- is injected here to drive the checks.
-- ---------------------------------------------------------------------------

local function create_steady_window(name, calls, id, app, rect, focused, opts)
  opts = opts or {}
  local window = {
    frame = function(_)
      table.insert(calls, string.format("readframe:%s:%d:%d:%d:%d", name, rect.x, rect.y, rect.w, rect.h))
      return { x = rect.x, y = rect.y, w = rect.w, h = rect.h }
    end,
    isFocused = function(_)
      return focused
    end,
    minimize = function(_)
      table.insert(calls, "minimize:" .. name)
    end,
    unminimize = function(_)
      table.insert(calls, "unminimize:" .. name)
    end,
    raise = function(_)
      table.insert(calls, "raise:" .. name)
    end,
    setFrame = function(_, r)
      table.insert(calls, string.format("frame:%s:%d:%d:%d:%d", name, r.x, r.y, r.w, r.h))
    end,
    setFrameInScreenBounds = function(_, r)
      table.insert(calls, string.format("inbounds:%s:%d:%d:%d:%d", name, r.x, r.y, r.w, r.h))
    end,
    focus = function(_)
      table.insert(calls, "focus:" .. name)
    end,
    id = function(_)
      return id
    end,
    application = function(_)
      return app
    end,
  }

  -- isMinimized is opt-in: a mock without it stands for a window whose
  -- minimized state cannot be read, which must fail open to today's
  -- always-minimize/always-unminimize; "throw" simulates a throwing probe,
  -- same fail-open.
  if opts.throwIsMinimized then
    window.isMinimized = function(_)
      error("isMinimized exploded")
    end
  elseif opts.minimized ~= nil then
    window.isMinimized = function(_)
      return opts.minimized
    end
  end

  return window
end

local function create_steady_env(calls, terminal_focused, presenter_opts)
  local terminal = create_steady_window("Terminal", calls, 4001, terminal_app, { x = 0, y = 0, w = 900, h = 1168 }, terminal_focused)
  local slide = create_steady_window("Slide", calls, 4002, slide_app, { x = 900, y = 0, w = 900, h = 1168 }, false)
  local presenter = create_steady_window("Presenter", calls, 4003, presenter_app, { x = 0, y = 1120, w = 1800, h = 48 }, false, presenter_opts)
  return {
    terminal = terminal,
    slide = slide,
    presenter = presenter,
    findWindow = function(binding)
      if binding.app == "iTerm2" then
        return terminal
      end

      if binding.titleIncludes == "Deckhand Presenter" then
        return presenter
      end

      return slide
    end,
  }
end

-- Foreign (non-cast) windows only need an id for the z-order walk. The frame
-- is optional (a missing frame method) and "throw" simulates a throwing
-- frame(): both unknown-geometry cases must fail open to interference.
local function create_foreign_window(id, frame)
  local window = {
    id = function(_)
      return id
    end,
  }

  if frame == "throw" then
    window.frame = function(_)
      error("frame exploded")
    end
  elseif frame ~= nil then
    window.frame = function(_)
      return { x = frame.x, y = frame.y, w = frame.w, h = frame.h }
    end
  end

  return window
end

local function find_call(calls_list, entry)
  for index, candidate in ipairs(calls_list) do
    if candidate == entry then
      return index
    end
  end

  return nil
end

-- Steady state: the fixture stage (Terminal left, Slide right, Presenter
-- overlay) stacked exactly as the choreography would leave it, front-to-back
-- [Presenter, Terminal, Slide], with the stage already focused. Nothing may
-- raise or focus, focused stays nil, and the applied reporting is unchanged.
local steady_calls = {}
local steady_env = create_steady_env(steady_calls, true)
local steady = apply_state.apply(fixture, {
  findWindow = steady_env.findWindow,
  orderedWindows = function()
    return { steady_env.presenter, steady_env.terminal, steady_env.slide }
  end,
})

assert_equal(count_call_prefix(steady_calls, "raise:"), 0, "expected steady state to skip every raise, including the overlay's")
assert_equal(count_call_prefix(steady_calls, "focus:"), 0, "expected steady state to skip the focus call")
assert_equal(steady.focused, nil, "expected focused to stay nil when the choreography is skipped")
assert_equal(count_call_prefix(steady_calls, "frame:"), 0, "expected steady state to keep the geometry skip for slots")
assert_equal(count_call_prefix(steady_calls, "inbounds:"), 0, "expected steady state to keep the geometry skip for the overlay")
assert_equal(#steady.applied, 3, "expected the applied reporting to be unchanged by the choreography skip")
assert_equal(steady.applied[1], "Terminal", "expected Terminal still reported applied in steady state")
assert_equal(steady.applied[2], "Slide", "expected Slide still reported applied in steady state")
assert_equal(steady.applied[3], "Presenter", "expected Presenter still reported applied in steady state")
assert_equal(#steady.frameMismatches, 0, "expected no frame mismatches in steady state")
assert_equal(count_call_prefix(steady_calls, "unminimize:"), 1, "expected the overlay unminimize to continue even when raises are skipped")

-- SPEC CHANGE (proportional actuation): lost keyboard focus used to rerun the
-- whole raise choreography; now the cast order and interference checks pass
-- here, so ONLY the focus target is focused and the overlay that belongs
-- above it is re-raised (focus() pulls the target to the absolute front).
-- Slot windows must not be raised at all.
local unfocused_calls = {}
local unfocused_env = create_steady_env(unfocused_calls, false)
local unfocused = apply_state.apply(fixture, {
  findWindow = unfocused_env.findWindow,
  orderedWindows = function()
    return { unfocused_env.presenter, unfocused_env.terminal, unfocused_env.slide }
  end,
})

assert_equal(count_call_prefix(unfocused_calls, "raise:Terminal"), 0, "expected no slot raises when only keyboard focus was lost")
assert_equal(count_call_prefix(unfocused_calls, "raise:Slide"), 0, "expected no slot raises when only keyboard focus was lost")
assert_equal(count_call_prefix(unfocused_calls, "focus:"), 1, "expected exactly one focus call when only keyboard focus was lost")
assert_equal(count_call_prefix(unfocused_calls, "raise:Presenter"), 1, "expected the overlay above the focus target to be re-raised")
assert_truthy(find_call(unfocused_calls, "focus:Terminal") < find_call(unfocused_calls, "raise:Presenter"), "expected the overlay re-raise to follow the focus call")
assert_equal(unfocused.focused, "Terminal", "expected focused to report the re-focused stage")

-- A foreign window sitting above the cast whose frame CANNOT be read (no
-- frame method): unknown geometry is uncertainty, so it is treated as
-- interference and the full choreography recovers the stage.
local covered_calls = {}
local covered_env = create_steady_env(covered_calls, true)
local covered = apply_state.apply(fixture, {
  findWindow = covered_env.findWindow,
  orderedWindows = function()
    return {
      { id = function(_) return 9999 end },
      covered_env.presenter,
      covered_env.terminal,
      covered_env.slide,
    }
  end,
})

assert_equal(count_call_prefix(covered_calls, "raise:"), 3, "expected an unreadable foreign frame to fail open to the full raise choreography")
assert_equal(count_call_prefix(covered_calls, "focus:"), 1, "expected an unreadable foreign frame to keep the focus choreography")
assert_equal(covered.focused, "Terminal", "expected the focus report unchanged when a foreign window's frame is unreadable")

-- THE user case: a benign foreign window ABOVE the cast in the global z-order
-- (e.g. a window on another display) whose frame does NOT overlap any cast
-- frame must be IGNORED — no raise, no focus, no minimize, no unminimize,
-- and no action summary log. The strict top-of-z-order check used to fail
-- here and flash the whole deck on every slide navigation.
local benign_calls = {}
local benign_logs = {}
local benign_env = create_steady_env(benign_calls, true, { minimized = false })
local benign = apply_state.apply(fixture, {
  findWindow = benign_env.findWindow,
  orderedWindows = function()
    return {
      create_foreign_window(9999, { x = 5000, y = 5000, w = 800, h = 600 }),
      benign_env.presenter,
      benign_env.terminal,
      benign_env.slide,
    }
  end,
  logFn = function(message)
    table.insert(benign_logs, message)
  end,
})

assert_equal(count_call_prefix(benign_calls, "raise:"), 0, "expected a benign non-overlapping foreign window to skip every raise")
assert_equal(count_call_prefix(benign_calls, "focus:"), 0, "expected a benign non-overlapping foreign window to skip the focus call")
assert_equal(count_call_prefix(benign_calls, "minimize:"), 0, "expected a benign non-overlapping foreign window to skip minimize")
assert_equal(count_call_prefix(benign_calls, "unminimize:"), 0, "expected a benign non-overlapping foreign window to skip unminimize")
assert_equal(count_call_prefix(benign_calls, "frame:"), 0, "expected a benign non-overlapping foreign window to keep the geometry skip for slots")
assert_equal(count_call_prefix(benign_calls, "inbounds:"), 0, "expected a benign non-overlapping foreign window to keep the geometry skip for the overlay")
assert_equal(benign.focused, nil, "expected focused to stay nil with a benign non-overlapping foreign window")
assert_equal(#benign_logs, 0, "expected no action summary line when nothing acted")

-- Strict overlap: a foreign window whose frame shares only an EDGE with a
-- cast frame is not covering the stage and must be ignored too.
local edge_calls = {}
local edge_env = create_steady_env(edge_calls, true, { minimized = false })
local edge = apply_state.apply(fixture, {
  findWindow = edge_env.findWindow,
  orderedWindows = function()
    return {
      create_foreign_window(9999, { x = 1800, y = 0, w = 100, h = 1168 }),
      edge_env.presenter,
      edge_env.terminal,
      edge_env.slide,
    }
  end,
})

assert_equal(count_call_prefix(edge_calls, "raise:"), 0, "expected an edge-sharing foreign window to skip every raise")
assert_equal(count_call_prefix(edge_calls, "focus:"), 0, "expected an edge-sharing foreign window to skip the focus call")
assert_equal(edge.focused, nil, "expected focused to stay nil for an edge-sharing foreign window")

-- Direction check: a foreign window BELOW the entire cast in z-order is
-- covered by the cast itself, so even an overlapping frame must be ignored.
local below_calls = {}
local below_env = create_steady_env(below_calls, true, { minimized = false })
local below = apply_state.apply(fixture, {
  findWindow = below_env.findWindow,
  orderedWindows = function()
    return {
      below_env.presenter,
      below_env.terminal,
      below_env.slide,
      create_foreign_window(9999, { x = 100, y = 100, w = 400, h = 400 }),
    }
  end,
})

assert_equal(count_call_prefix(below_calls, "raise:"), 0, "expected an overlapping foreign window below the cast to skip every raise")
assert_equal(count_call_prefix(below_calls, "focus:"), 0, "expected an overlapping foreign window below the cast to skip the focus call")
assert_equal(below.focused, nil, "expected focused to stay nil for an overlapping foreign window below the cast")

-- A foreign window ABOVE the cast whose frame strictly OVERLAPS a cast
-- window's frame is covering the stage and must trigger today's full
-- choreography, with the action summary naming the interference reason.
local covering_calls = {}
local covering_logs = {}
local covering_env = create_steady_env(covering_calls, true, { minimized = false })
local covering = apply_state.apply(fixture, {
  findWindow = covering_env.findWindow,
  orderedWindows = function()
    return {
      create_foreign_window(9999, { x = 100, y = 100, w = 400, h = 300 }),
      covering_env.presenter,
      covering_env.terminal,
      covering_env.slide,
    }
  end,
  logFn = function(message)
    table.insert(covering_logs, message)
  end,
})

assert_equal(count_call_prefix(covering_calls, "raise:Terminal"), 1, "expected an overlapping foreign window to raise the terminal slot")
assert_equal(count_call_prefix(covering_calls, "raise:Slide"), 1, "expected an overlapping foreign window to raise the slide slot")
assert_equal(count_call_prefix(covering_calls, "focus:Terminal"), 1, "expected an overlapping foreign window to keep the focus choreography")
assert_equal(count_call_prefix(covering_calls, "raise:Presenter"), 1, "expected an overlapping foreign window to raise the overlay last")
assert_truthy(
  find_call(covering_calls, "raise:Terminal") < find_call(covering_calls, "raise:Slide")
    and find_call(covering_calls, "raise:Slide") < find_call(covering_calls, "focus:Terminal")
    and find_call(covering_calls, "focus:Terminal") < find_call(covering_calls, "raise:Presenter"),
  "expected the full choreography order: slot raises, focus, overlay raise"
)
assert_equal(covering.focused, "Terminal", "expected the focus report unchanged when a foreign window covers the stage")
assert_equal(#covering_logs, 1, "expected exactly one action summary line when the stage was covered")
assert_truthy(string.find(covering_logs[1], "Slide actions:", 1, true), "expected the action summary prefix")
assert_truthy(string.find(covering_logs[1], "restacked (interference)", 1, true), "expected the action summary to name the interference reason")
assert_truthy(string.find(covering_logs[1], "focused Terminal", 1, true), "expected the action summary to name the focused window")

-- ...and a foreign window whose frame read THROWS is the same uncertainty:
-- fail open to the full choreography.
local throwing_frame_calls = {}
local throwing_frame_env = create_steady_env(throwing_frame_calls, true)
local throwing_frame = apply_state.apply(fixture, {
  findWindow = throwing_frame_env.findWindow,
  orderedWindows = function()
    return {
      create_foreign_window(9999, "throw"),
      throwing_frame_env.presenter,
      throwing_frame_env.terminal,
      throwing_frame_env.slide,
    }
  end,
})

assert_equal(count_call_prefix(throwing_frame_calls, "raise:"), 3, "expected a throwing foreign frame to fail open to the full raise choreography")
assert_equal(count_call_prefix(throwing_frame_calls, "focus:"), 1, "expected a throwing foreign frame to keep the focus choreography")

-- The managed windows holding their set but in the wrong relative order (the
-- slide above the focused terminal) must run the full choreography too. The
-- shared fixture's slots share only an edge, and edge-sharing does not count
-- as overlap, so this fixture deliberately overlaps the two slots: an
-- inversion of windows that actually cover each other is exactly what the
-- overlap-aware cast-order check must still catch. The scenario sits in a
-- do-block because the main chunk is near Lua's 200-active-locals limit.
do
  local swapped_calls = {}
  local swapped_terminal = create_steady_window("Terminal", swapped_calls, 4001, terminal_app, { x = 0, y = 0, w = 900, h = 1168 }, true)
  local swapped_slide = create_steady_window("Slide", swapped_calls, 4002, slide_app, { x = 450, y = 0, w = 900, h = 1168 }, false)
  local swapped_presenter = create_steady_window("Presenter", swapped_calls, 4003, presenter_app, { x = 0, y = 1120, w = 1800, h = 48 }, false)
  local swapped = apply_state.apply({
    slots = {
      {
        source = "Terminal",
        position = "left",
        rect = { x = 0, y = 0, w = 900, h = 1168 },
      },
      {
        source = "Slide",
        position = "right",
        rect = { x = 450, y = 0, w = 900, h = 1168 },
      },
    },
    windowBindings = {
      Terminal = { app = "iTerm2" },
      Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
    },
    managedWindowBindings = {
      Terminal = { app = "iTerm2" },
      Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
      Presenter = { app = "Google Chrome", titleIncludes = "Deckhand Presenter" },
    },
    overlays = {
      {
        source = "Presenter",
        rect = { x = 0, y = 1120, w = 1800, h = 48 },
      },
    },
    focus = "Terminal",
  }, {
    findWindow = function(binding)
      if binding.app == "iTerm2" then
        return swapped_terminal
      end

      if binding.titleIncludes == "Deckhand Presenter" then
        return swapped_presenter
      end

      return swapped_slide
    end,
    orderedWindows = function()
      return { swapped_presenter, swapped_slide, swapped_terminal }
    end,
  })

  assert_equal(count_call_prefix(swapped_calls, "raise:"), 3, "expected wrong relative order to run the full raise choreography")
  assert_equal(count_call_prefix(swapped_calls, "focus:"), 1, "expected wrong relative order to keep the focus choreography")
  assert_equal(swapped.focused, "Terminal", "expected the focus report unchanged for wrong relative order")
end

-- ---------------------------------------------------------------------------
-- Overlap-aware cast-order verification
--
-- The cast windows mostly live on different displays and do not overlap each
-- other, so their relative z-order is cosmetically irrelevant — macOS's merged
-- multi-display window order just never matches the desired sequence, and
-- enforcing it raised+focused the whole deck (visible flicker) on EVERY slide
-- navigation. The observed order is therefore correct when NO overlapping
-- pair is inverted: a pair the desired order puts a ABOVE b only conflicts
-- when a and b's frames strictly intersect (edge-sharing excluded) AND a sits
-- below b in the current order. A cast window missing from the current order,
-- or whose frame cannot be read, fails open to the full choreography, and the
-- mismatch summary names both the expected and the observed order.
-- ---------------------------------------------------------------------------

-- Three MUTUALLY non-overlapping cast windows (side-by-side columns); the
-- desired front-to-back order is [Presenter, Terminal, Slide]. (Each scenario
-- below sits in a do-block because the main chunk is near Lua's
-- 200-active-locals limit.)
local function create_disjoint_state()
  return {
    slots = {
      {
        source = "Terminal",
        position = "left",
        rect = { x = 0, y = 0, w = 600, h = 1168 },
      },
      {
        source = "Slide",
        position = "right",
        rect = { x = 600, y = 0, w = 600, h = 1168 },
      },
    },
    windowBindings = {
      Terminal = { app = "iTerm2" },
      Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
    },
    managedWindowBindings = {
      Terminal = { app = "iTerm2" },
      Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
      Presenter = { app = "Google Chrome", titleIncludes = "Deckhand Presenter" },
    },
    overlays = {
      {
        source = "Presenter",
        rect = { x = 1200, y = 0, w = 600, h = 1168 },
      },
    },
    focus = "Terminal",
  }
end

local function create_disjoint_env(calls, terminal_focused)
  local terminal = create_steady_window("Terminal", calls, 4001, terminal_app, { x = 0, y = 0, w = 600, h = 1168 }, terminal_focused)
  local slide = create_steady_window("Slide", calls, 4002, slide_app, { x = 600, y = 0, w = 600, h = 1168 }, false)
  local presenter = create_steady_window("Presenter", calls, 4003, presenter_app, { x = 1200, y = 0, w = 600, h = 1168 }, false, { minimized = false })
  return {
    terminal = terminal,
    slide = slide,
    presenter = presenter,
    findWindow = function(binding)
      if binding.app == "iTerm2" then
        return terminal
      end

      if binding.titleIncludes == "Deckhand Presenter" then
        return presenter
      end

      return slide
    end,
  }
end

-- THE user case: cast windows mutually NON-overlapping, observed order fully
-- scrambled vs the desired [Presenter, Terminal, Slide]: the merged
-- multi-display z-order is cosmetically irrelevant, so NOTHING may restack —
-- zero raise/focus, geometry skip intact, no summary log.
do
  local disjoint_calls = {}
  local disjoint_logs = {}
  local disjoint_env = create_disjoint_env(disjoint_calls, true)
  local disjoint = apply_state.apply(create_disjoint_state(), {
    findWindow = disjoint_env.findWindow,
    orderedWindows = function()
      return { disjoint_env.slide, disjoint_env.presenter, disjoint_env.terminal }
    end,
    logFn = function(message)
      table.insert(disjoint_logs, message)
    end,
  })

  assert_equal(count_call_prefix(disjoint_calls, "raise:"), 0, "expected a fully scrambled non-overlapping cast to skip every raise")
  assert_equal(count_call_prefix(disjoint_calls, "focus:"), 0, "expected a fully scrambled non-overlapping cast to skip the focus call")
  assert_equal(count_call_prefix(disjoint_calls, "frame:"), 0, "expected a fully scrambled non-overlapping cast to keep the geometry skip")
  assert_equal(disjoint.focused, nil, "expected focused to stay nil for a scrambled non-overlapping cast")
  assert_equal(#disjoint_logs, 0, "expected no action summary when the non-overlapping cast needs no restack")
end

-- Two cast windows whose frames strictly OVERLAP and sit inverted vs the
-- desired order [Terminal, Slide]: a real inversion of windows that actually
-- cover each other is visible, so the full choreography must run.
do
  local overlap_calls = {}
  local overlap_logs = {}
  local overlap_terminal = create_steady_window("Terminal", overlap_calls, 4001, terminal_app, { x = 0, y = 0, w = 900, h = 1168 }, true)
  local overlap_slide = create_steady_window("Slide", overlap_calls, 4002, slide_app, { x = 450, y = 0, w = 900, h = 1168 }, false)
  local overlap = apply_state.apply({
    slots = {
      {
        source = "Terminal",
        position = "left",
        rect = { x = 0, y = 0, w = 900, h = 1168 },
      },
      {
        source = "Slide",
        position = "right",
        rect = { x = 450, y = 0, w = 900, h = 1168 },
      },
    },
    windowBindings = {
      Terminal = { app = "iTerm2" },
      Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
    },
    focus = "Terminal",
  }, {
    findWindow = function(binding)
      if binding.app == "iTerm2" then
        return overlap_terminal
      end

      return overlap_slide
    end,
    orderedWindows = function()
      return { overlap_slide, overlap_terminal }
    end,
    logFn = function(message)
      table.insert(overlap_logs, message)
    end,
  })

  assert_equal(count_call_prefix(overlap_calls, "raise:"), 2, "expected an inverted overlapping pair to run the full raise choreography")
  assert_equal(count_call_prefix(overlap_calls, "focus:"), 1, "expected an inverted overlapping pair to keep the focus choreography")
  assert_equal(overlap.focused, "Terminal", "expected the focus report unchanged for an inverted overlapping pair")
  assert_equal(#overlap_logs, 1, "expected exactly one action summary line for the inverted overlapping pair")
  assert_truthy(
    string.find(overlap_logs[1], "restacked (cast order mismatch (expected Terminal>Slide, observed Slide>Terminal))", 1, true),
    "expected the summary to name both orders for the inverted overlapping pair"
  )

  -- ...and the summary must carry both orders compactly on that one line.
  assert_truthy(string.find(overlap_logs[1], "expected Terminal>Slide", 1, true), "expected the summary to name the expected front-to-back order")
  assert_truthy(string.find(overlap_logs[1], "observed Slide>Terminal", 1, true), "expected the summary to name the observed front-to-back order")
  assert_equal(string.find(overlap_logs[1], "\n", 1, true), nil, "expected the summary to stay on one line")
end

-- The overlapping pair (Terminal, Slide) keeps its desired relative order
-- while the NON-overlapping overlay (Presenter) is scrambled anywhere in the
-- order: only overlapping pairs constrain, so nothing may restack.
do
  local mixed_calls = {}
  local mixed_terminal = create_steady_window("Terminal", mixed_calls, 4001, terminal_app, { x = 0, y = 0, w = 900, h = 1168 }, true)
  local mixed_slide = create_steady_window("Slide", mixed_calls, 4002, slide_app, { x = 450, y = 0, w = 900, h = 1168 }, false)
  local mixed_presenter = create_steady_window("Presenter", mixed_calls, 4003, presenter_app, { x = 1350, y = 0, w = 450, h = 1168 }, false, { minimized = false })
  local mixed = apply_state.apply({
    slots = {
      {
        source = "Terminal",
        position = "left",
        rect = { x = 0, y = 0, w = 900, h = 1168 },
      },
      {
        source = "Slide",
        position = "right",
        rect = { x = 450, y = 0, w = 900, h = 1168 },
      },
    },
    windowBindings = {
      Terminal = { app = "iTerm2" },
      Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
    },
    managedWindowBindings = {
      Terminal = { app = "iTerm2" },
      Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
      Presenter = { app = "Google Chrome", titleIncludes = "Deckhand Presenter" },
    },
    overlays = {
      {
        source = "Presenter",
        rect = { x = 1350, y = 0, w = 450, h = 1168 },
      },
    },
    focus = "Terminal",
  }, {
    findWindow = function(binding)
      if binding.app == "iTerm2" then
        return mixed_terminal
      end

      if binding.titleIncludes == "Deckhand Presenter" then
        return mixed_presenter
      end

      return mixed_slide
    end,
    orderedWindows = function()
      return { mixed_terminal, mixed_presenter, mixed_slide }
    end,
  })

  assert_equal(count_call_prefix(mixed_calls, "raise:"), 0, "expected a correct overlapping pair with a scrambled non-overlapping one to skip every raise")
  assert_equal(count_call_prefix(mixed_calls, "focus:"), 0, "expected a correct overlapping pair with a scrambled non-overlapping one to skip focus")
  assert_equal(mixed.focused, nil, "expected focused to stay nil when only non-overlapping order is scrambled")
end

-- A cast window MISSING from the current order would be left wherever it is:
-- fail open to the full choreography, with the summary saying the observed
-- order is unavailable.
do
  local missing_order_calls = {}
  local missing_order_logs = {}
  local missing_order_env = create_disjoint_env(missing_order_calls, true)
  local missing_order = apply_state.apply(create_disjoint_state(), {
    findWindow = missing_order_env.findWindow,
    orderedWindows = function()
      return { missing_order_env.slide, missing_order_env.terminal }
    end,
    logFn = function(message)
      table.insert(missing_order_logs, message)
    end,
  })

  assert_equal(count_call_prefix(missing_order_calls, "raise:"), 3, "expected a cast window missing from the current order to run the full choreography")
  assert_equal(count_call_prefix(missing_order_calls, "focus:"), 1, "expected a cast window missing from the current order to keep the focus choreography")
  assert_truthy(
    string.find(missing_order_logs[1], "cast order mismatch (expected Presenter>Terminal>Slide, observed unavailable)", 1, true),
    "expected the summary to say the observed order is unavailable when a cast id is missing"
  )
end

-- A cast window whose frame CANNOT be read is uncertainty: every pair it
-- takes part in is treated as overlapping, so its order stays enforced (fail
-- open to the full choreography) even though these windows do not overlap.
do
  local unknown_frame_calls = {}
  local unknown_frame_logs = {}
  local unknown_frame_env = create_disjoint_env(unknown_frame_calls, true)
  local unknown_frame_presenter = {
    id = function(_)
      return 4003
    end,
    isMinimized = function(_)
      return false
    end,
    unminimize = function(_)
      table.insert(unknown_frame_calls, "unminimize:Presenter")
    end,
    setFrame = function(_, rect)
      table.insert(unknown_frame_calls, string.format("frame:Presenter:%d:%d:%d:%d", rect.x, rect.y, rect.w, rect.h))
    end,
    raise = function(_)
      table.insert(unknown_frame_calls, "raise:Presenter")
    end,
  }
  local unknown_frame = apply_state.apply(create_disjoint_state(), {
    findWindow = function(binding)
      if binding.titleIncludes == "Deckhand Presenter" then
        return unknown_frame_presenter
      end

      return unknown_frame_env.findWindow(binding)
    end,
    orderedWindows = function()
      return { unknown_frame_env.slide, unknown_frame_presenter, unknown_frame_env.terminal }
    end,
    logFn = function(message)
      table.insert(unknown_frame_logs, message)
    end,
  })

  assert_equal(count_call_prefix(unknown_frame_calls, "raise:"), 3, "expected an unreadable cast frame to fail open to the full choreography")
  assert_equal(count_call_prefix(unknown_frame_calls, "focus:"), 1, "expected an unreadable cast frame to keep the focus choreography")
  assert_truthy(
    string.find(unknown_frame_logs[1], "cast order mismatch (expected Presenter>Terminal>Slide, observed Slide>Presenter>Terminal)", 1, true),
    "expected the unreadable cast frame to enforce the pair's order via the full choreography"
  )
end

-- Focus-only recovery with TWO overlays above the focus target: focus()
-- pulls the target to the ABSOLUTE front, so the overlays must be re-raised
-- closest-to-focus first and topmost last (desired [O2, O1, Terminal, Slide]:
-- raise O1 then O2), otherwise each raise lands at the front and inverts the
-- final overlay order. Zero slot raises may happen.
local focus_only_calls = {}
local focus_only_logs = {}
local focus_only_terminal = create_steady_window("Terminal", focus_only_calls, 4001, terminal_app, { x = 0, y = 0, w = 900, h = 1168 }, false)
local focus_only_slide = create_steady_window("Slide", focus_only_calls, 4002, slide_app, { x = 900, y = 0, w = 900, h = 1168 }, false)
local overlay_one = create_steady_window("O1", focus_only_calls, 4101, presenter_app, { x = 0, y = 1120, w = 880, h = 48 }, false, { minimized = false })
local overlay_two = create_steady_window("O2", focus_only_calls, 4102, presenter_app, { x = 900, y = 1120, w = 880, h = 48 }, false, { minimized = false })
local focus_only = apply_state.apply({
  slots = {
    {
      source = "Terminal",
      position = "left",
      rect = { x = 0, y = 0, w = 900, h = 1168 },
    },
    {
      source = "Slide",
      position = "right",
      rect = { x = 900, y = 0, w = 900, h = 1168 },
    },
  },
  windowBindings = {
    Terminal = { app = "iTerm2" },
    Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
  },
  managedWindowBindings = {
    Terminal = { app = "iTerm2" },
    Slide = { app = "Safari", titleIncludes = "Deckhand Deck" },
    O1 = { app = "Google Chrome", titleIncludes = "Deckhand O1" },
    O2 = { app = "Google Chrome", titleIncludes = "Deckhand O2" },
  },
  overlays = {
    {
      source = "O1",
      rect = { x = 0, y = 1120, w = 880, h = 48 },
    },
    {
      source = "O2",
      rect = { x = 900, y = 1120, w = 880, h = 48 },
    },
  },
  focus = "Terminal",
}, {
  findWindow = function(binding)
    if binding.app == "iTerm2" then
      return focus_only_terminal
    end

    if binding.titleIncludes == "Deckhand O1" then
      return overlay_one
    end

    if binding.titleIncludes == "Deckhand O2" then
      return overlay_two
    end

    return focus_only_slide
  end,
  orderedWindows = function()
    return { overlay_two, overlay_one, focus_only_terminal, focus_only_slide }
  end,
  logFn = function(message)
    table.insert(focus_only_logs, message)
  end,
})

assert_equal(count_call_prefix(focus_only_calls, "raise:"), 2, "expected only the two overlay re-raises in the focus-only path")
assert_equal(count_call_prefix(focus_only_calls, "raise:Terminal"), 0, "expected zero slot raises in the focus-only path")
assert_equal(count_call_prefix(focus_only_calls, "raise:Slide"), 0, "expected zero slot raises in the focus-only path")
assert_equal(count_call_prefix(focus_only_calls, "focus:"), 1, "expected exactly one focus call in the focus-only path")
assert_truthy(
  find_call(focus_only_calls, "focus:Terminal") < find_call(focus_only_calls, "raise:O1")
    and find_call(focus_only_calls, "raise:O1") < find_call(focus_only_calls, "raise:O2"),
  "expected the overlay closest to the focus target raised first and the topmost overlay last"
)
assert_equal(focus_only.focused, "Terminal", "expected focused to report the focus-only target")
assert_equal(#focus_only_logs, 1, "expected exactly one action summary line for the focus-only path")
assert_truthy(string.find(focus_only_logs[1], "focused Terminal; raised O1; raised O2", 1, true), "expected the action summary to name the focus and re-raise order")

-- Hidden overlays minimize proportionally: an already-minimized window is
-- left alone; a still-visible one is minimized; a missing or throwing
-- isMinimized fails open to today's always-minimize. The choreography skip
-- itself is unaffected (raises stay skipped while the stage is steady).
local function hidden_overlay_state()
  return {
    slots = fixture.slots,
    overlays = {
      {
        source = "Presenter",
        hidden = true,
      },
    },
    windowBindings = fixture.windowBindings,
    managedWindowBindings = fixture.managedWindowBindings,
    focus = fixture.focus,
  }
end

local already_min_calls = {}
local already_min_env = create_steady_env(already_min_calls, true, { minimized = true })
apply_state.apply(hidden_overlay_state(), {
  findWindow = already_min_env.findWindow,
  orderedWindows = function()
    -- A minimized overlay is not part of the cast and realistically does not
    -- sit above the stage, so only the slots make up the current order here.
    return { already_min_env.terminal, already_min_env.slide }
  end,
})

assert_equal(count_call_prefix(already_min_calls, "minimize:"), 0, "expected an already-minimized hidden overlay not to be minimized again")
assert_equal(count_call_prefix(already_min_calls, "raise:"), 0, "expected the hidden-overlay guard not to resurrect the raise choreography")

local visible_hidden_calls = {}
local visible_hidden_env = create_steady_env(visible_hidden_calls, true, { minimized = false })
apply_state.apply(hidden_overlay_state(), {
  findWindow = visible_hidden_env.findWindow,
  orderedWindows = function()
    return { visible_hidden_env.terminal, visible_hidden_env.slide }
  end,
})

assert_equal(count_call_prefix(visible_hidden_calls, "minimize:"), 1, "expected a still-visible hidden overlay to be minimized")

local throwing_min_calls = {}
local throwing_min_env = create_steady_env(throwing_min_calls, true, { throwIsMinimized = true })
apply_state.apply(hidden_overlay_state(), {
  findWindow = throwing_min_env.findWindow,
  orderedWindows = function()
    return { throwing_min_env.terminal, throwing_min_env.slide }
  end,
})

assert_equal(count_call_prefix(throwing_min_calls, "minimize:"), 1, "expected a throwing isMinimized to fail open to minimize")

-- Visible overlays unminimize proportionally: an on-screen (not minimized)
-- overlay is left alone; a docked (minimized) one is restored; a missing or
-- throwing isMinimized fails open to today's always-unminimize. Restoring
-- must not resurrect the raise/focus choreography while the stage is steady.
local onscreen_calls = {}
local onscreen_env = create_steady_env(onscreen_calls, true, { minimized = false })
apply_state.apply(fixture, {
  findWindow = onscreen_env.findWindow,
  orderedWindows = function()
    return { onscreen_env.presenter, onscreen_env.terminal, onscreen_env.slide }
  end,
})

assert_equal(count_call_prefix(onscreen_calls, "unminimize:"), 0, "expected an on-screen visible overlay not to be unminimized again")
assert_equal(count_call_prefix(onscreen_calls, "raise:"), 0, "expected the unminimize guard to keep the raise skip")
assert_equal(count_call_prefix(onscreen_calls, "focus:"), 0, "expected the unminimize guard to keep the focus skip")

local docked_calls = {}
local docked_env = create_steady_env(docked_calls, true, { minimized = true })
apply_state.apply(fixture, {
  findWindow = docked_env.findWindow,
  orderedWindows = function()
    return { docked_env.presenter, docked_env.terminal, docked_env.slide }
  end,
})

assert_equal(count_call_prefix(docked_calls, "unminimize:"), 1, "expected a docked visible overlay to be restored")
assert_equal(count_call_prefix(docked_calls, "raise:"), 0, "expected restoring not to resurrect the raise choreography")
assert_equal(count_call_prefix(docked_calls, "focus:"), 0, "expected restoring not to resurrect the focus choreography")

local throwing_unmin_calls = {}
local throwing_unmin_env = create_steady_env(throwing_unmin_calls, true, { throwIsMinimized = true })
apply_state.apply(fixture, {
  findWindow = throwing_unmin_env.findWindow,
  orderedWindows = function()
    return { throwing_unmin_env.presenter, throwing_unmin_env.terminal, throwing_unmin_env.slide }
  end,
})

assert_equal(count_call_prefix(throwing_unmin_calls, "unminimize:"), 1, "expected a throwing isMinimized to fail open to unminimize")

-- Fail open: any uncertainty about the current stacking must keep today's
-- choreography. A nil orderedWindows...
local nil_ordered_calls = {}
local nil_ordered_env = create_steady_env(nil_ordered_calls, true)
local nil_ordered = apply_state.apply(fixture, {
  findWindow = nil_ordered_env.findWindow,
  orderedWindows = function()
    return nil
  end,
})

assert_equal(count_call_prefix(nil_ordered_calls, "raise:"), 3, "expected nil orderedWindows to fail open to the full choreography")
assert_equal(count_call_prefix(nil_ordered_calls, "focus:"), 1, "expected nil orderedWindows to keep the focus choreography")
assert_equal(nil_ordered.focused, "Terminal", "expected nil orderedWindows to keep the focus report")

-- ...a throwing orderedWindows...
local throwing_ordered_calls = {}
local throwing_ordered_env = create_steady_env(throwing_ordered_calls, true)
local throwing_ordered = apply_state.apply(fixture, {
  findWindow = throwing_ordered_env.findWindow,
  orderedWindows = function()
    error("orderedWindows exploded")
  end,
})

assert_equal(count_call_prefix(throwing_ordered_calls, "raise:"), 3, "expected a throwing orderedWindows to fail open to the full choreography")
assert_equal(count_call_prefix(throwing_ordered_calls, "focus:"), 1, "expected a throwing orderedWindows to keep the focus choreography")

-- ...a visible overlay missing from the current order (it would be left
-- un-raised/covered, so the choreography must re-stack)...
local missing_overlay_calls = {}
local missing_overlay_env = create_steady_env(missing_overlay_calls, true)
local missing_overlay = apply_state.apply(fixture, {
  findWindow = missing_overlay_env.findWindow,
  orderedWindows = function()
    return { missing_overlay_env.terminal, missing_overlay_env.slide }
  end,
})

assert_equal(count_call_prefix(missing_overlay_calls, "raise:"), 3, "expected a visible overlay missing from the current order to run the full choreography")
assert_equal(count_call_prefix(missing_overlay_calls, "focus:"), 1, "expected a visible overlay missing from the current order to keep the focus choreography")

-- ...and one unreadable window id, which makes the whole current order
-- uncertain: no skip on partial information.
local throwing_id_calls = {}
local throwing_id_env = create_steady_env(throwing_id_calls, true)
local throwing_id = apply_state.apply(fixture, {
  findWindow = throwing_id_env.findWindow,
  orderedWindows = function()
    return {
      throwing_id_env.presenter,
      throwing_id_env.terminal,
      {
        id = function(_)
          error("id exploded")
        end,
      },
      throwing_id_env.slide,
    }
  end,
})

assert_equal(count_call_prefix(throwing_id_calls, "raise:"), 3, "expected an unreadable window id to fail open to the full choreography")
assert_equal(count_call_prefix(throwing_id_calls, "focus:"), 1, "expected an unreadable window id to keep the focus choreography")

-- ...and a slot window whose id throws on the desired side. The window is
-- left out of the injected current order so current_stacking_ids reads clean,
-- and it reports no application so exact binding resolution never reads the
-- throwing id itself: desired_stacking_ids is what hits the throw and must
-- return nil, so the choreography runs even though the current order looks
-- plausible.
local throwing_desired_id_calls = {}
local throwing_desired_id_env = create_steady_env(throwing_desired_id_calls, true)
throwing_desired_id_env.slide.application = function(_)
  return nil
end
throwing_desired_id_env.slide.id = function(_)
  error("slide id exploded")
end
local throwing_desired_id = apply_state.apply(fixture, {
  findWindow = throwing_desired_id_env.findWindow,
  orderedWindows = function()
    return { throwing_desired_id_env.presenter, throwing_desired_id_env.terminal }
  end,
})

assert_equal(count_call_prefix(throwing_desired_id_calls, "raise:"), 3, "expected a throwing desired-side window id to fail open to the full choreography")
assert_equal(count_call_prefix(throwing_desired_id_calls, "focus:"), 1, "expected a throwing desired-side window id to keep the focus choreography")
assert_equal(throwing_desired_id.focused, "Terminal", "expected a throwing desired-side window id to keep the focus report")

-- ...and a focus target whose isFocused throws: the pcall probe must read
-- that as not-focused, so the full choreography re-focuses the stage instead
-- of skipping on an unknown focus state.
local throwing_is_focused_calls = {}
local throwing_is_focused_env = create_steady_env(throwing_is_focused_calls, true)
throwing_is_focused_env.terminal.isFocused = function(_)
  error("isFocused exploded")
end
local throwing_is_focused = apply_state.apply(fixture, {
  findWindow = throwing_is_focused_env.findWindow,
  orderedWindows = function()
    return { throwing_is_focused_env.presenter, throwing_is_focused_env.terminal, throwing_is_focused_env.slide }
  end,
})

assert_equal(count_call_prefix(throwing_is_focused_calls, "raise:"), 3, "expected a throwing isFocused to fail open to the full choreography")
assert_equal(count_call_prefix(throwing_is_focused_calls, "focus:"), 1, "expected a throwing isFocused to keep the focus choreography")
assert_equal(throwing_is_focused.focused, "Terminal", "expected a throwing isFocused to keep the focus report")

-- When the isFocused probe THROWS, a system focusedWindow comparison (the
-- injectable deps.focusedWindow second opinion) must decide between "ok" and
-- "needed" instead of leaving focus unknown and forcing the flash-inducing
-- full choreography on every apply. The user's setup throws on every probe,
-- which used to pin focus at "unknown" forever.

-- Same id as the focus target: the fallback confirms focus is correct, so the
-- plan is "none" — no raises, no focus, focused stays nil — and the probe
-- failure is logged exactly once, trimmed to one line.
local fallback_ok_calls = {}
local fallback_ok_logs = {}
local fallback_ok_env = create_steady_env(fallback_ok_calls, true)
fallback_ok_env.terminal.isFocused = function(_)
  error("isFocused exploded\nwith a second line")
end
local fallback_ok = apply_state.apply(fixture, {
  findWindow = fallback_ok_env.findWindow,
  orderedWindows = function()
    return { fallback_ok_env.presenter, fallback_ok_env.terminal, fallback_ok_env.slide }
  end,
  focusedWindow = function()
    return { id = function(_) return 4001 end }
  end,
  logFn = function(message)
    table.insert(fallback_ok_logs, message)
  end,
})

assert_equal(count_call_prefix(fallback_ok_calls, "raise:"), 0, "expected a same-id focusedWindow fallback to skip every raise")
assert_equal(count_call_prefix(fallback_ok_calls, "focus:"), 0, "expected a same-id focusedWindow fallback to skip the focus call")
assert_equal(fallback_ok.focused, nil, "expected focused to stay nil when the fallback confirms focus")
assert_equal(#fallback_ok_logs, 2, "expected exactly the probe-failure diagnostic plus the unminimize action summary")
assert_truthy(
  string.find(fallback_ok_logs[1], "[deckhand:hammerspoon] Focus probe failed for source Terminal: ", 1, true) == 1,
  "expected the first log to be the probe-failure diagnostic naming the source"
)
assert_truthy(string.find(fallback_ok_logs[1], "isFocused exploded", 1, true), "expected the probe-failure diagnostic to include the error")
assert_truthy(string.find(fallback_ok_logs[1], "falling back to focusedWindow comparison", 1, true), "expected the probe-failure diagnostic to name the fallback")
assert_equal(string.find(fallback_ok_logs[1], "second line", 1, true), nil, "expected the probe-failure diagnostic's error trimmed to one line")
assert_equal(string.find(fallback_ok_logs[1], "\n", 1, true), nil, "expected the probe-failure diagnostic to stay on one line")
assert_truthy(string.find(fallback_ok_logs[2], "unminimized Presenter", 1, true), "expected the steady unminimize to continue past the fallback")
assert_equal(string.find(fallback_ok_logs[2], "raised ", 1, true), nil, "expected no raise in the summary when the fallback confirms focus")

-- Different id: the fallback reads the focus as lost, so the plan is
-- "focus-only" — one focus call plus the overlay re-raise, zero slot raises.
local fallback_needed_calls = {}
local fallback_needed_logs = {}
local fallback_needed_env = create_steady_env(fallback_needed_calls, true)
fallback_needed_env.terminal.isFocused = function(_)
  error("isFocused exploded")
end
local fallback_needed = apply_state.apply(fixture, {
  findWindow = fallback_needed_env.findWindow,
  orderedWindows = function()
    return { fallback_needed_env.presenter, fallback_needed_env.terminal, fallback_needed_env.slide }
  end,
  focusedWindow = function()
    return { id = function(_) return 9999 end }
  end,
  logFn = function(message)
    table.insert(fallback_needed_logs, message)
  end,
})

assert_equal(count_call_prefix(fallback_needed_calls, "raise:Terminal"), 0, "expected a differing-id fallback to keep slot raises skipped")
assert_equal(count_call_prefix(fallback_needed_calls, "raise:Slide"), 0, "expected a differing-id fallback to keep slot raises skipped")
assert_equal(count_call_prefix(fallback_needed_calls, "focus:"), 1, "expected a differing-id fallback to focus the target once")
assert_equal(count_call_prefix(fallback_needed_calls, "raise:Presenter"), 1, "expected a differing-id fallback to re-raise the overlay")
assert_truthy(
  find_call(fallback_needed_calls, "focus:Terminal") < find_call(fallback_needed_calls, "raise:Presenter"),
  "expected the overlay re-raise to follow the focus call after the fallback"
)
assert_equal(fallback_needed.focused, "Terminal", "expected focused to report the fallback-driven refocus")
local fallback_needed_probe_logs = 0
for _, message in ipairs(fallback_needed_logs) do
  if string.find(message, "Focus probe failed for source Terminal", 1, true) then
    fallback_needed_probe_logs = fallback_needed_probe_logs + 1
  end
end
assert_equal(fallback_needed_probe_logs, 1, "expected exactly one probe-failure diagnostic per apply")

-- Fallback unavailable: deps.focusedWindow itself throwing must keep today's
-- "unknown" fail-open and the full choreography (nil deps.focusedWindow — the
-- default guarded lookup — is already covered by the throwing-isFocused test
-- above, since the mock hs.window has no focusedWindow).
local fallback_throws_calls = {}
local fallback_throws_logs = {}
local fallback_throws_env = create_steady_env(fallback_throws_calls, true)
fallback_throws_env.terminal.isFocused = function(_)
  error("isFocused exploded")
end
local fallback_throws = apply_state.apply(fixture, {
  findWindow = fallback_throws_env.findWindow,
  orderedWindows = function()
    return { fallback_throws_env.presenter, fallback_throws_env.terminal, fallback_throws_env.slide }
  end,
  focusedWindow = function()
    error("focusedWindow exploded")
  end,
  logFn = function(message)
    table.insert(fallback_throws_logs, message)
  end,
})

assert_equal(count_call_prefix(fallback_throws_calls, "raise:"), 3, "expected a throwing focusedWindow fallback to fail open to the full choreography")
assert_equal(count_call_prefix(fallback_throws_calls, "focus:"), 1, "expected a throwing focusedWindow fallback to keep the focus choreography")
assert_equal(fallback_throws.focused, "Terminal", "expected a throwing focusedWindow fallback to keep the focus report")
-- The probe-failure diagnostic still fires when the fallback is unavailable —
-- it is the only telltale that the probe (not the stacking) is the uncertain
-- input — so the summary follows it.
assert_equal(#fallback_throws_logs, 2, "expected the probe-failure diagnostic plus the action summary")
assert_truthy(
  string.find(fallback_throws_logs[1], "[deckhand:hammerspoon] Focus probe failed for source Terminal: ", 1, true) == 1,
  "expected the first log to be the probe-failure diagnostic"
)
assert_truthy(string.find(fallback_throws_logs[2], "restacked (focus unknown)", 1, true), "expected the summary to name the focus-unknown reason")

-- ---------------------------------------------------------------------------
-- Display-arrangement placement guard
--
-- The default environment above has no hs.screen at all, so it exercises the
-- fail-open path. The tests below inject screens through deps.allScreens to
-- exercise both sides of the guard.
-- ---------------------------------------------------------------------------

local function make_screen(x, y, w, h)
  return {
    fullFrame = function(_)
      return { x = x, y = y, w = w, h = h }
    end,
  }
end

local function standard_find_window(binding)
  if binding.app == "iTerm2" then
    return windows.Terminal
  end

  if binding.titleIncludes == "Deckhand Presenter" then
    return windows.Presenter
  end

  return windows.Slide
end

local function count_calls(calls_list, prefix)
  local count = 0
  for _, entry in ipairs(calls_list) do
    if string.sub(entry, 1, #prefix) == prefix then
      count = count + 1
    end
  end
  return count
end

local function assert_no_geometry_calls(calls_list, message)
  assert_equal(count_calls(calls_list, "frame:"), 0, message)
  assert_equal(count_calls(calls_list, "inbounds:"), 0, message)
end

-- A screen arrangement whose union bounding box contains every configured
-- rect must apply geometry exactly as before, with no placementSkipped.
while #calls > 0 do
  table.remove(calls)
end
local matching = apply_state.apply(fixture, {
  findWindow = standard_find_window,
  allScreens = function()
    return {
      make_screen(0, 0, 1720, 1440),
      make_screen(1720, -229, 3840, 2160),
    }
  end,
})

assert_equal(#matching.applied, 3, "expected matching arrangement to apply both slots and one overlay")
assert_equal(calls[1], "frame:Terminal:0:0:900:1168", "expected matching arrangement to keep the terminal frame")
assert_equal(calls[8], "inbounds:Presenter:0:1120:1800:48", "expected matching arrangement to keep the overlay in-bounds clamp")
assert_equal(matching.placementSkipped, nil, "expected matching arrangement not to report a placement skip")
assert_equal(count_calls(calls, "raise:"), 3, "expected matching arrangement to keep the raise choreography")

-- Laptop-only screens cannot contain the multi-monitor fixture rects: the
-- guard must skip ALL geometry (all-or-nothing) while bindings resolution,
-- raise, focus, and the rest of the choreography continue.
while #calls > 0 do
  table.remove(calls)
end
local laptop = apply_state.apply(fixture, {
  findWindow = standard_find_window,
  allScreens = function()
    return { make_screen(0, 0, 1512, 982) }
  end,
})

assert_no_geometry_calls(calls, "expected laptop-only arrangement to skip every setFrame call")
assert_equal(count_calls(calls, "raise:Terminal"), 1, "expected laptop-only arrangement to keep the terminal raise")
assert_equal(count_calls(calls, "raise:Slide"), 1, "expected laptop-only arrangement to keep the slide raise")
assert_equal(count_calls(calls, "focus:Terminal"), 1, "expected laptop-only arrangement to keep the stage focus")
assert_equal(laptop.placementSkipped ~= nil, true, "expected laptop-only arrangement to report a placement skip")
assert_equal(laptop.placementSkipped.reason, "display-arrangement-mismatch", "expected the exact placement-skip reason")
assert_equal(#laptop.applied, 0, "expected no sources reported applied when placement is skipped")
assert_equal(#laptop.missing, #matching.missing, "expected the skip not to change missing reporting")
assert_equal(#laptop.resolvedBindings, #matching.resolvedBindings, "expected the skip not to change binding resolution")
for source, binding in pairs(matching.resolvedBindings) do
  local skipped_binding = laptop.resolvedBindings[source]
  assert_equal(skipped_binding ~= nil, true, "expected source " .. source .. " resolved in the skipped run too")
  assert_equal(skipped_binding.macWindowId, binding.macWindowId, "expected the same macWindowId for " .. source)
  assert_equal(skipped_binding.pid, binding.pid, "expected the same pid for " .. source)
end

-- All-or-nothing: a slot that fits but an overlay that does not must still
-- skip every placement call, not leave a half-placed layout.
while #calls > 0 do
  table.remove(calls)
end
local partial = apply_state.apply({
  slots = {
    {
      source = "Terminal",
      position = "left",
      rect = { x = 0, y = 0, w = 900, h = 1168 },
    },
  },
  windowBindings = {
    Terminal = fixture.windowBindings.Terminal,
  },
  managedWindowBindings = {
    Terminal = fixture.windowBindings.Terminal,
    Presenter = fixture.managedWindowBindings.Presenter,
  },
  overlays = {
    {
      source = "Presenter",
      rect = { x = 3440, y = -229, w = 510, h = 700 },
    },
  },
  focus = "Terminal",
}, {
  findWindow = standard_find_window,
  allScreens = function()
    return { make_screen(0, 0, 1800, 1168) }
  end,
})

assert_no_geometry_calls(calls, "expected an off-screen overlay to skip the fitting slot's placement too")
assert_equal(partial.placementSkipped.reason, "display-arrangement-mismatch", "expected the skip reason for the all-or-nothing case")
assert_equal(count_calls(calls, "raise:Terminal"), 1, "expected the all-or-nothing skip to keep the raise choreography")
assert_equal(count_calls(calls, "focus:Terminal"), 1, "expected the all-or-nothing skip to keep the focus choreography")

-- A hidden overlay contributes nothing to the guard: even an out-of-bounds
-- rect on a hidden overlay must not trigger the skip.
local hidden_rect = apply_state.apply({
  slots = fixture.slots,
  overlays = {
    {
      source = "Presenter",
      hidden = true,
      rect = { x = 9999, y = 9999, w = 10, h = 10 },
    },
  },
  windowBindings = fixture.windowBindings,
  managedWindowBindings = fixture.managedWindowBindings,
  focus = fixture.focus,
}, {
  findWindow = standard_find_window,
  allScreens = function()
    return { make_screen(0, 0, 1800, 1168) }
  end,
})

assert_equal(hidden_rect.placementSkipped, nil, "expected a hidden overlay's rect to contribute nothing to the guard")
assert_equal(#hidden_rect.applied, 2, "expected the slots to apply when only the hidden overlay's rect is out of bounds")
assert_equal(count_calls(calls, "minimize:Presenter"), 1, "expected the hidden-overlay minimize choreography to continue")

-- When the arrangement does not match, a hidden overlay must still minimize
-- (the minimize/unminimize choreography is not geometry and must continue).
while #calls > 0 do
  table.remove(calls)
end
local laptop_hidden = apply_state.apply({
  slots = fixture.slots,
  overlays = {
    {
      source = "Presenter",
      hidden = true,
    },
  },
  windowBindings = fixture.windowBindings,
  managedWindowBindings = fixture.managedWindowBindings,
  focus = fixture.focus,
}, {
  findWindow = standard_find_window,
  allScreens = function()
    return { make_screen(0, 0, 1512, 982) }
  end,
})

assert_no_geometry_calls(calls, "expected the laptop-only arrangement to skip geometry with a hidden overlay")
assert_equal(laptop_hidden.placementSkipped.reason, "display-arrangement-mismatch", "expected the skip reason with a hidden overlay")
assert_equal(count_calls(calls, "minimize:Presenter"), 1, "expected the hidden-overlay minimize choreography to continue when skipped")
assert_equal(count_calls(calls, "focus:Terminal"), 1, "expected the stage focus to continue when skipped")

-- On a mismatched arrangement, presenter-side overlays (teleprompter, Console,
-- OBS) must not be brought forward at all: unminimizing or raising them would
-- cover the slot windows the presenter needs to see/capture. The skip gates
-- the overlay's unminimize/raise choreography along with its geometry (a
-- hidden overlay staying minimized here is intentional), while the slot
-- raise/focus choreography continues because the slots are the presentation
-- content.
while #calls > 0 do
  table.remove(calls)
end
local laptop_visible = apply_state.apply(fixture, {
  findWindow = standard_find_window,
  allScreens = function()
    return { make_screen(0, 0, 1512, 982) }
  end,
})

assert_no_geometry_calls(calls, "expected the laptop-only arrangement to skip geometry for the visible overlay")
assert_equal(laptop_visible.placementSkipped.reason, "display-arrangement-mismatch", "expected the skip reason with a visible overlay")
assert_equal(count_calls(calls, "unminimize:Presenter"), 0, "expected the visible overlay NOT to be restored when placement is skipped")
assert_equal(count_calls(calls, "raise:Presenter"), 0, "expected the visible overlay NOT to be raised when placement is skipped")
assert_equal(count_calls(calls, "raise:Terminal"), 1, "expected the slot raise choreography to continue when placement is skipped")
assert_equal(count_calls(calls, "raise:Slide"), 1, "expected the slot raise choreography to continue when placement is skipped")
assert_equal(#laptop_visible.applied, 0, "expected no geometry entries in applied when placement is skipped")
assert_equal(count_calls(calls, "focus:Terminal"), 1, "expected the stage focus to continue with a visible overlay when skipped")

-- Fail-open: deps.allScreens returning nil, throwing, or returning empty or
-- malformed screens must fall back to applying geometry as before.
while #calls > 0 do
  table.remove(calls)
end
local nil_screens = apply_state.apply(fixture, {
  findWindow = standard_find_window,
  allScreens = function()
    return nil
  end,
})

assert_equal(nil_screens.placementSkipped, nil, "expected nil screens to fail open")
assert_equal(calls[1], "frame:Terminal:0:0:900:1168", "expected nil screens to keep applying geometry")

while #calls > 0 do
  table.remove(calls)
end
local throwing_screens = apply_state.apply(fixture, {
  findWindow = standard_find_window,
  allScreens = function()
    error("screen enumeration exploded")
  end,
})

assert_equal(throwing_screens.placementSkipped, nil, "expected a throwing allScreens to fail open")
assert_equal(calls[1], "frame:Terminal:0:0:900:1168", "expected a throwing allScreens to keep applying geometry")

while #calls > 0 do
  table.remove(calls)
end
local empty_screens = apply_state.apply(fixture, {
  findWindow = standard_find_window,
  allScreens = function()
    return {}
  end,
})

assert_equal(empty_screens.placementSkipped, nil, "expected an empty screen list to fail open")
assert_equal(calls[1], "frame:Terminal:0:0:900:1168", "expected an empty screen list to keep applying geometry")

while #calls > 0 do
  table.remove(calls)
end
local malformed_screens = apply_state.apply(fixture, {
  findWindow = standard_find_window,
  allScreens = function()
    return { { }, make_screen(0, 0, 1512, 982) }
  end,
})

assert_equal(malformed_screens.placementSkipped, nil, "expected a screen missing fullFrame to fail open")
assert_equal(calls[1], "frame:Terminal:0:0:900:1168", "expected a screen missing fullFrame to keep applying geometry")

while #calls > 0 do
  table.remove(calls)
end
local throwing_frame_screens = apply_state.apply(fixture, {
  findWindow = standard_find_window,
  allScreens = function()
    return {
      {
        fullFrame = function(_)
          error("fullFrame exploded")
        end,
      },
    }
  end,
})

assert_equal(throwing_frame_screens.placementSkipped, nil, "expected a screen whose fullFrame throws to fail open via the pcall guard")
assert_equal(calls[1], "frame:Terminal:0:0:900:1168", "expected a throwing fullFrame to keep applying geometry")
