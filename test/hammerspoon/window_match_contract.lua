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
