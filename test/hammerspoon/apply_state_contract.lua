package.path = package.path
  .. ";./hammerspoon/?.lua"
  .. ";./hammerspoon/fixtures/?.lua"

hs = {
  geometry = {
    rect = function(x, y, w, h)
      return { x = x, y = y, w = w, h = h }
    end,
  },
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
    setFrameInScreenBounds = function(_)
      table.insert(calls, "inbounds:" .. name)
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
    setFrameInScreenBounds = function(_)
      table.insert(calls, "inbounds:" .. name)
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
assert_equal(calls[8], "inbounds:Presenter", "expected overlay frame clamped into screen bounds")
assert_equal(calls[9], "raise:Presenter", "expected presenter overlay to raise on top of focused stage")
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
