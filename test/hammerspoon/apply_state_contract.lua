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

assert_equal(settle_calls[1], "frame:SettlingSlide:0:0:1800:1168", "expected settling slide to be resized first")
assert_equal(settle_calls[2], "readframe:SettlingSlide:100:0:1700:1168", "expected settle check to read intermediate geometry")
assert_equal(settle_calls[3], "readframe:SettlingSlide:40:0:1760:1168", "expected settle check to keep polling until stable")
assert_equal(settle_calls[4], "readframe:SettlingSlide:0:0:1800:1168", "expected settle check to observe the final target geometry")
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
assert_equal(settle_overlay_calls[2], "frame:SettlingPresenter:0:1120:1800:48", "expected settling overlay resized to the overlay rect")
assert_equal(settle_overlay_calls[3], "readframe:SettlingPresenter:0:1000:1800:140", "expected overlay settle check to read intermediate geometry")
assert_equal(settle_overlay_calls[4], "readframe:SettlingPresenter:0:1120:1800:48", "expected overlay settle check to observe the target geometry")
assert_equal(settle_overlay_calls[5], "inbounds:SettlingPresenter:0:1120:1800:48", "expected in-bounds call to pass the intended overlay rect, not the mid-flight frame")
assert_equal(settle_overlay_calls[6], "raise:SettlingPresenter", "expected settling overlay to raise after settling")

-- An overlay window that never reaches the target must still be reported as
-- applied and end with the in-bounds clamp plus raise; the settle wait must
-- log the failure instead of failing silently.
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
assert_equal(stuck_calls[2], "frame:StuckPresenter:0:1120:1800:48", "expected stuck overlay resized to the overlay rect")
assert_equal(stuck_calls[3], "readframe:StuckPresenter:0:900:1800:200", "expected first settle poll to read the wrong frame")
assert_equal(stuck_calls[4], "readframe:StuckPresenter:0:900:1800:200", "expected second settle poll to read the wrong frame")
assert_equal(stuck_calls[5], "readframe:StuckPresenter:0:900:1800:200", "expected third settle poll to read the wrong frame")
assert_equal(stuck_calls[6], "inbounds:StuckPresenter:0:1120:1800:48", "expected in-bounds call to pass the intended overlay rect after settle timeout")
assert_equal(stuck_calls[7], "raise:StuckPresenter", "expected stuck overlay to raise after settle timeout")
assert_equal(#stuck_logs, 1, "expected exactly one settle failure log message")
assert_truthy(string.find(stuck_logs[1], "did not settle", 1, true), "expected the log message to say the overlay did not settle")
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
assert_equal(#stuck_slot_logs, 1, "expected exactly one settle failure log for the stuck slot")
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
