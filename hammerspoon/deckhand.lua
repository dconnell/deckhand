local apply_state = require("apply_state")

local M = {}

local function exact_binding_changed(current, resolved)
  if current == nil then
    return true
  end

  return current.app ~= resolved.app
    or current.pid ~= resolved.pid
    or current.macWindowId ~= resolved.macWindowId
    or current.strict ~= resolved.strict
end

function M.start(options)
  local settings = options or {}
  local websocket_factory = settings.websocketFactory or function(url, callback)
    return hs.websocket.new(url, callback)
  end
  local encode_json = settings.encodeJson or hs.json.encode
  local decode_json = settings.decodeJson or function(message)
    local ok, payload = pcall(hs.json.decode, message)
    if ok then
      return payload
    end

    return nil
  end
  local apply_state_fn = settings.applyStateFn or function(state)
    return apply_state.apply(state, { logFn = log_fn })
  end
  local timer_after = settings.timerAfterFn or hs.timer.doAfter
  local log_fn = settings.logFn or function(message)
    print(message)
  end
  local hub_url = settings.hubUrl or "ws://127.0.0.1:8765"
  local hotkey_bind = settings.hotkeyBindFn or function(modifiers, key, callback)
    return hs.hotkey.bind(modifiers, key, callback)
  end
  local hotkey_modifiers = settings.hotkeyModifiers or { "ctrl", "shift" }
  local next_hotkey_key = settings.nextHotkeyKey or "Right"
  local prev_hotkey_key = settings.prevHotkeyKey or "Left"
  local reconnect_delay_seconds = settings.reconnectDelaySeconds or 1
  local last_seq = 0
  local reconnect_timer = nil
  local next_hotkey = nil
  local prev_hotkey = nil
  local socket = nil
  local stopped = false

  local function stop_reconnect_timer()
    if reconnect_timer and reconnect_timer.stop then
      reconnect_timer:stop()
    end

    reconnect_timer = nil
  end

  local function schedule_reconnect(connect)
    if stopped or reconnect_timer ~= nil then
      return
    end

    reconnect_timer = timer_after(reconnect_delay_seconds, function()
      reconnect_timer = nil
      if not stopped then
        connect()
      end
    end)
  end

  local function connect()
    socket = websocket_factory(hub_url, function(event, message)
      if event == "open" then
        last_seq = 0
        socket:send(encode_json({
          type = "register",
          role = "observer",
          subscriptions = { "presentationState" },
        }), false)
        return
      end

      if event == "received" then
        local payload = decode_json(message)
        if payload == nil or payload.type ~= "presentationState" then
          return
        end

        local seq = tonumber(payload.seq) or 0
        if seq <= last_seq then
          return
        end

        last_seq = seq
        local result = apply_state_fn(payload)
        local current_bindings = payload.managedWindowBindings or payload.windowBindings or {}
        for _, source in ipairs(result and result.missing or {}) do
          log_fn(string.format("[deckhand:hammerspoon] Window not found for source %s", source))
        end

        local bindings = {}
        for source, resolved in pairs(result and result.resolvedBindings or {}) do
          local current = current_bindings[source] or nil
          if exact_binding_changed(current, resolved) then
            bindings[source] = resolved
          end
        end

        local cleared = {}
        for _, source in ipairs(result and result.clearedBindings or {}) do
          local current = current_bindings[source] or nil
          if current and current.strict == true and current.macWindowId ~= nil then
            table.insert(cleared, source)
          end
        end

        if next(bindings) ~= nil or #cleared > 0 then
          socket:send(encode_json({
            type = "windowBindings",
            bindings = bindings,
            cleared = cleared,
          }), false)
        end

        -- Ack that this presentation state's window geometry has been applied.
        -- The coordinator awaits this (by seq) so a slide change never reveals
        -- the audience scene until the physical windows have actually settled,
        -- instead of guessing with a fixed delay.
        -- The ack stays unconditional (fail-open): frameMismatches are
        -- informational (e.g. OBS clamping a configured rect) and never
        -- suppress it.
        local settled = {
          type = "windowSettled",
          seq = seq,
        }
        if result and result.frameMismatches and #result.frameMismatches > 0 then
          settled.frameMismatches = result.frameMismatches
        end
        socket:send(encode_json(settled), false)
        return
      end

      if event == "closed" or event == "fail" then
        schedule_reconnect(connect)
      end
    end)
  end

  local function send_driver_command(command_type)
    if socket == nil then
      return
    end

    socket:send(encode_json({
      type = "driverCommand",
      command = {
        type = command_type,
      },
    }), false)
  end

  next_hotkey = hotkey_bind(hotkey_modifiers, next_hotkey_key, function()
    send_driver_command("next")
  end)
  prev_hotkey = hotkey_bind(hotkey_modifiers, prev_hotkey_key, function()
    send_driver_command("prev")
  end)

  connect()

  return {
    stop = function()
      stopped = true
      stop_reconnect_timer()
      if next_hotkey and next_hotkey.delete then
        next_hotkey:delete()
      end
      if prev_hotkey and prev_hotkey.delete then
        prev_hotkey:delete()
      end
      if socket and socket.close then
        socket:close()
      end
    end,
  }
end

return M
