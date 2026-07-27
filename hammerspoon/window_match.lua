local M = {}

function M.findWindow(binding)
  local app = hs.application.find(binding.app)
  if not app then
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
