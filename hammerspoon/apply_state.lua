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

  return {
    applied = applied,
    clearedBindings = cleared_bindings,
    focused = focused,
    missing = missing,
    resolvedBindings = resolved_bindings,
  }
end

return M
