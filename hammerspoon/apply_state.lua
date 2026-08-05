local window_match = require("window_match")

local M = {}

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
        window:setFrame(make_rect(slot.rect))
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
