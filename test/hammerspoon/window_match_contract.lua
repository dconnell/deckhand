package.path = package.path
  .. ";./hammerspoon/?.lua"

local function assert_equal(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s: expected %s, got %s", message, tostring(expected), tostring(actual)))
  end
end

local function create_app(name, pid, windows)
  return {
    name = function(_)
      return name
    end,
    pid = function(_)
      return pid
    end,
    allWindows = function(_)
      return windows
    end,
  }
end

local function create_window(id, title)
  local app_ref = nil
  local window = {
    id = function(_)
      return id
    end,
    title = function(_)
      return title
    end,
    application = function(_)
      return app_ref
    end,
  }

  return window, function(app)
    app_ref = app
  end
end

local primary, set_primary_app = create_window(4001, "Deckhand BrowserA")
local secondary, set_secondary_app = create_window(4002, "Deckhand BrowserB")
local chrome = create_app("Google Chrome", 47213, { primary, secondary })
set_primary_app(chrome)
set_secondary_app(chrome)

local terminal, set_terminal_app = create_window(5001, "demo — fish")
local iterm2 = create_app("iTerm2", 4321, { terminal })
set_terminal_app(iterm2)

hs = {
  application = {
    applicationForPID = function(pid)
      if pid == 47213 then
        return chrome
      end

      if pid == 4321 then
        return iterm2
      end

      return nil
    end,
    get = function(name)
      if name == "Google Chrome" then
        return chrome
      end

      if name == "iTerm2" then
        return iterm2
      end

      return nil
    end,
    find = function(name)
      if name == "Google Chrome" then
        return chrome
      end

      if name == "iTerm2" then
        return iterm2
      end

      return nil
    end,
  },
  window = {
    get = function(id)
      if id == 4001 then
        return primary
      end

      if id == 4002 then
        return secondary
      end

      if id == 5001 then
        return terminal
      end

      return nil
    end,
  },
}

local window_match = require("window_match")

assert_equal(window_match.findWindow({ app = "Google Chrome", macWindowId = 4002, pid = 47213, strict = true }):id(), 4002, "expected exact window id match")
assert_equal(window_match.findWindow({ app = "Google Chrome", titleIncludes = "Deckhand BrowserA" }):id(), 4001, "expected title fallback match")
assert_equal(window_match.findWindow({ app = "Google Chrome" }):id(), 4001, "expected first window fallback")
assert_equal(window_match.findWindow({ app = "Google Chrome", macWindowId = 9999, pid = 47213, strict = true }), nil, "expected strict stale id to fail closed")
assert_equal(window_match.findWindow({ app = "iTerm2", macWindowId = 5001, pid = 4321, strict = true }):id(), 5001, "expected exact match for owned terminal source")
assert_equal(window_match.findWindow({ app = "iTerm2", macWindowId = 9999, strict = true }), nil, "expected owned source to fail closed on stale id")

-- hs.window.get is a single-shot lookup against Hammerspoon's internal window
-- cache (driven by hs.window.filter), which can transiently miss a window that
-- genuinely exists — most often during Space switches, app focus transitions,
-- or right after a window is created/activated. Without retries the resolver
-- falls through to the frontmost window of the app and resizes the wrong one
-- (e.g. the operator's OpenCode iTerm window). Mirrors the poll-until-stable
-- patience the Deckhand side already applies when resolving owned windows at
-- launch (src/ownedWindows.js).
do
  local transient_nil_count = 3
  local get_calls = 0
  local function counting_get(_)
    get_calls = get_calls + 1
    if get_calls <= transient_nil_count then
      return nil
    end
    return terminal
  end

  local delay_calls = 0
  local function counting_delay(_)
    delay_calls = delay_calls + 1
  end

  local result = window_match.findWindow(
    { app = "iTerm2", macWindowId = 5001, pid = 4321, strict = true },
    { get_window_fn = counting_get, delay_fn = counting_delay, max_attempts = 5, delay_ms = 1 }
  )

  assert_equal(result:id(), 5001, "expected retry to recover transient nil from hs.window.get")
  assert_equal(get_calls, transient_nil_count + 1, "expected one get call per attempt until success")
  assert_equal(delay_calls, transient_nil_count, "expected one delay call between each attempt before success")
end

-- When the window genuinely does not exist (every attempt returns nil), the
-- resolver must exhaust retries before giving up, and strict callers must still
-- fail closed rather than fall through to the frontmost-window fallback.
do
  local get_calls = 0
  local function always_nil(_)
    get_calls = get_calls + 1
    return nil
  end

  local delay_calls = 0
  local function counting_delay(_)
    delay_calls = delay_calls + 1
  end

  local result = window_match.findWindow(
    { app = "iTerm2", macWindowId = 5001, pid = 4321, strict = true },
    { get_window_fn = always_nil, delay_fn = counting_delay, max_attempts = 4, delay_ms = 1 }
  )

  assert_equal(result, nil, "expected nil after exhausting retries on a strict binding")
  assert_equal(get_calls, 4, "expected get to be called once per attempt")
  assert_equal(delay_calls, 3, "expected delay between attempts but not after the last")
end
