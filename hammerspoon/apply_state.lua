local window_match = require("window_match")

local M = {}

local DEFAULT_SETTLE_MAX_ATTEMPTS = 50
local DEFAULT_SETTLE_SLEEP_US = 10000

local function rect_matches(actual, expected, tolerance)
  if actual == nil or expected == nil then
    return false
  end

  local t = tolerance or 1
  return math.abs((actual.x or 0) - expected.x) <= t
    and math.abs((actual.y or 0) - expected.y) <= t
    and math.abs((actual.w or 0) - expected.w) <= t
    and math.abs((actual.h or 0) - expected.h) <= t
end

local function default_sleep()
  if hs and hs.timer and hs.timer.usleep then
    hs.timer.usleep(DEFAULT_SETTLE_SLEEP_US)
  end
end

local function wait_for_window_frame(window, target_rect, source, options)
  if window == nil or target_rect == nil or window.frame == nil then
    return true
  end

  local sleep = options.sleep or default_sleep
  local tolerance = options.frameTolerance or 1
  local max_attempts = options.settleMaxAttempts or DEFAULT_SETTLE_MAX_ATTEMPTS
  local log_fn = options.logFn or function() end
  local actual = nil

  for attempt = 1, max_attempts do
    actual = window:frame()
    if rect_matches(actual, target_rect, tolerance) then
      return true
    end

    if attempt < max_attempts then
      sleep()
    end
  end

  log_fn(string.format(
    "[deckhand:hammerspoon] Window for source %s did not settle to target frame; continuing with last observed frame x=%s y=%s w=%s h=%s",
    tostring(source),
    tostring(actual and actual.x),
    tostring(actual and actual.y),
    tostring(actual and actual.w),
    tostring(actual and actual.h)
  ))
  return false
end

local function exact_binding_for(window, fallback_binding)
  if window == nil or window.id == nil or window.application == nil then
    return nil
  end

  local app = window:application()
  if app == nil or app.pid == nil or app.name == nil then
    return nil
  end

  return {
    app = app:name() or fallback_binding.app,
    pid = app:pid(),
    macWindowId = window:id(),
    strict = true,
  }
end

function M.apply(state, dependencies)
  local deps = dependencies or {}
  local find_window = deps.findWindow or window_match.findWindow
  local log_fn = deps.logFn or function() end
  local make_rect = deps.makeRect or function(rect)
    return hs.geometry.rect(rect.x, rect.y, rect.w, rect.h)
  end

  -- hs.window:setFrame() mis-positions windows placed flush against the bottom
  -- or Dock edge (documented Hammerspoon quirk). setFrameCorrectness makes it
  -- use the reliable three-step resize. Guarded so the Lua contract tests,
  -- which mock `hs` minimally, still run.
  if hs and hs.window and hs.window.setFrameCorrectness ~= nil then
    hs.window.setFrameCorrectness = true
  end

  local resolved = {}
  local applied = {}
  local missing = {}
  local resolved_bindings = {}
  local cleared_bindings = {}
  local binding_catalog = state.managedWindowBindings or state.windowBindings or {}

  for source, binding in pairs(binding_catalog) do
    local window = find_window(binding)
    if window then
      resolved[source] = window

      local exact_binding = exact_binding_for(window, binding)
      if exact_binding ~= nil then
        resolved_bindings[source] = exact_binding
      end
    elseif binding.strict == true and binding.macWindowId ~= nil then
      table.insert(cleared_bindings, source)
    end
  end

  for _, slot in ipairs(state.slots or {}) do
    local binding = state.windowBindings and state.windowBindings[slot.source]
    if binding then
      local window = resolved[slot.source]
      if window and slot.rect then
        local target_rect = make_rect(slot.rect)
        window:setFrame(target_rect)
        wait_for_window_frame(window, target_rect, slot.source, {
          frameTolerance = deps.frameTolerance,
          logFn = log_fn,
          settleMaxAttempts = deps.settleMaxAttempts,
          sleep = deps.sleep,
        })
        table.insert(applied, slot.source)
      else
        table.insert(missing, slot.source)
      end
    end
  end

  for _, slot in ipairs(state.slots or {}) do
    local window = resolved[slot.source]
    if window and window.raise then
      window:raise()
    end
  end

  local focus_source = state.focus
  if focus_source == nil and state.slots and state.slots[1] then
    focus_source = state.slots[1].source
  end

  local focused = nil
  if focus_source ~= nil then
    local target = resolved[focus_source]
    if target then
      target:focus()
      focused = focus_source
    end
  end

  for _, overlay in ipairs(state.overlays or {}) do
    local binding = binding_catalog[overlay.source]
    if binding then
      local window = resolved[overlay.source]
      if window then
        if overlay.hidden == true then
          if window.minimize then
            window:minimize()
          end
        elseif overlay.rect then
          if window.unminimize then
            window:unminimize()
          end
          window:setFrame(make_rect(overlay.rect))
          -- Chrome enforces a minimum window width above the configured overlay
          -- width, and setFrame can mis-position windows flush to an edge; pull
          -- the actual frame fully on-screen so the teleprompter is always
          -- visible regardless. (Overlay windows are presenter-only, never OBS
          -- sources, so clamping them is safe.)
          if window.setFrameInScreenBounds then
            window:setFrameInScreenBounds()
          end
          table.insert(applied, overlay.source)
          if window.raise then
            window:raise()
          end
        end
      else
        table.insert(missing, overlay.source)
      end
    end
  end

  return {
    applied = applied,
    clearedBindings = cleared_bindings,
    focused = focused,
    missing = missing,
    resolvedBindings = resolved_bindings,
  }
end

return M
