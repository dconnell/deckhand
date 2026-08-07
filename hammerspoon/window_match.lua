local M = {}

-- Retry policy for exact `macWindowId` lookups. `hs.window.get(id)` is a
-- single-shot lookup against Hammerspoon's internal window cache (driven by
-- `hs.window.filter`), which can transiently miss a window that genuinely
-- exists — most often during Space switches, app focus transitions, or right
-- after a window is created/activated. OBS pins the same window by CGWindowID
-- at the window-server level and is unaffected, so without retries here
-- Hammerspoon can fall through to `windows[1]` and resize the wrong iTerm
-- window (e.g. the operator's OpenCode terminal). Mirrors the poll-until-stable
-- patience the Deckhand side already applies when resolving owned windows at
-- launch (src/ownedWindows.js).
--
-- Defaults stay well inside the coordinator's `windowSettleMs` budget
-- (default 2000ms): 5 attempts × 150ms = 750ms worst case.
M.default_max_attempts = 5
M.default_delay_ms = 150

-- Synchronous sleep used between retry attempts. `hs.timer.usleep` blocks the
-- current Lua coroutine without pumping Hammerspoon's main loop, which is what
-- we want inside the websocket callback that drives `apply_state`. Outside
-- Hammerspoon (e.g. the Lua contract tests) it is nil and the wait is skipped.
local function default_delay_ms(ms)
  if hs and hs.timer and hs.timer.usleep then
    hs.timer.usleep(ms * 1000)
  end
end

local function apps_match(binding, app)
  if binding.app == nil or app == nil or app.name == nil then
    return true
  end

  return app:name() == binding.app
end

local function pids_match(binding, app)
  if binding.pid == nil then
    return true
  end

  if app == nil or app.pid == nil then
    return false
  end

  return app:pid() == binding.pid
end

local function resolve_exact_window(binding, options)
  if binding.macWindowId == nil then
    return nil
  end

  local opts = options or {}
  local get_fn = opts.get_window_fn
  if get_fn == nil then
    if hs == nil or hs.window == nil or hs.window.get == nil then
      return nil
    end
    get_fn = function(id) return hs.window.get(id) end
  end

  local delay_fn = opts.delay_fn or default_delay_ms
  local max_attempts = opts.max_attempts or M.default_max_attempts
  local delay_ms = opts.delay_ms or M.default_delay_ms

  -- Poll `get_fn(macWindowId)` until it returns a window or we exhaust attempts.
  -- `delay_fn` is invoked between attempts (not after the last one) so the
  -- happy path (window known on first call) pays zero wait.
  local window = nil
  for attempt = 1, max_attempts do
    window = get_fn(binding.macWindowId)
    if window ~= nil then
      break
    end
    if attempt < max_attempts then
      delay_fn(delay_ms)
    end
  end

  if window == nil then
    return nil
  end

  local app = window.application and window:application() or nil
  if not apps_match(binding, app) or not pids_match(binding, app) then
    return nil
  end

  return window
end

local function resolve_app(binding)
  if binding.pid ~= nil and hs.application.applicationForPID ~= nil then
    local app = hs.application.applicationForPID(binding.pid)
    if app ~= nil then
      return app
    end
  end

  if hs.application.get ~= nil then
    local app = hs.application.get(binding.app)
    if app ~= nil then
      return app
    end
  end

  return hs.application.find(binding.app)
end

function M.findWindow(binding, options)
  local exact = resolve_exact_window(binding, options)
  if exact ~= nil then
    return exact
  end

  if binding.strict then
    return nil
  end

  local app = resolve_app(binding)
  if app == nil then
    return nil
  end

  local windows = app:allWindows()
  if binding.titleIncludes == nil then
    return windows[1]
  end

  for _, window in ipairs(windows) do
    local title = window:title() or ""
    if string.find(title, binding.titleIncludes, 1, true) then
      return window
    end
  end

  return nil
end

return M
