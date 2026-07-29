local M = {}

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

local function resolve_exact_window(binding)
  if binding.macWindowId == nil or hs.window == nil or hs.window.get == nil then
    return nil
  end

  local window = hs.window.get(binding.macWindowId)
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

function M.findWindow(binding)
  local exact = resolve_exact_window(binding)
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
