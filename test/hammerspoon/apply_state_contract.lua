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

local function create_window(name, calls)
  return {
    raise = function(_)
      table.insert(calls, "raise:" .. name)
    end,
    sendToBack = function(_)
      table.insert(calls, "back:" .. name)
    end,
    setFrame = function(_, rect)
      table.insert(calls, string.format("frame:%s:%d:%d:%d:%d", name, rect.x, rect.y, rect.w, rect.h))
    end,
    focus = function(_)
      table.insert(calls, "focus:" .. name)
    end,
  }
end

local calls = {}
local windows = {
  Terminal = create_window("Terminal", calls),
  Slide = create_window("Slide", calls),
}

local result = apply_state.apply(fixture, {
  findWindow = function(binding)
    if binding.app == "iTerm2" then
      return windows.Terminal
    end

    return windows.Slide
  end,
})

assert_equal(#result.applied, 2, "expected both slots to apply")
assert_equal(calls[1], "frame:Terminal:0:0:900:1168", "expected terminal frame first")
assert_equal(calls[2], "frame:Slide:900:0:900:1168", "expected slide frame second")
assert_equal(calls[3], "raise:Terminal", "expected terminal raise after frame")
assert_equal(calls[4], "raise:Slide", "expected slide raise after frame")
assert_equal(calls[5], "focus:Terminal", "expected terminal focus after layout")

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

    return windows.Slide
  end,
})

assert_equal(#full_slide.applied, 1, "expected slide-only layout to apply one source")
assert_equal(calls[1], "frame:Slide:0:0:1800:1168", "expected full-slide frame")
assert_equal(calls[2], "raise:Slide", "expected active slide to be raised")
assert_equal(calls[3], "focus:Slide", "expected full-slide layout to focus the slide window")

local missing = apply_state.apply(fixture, {
  findWindow = function(binding)
    if binding.app == "iTerm2" then
      return windows.Terminal
    end

    return nil
  end,
})

assert_equal(#missing.missing, 1, "expected one missing window")
assert_equal(missing.missing[1], "Slide", "expected missing slide source")

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
