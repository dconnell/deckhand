local window_match = require("window_match")

local M = {}

function M.apply(state, dependencies)
  local deps = dependencies or {}
  local find_window = deps.findWindow or window_match.findWindow
  local make_rect = deps.makeRect or function(rect)
    return hs.geometry.rect(rect.x, rect.y, rect.w, rect.h)
  end
  local resolved = {}
  local applied = {}
  local missing = {}

  for _, slot in ipairs(state.slots or {}) do
    local binding = state.windowBindings and state.windowBindings[slot.source]
    if binding then
      local window = find_window(binding)
      if window and slot.rect then
        window:setFrame(make_rect(slot.rect))
        resolved[slot.source] = window
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
    focused = focused,
    missing = missing,
  }
end

return M
