package.path = package.path
  .. ";./hammerspoon/?.lua"
  .. ";./hammerspoon/fixtures/?.lua"

-- Regression stub: deckhand must forward its log function to apply_state.
-- The stub is installed before deckhand is required so deckhand's module-level
-- `apply_state` binding captures it; the recorded deps are asserted at the
-- bottom of this file. Every existing test below injects applyStateFn, so the
-- stub's apply is never called by them.
local apply_state_deps_received = {}
local real_apply_state = package.loaded["apply_state"]
package.loaded["apply_state"] = {
  apply = function(_, deps)
    table.insert(apply_state_deps_received, deps)
    return { missing = {}, resolvedBindings = {}, clearedBindings = {} }
  end,
}

local deckhand = require("deckhand")
package.loaded["apply_state"] = real_apply_state
local fixture = require("presentation_state")

local function assert_equal(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s: expected %s, got %s", message, tostring(expected), tostring(actual)))
  end
end

local function clone_state(state)
  local copy = {}
  for key, value in pairs(state) do
    copy[key] = value
  end
  return copy
end

local apply_calls = {}
local sockets = {}
local connect_count = 0
local hotkey_bindings = {}

local function apply_result_for(state)
  local result = {
    missing = {},
    resolvedBindings = {
      Slide = {
        app = "Safari",
        pid = 2002,
        macWindowId = 4002,
        strict = true,
      },
      BrowserA = {
        app = "Google Chrome",
        pid = 47213,
        macWindowId = 4003,
        strict = true,
      },
      BrowserB = {
        app = "Google Chrome",
        pid = 47213,
        macWindowId = 4004,
        strict = true,
      },
    },
    clearedBindings = {},
  }

  -- OBS-style clamped window: only the second apply reports a mismatch so the
  -- test can assert the windowSettled ack carries it verbatim, and a clean
  -- apply omits the field entirely.
  if state.seq == 8 then
    result.frameMismatches = {
      {
        source = "Presenter",
        requested = { x = 0, y = 1120, w = 1800, h = 560 },
        observed = { x = 0, y = 900, w = 1800, h = 611 },
      },
    }
  end

  return result
end

local function websocket_factory(url, callback)
  connect_count = connect_count + 1
  local socket = {
    callback = callback,
    url = url,
    sent = {},
    closed = false,
  }

  function socket:send(payload)
    table.insert(self.sent, payload)
  end

  function socket:close()
    self.closed = true
  end

  table.insert(sockets, socket)
  return socket
end

local controller = deckhand.start({
  applyStateFn = function(state)
    table.insert(apply_calls, state.seq)
    return apply_result_for(state)
  end,
  decodeJson = function(message)
    return message
  end,
  encodeJson = function(payload)
    return payload
  end,
  hubUrl = "ws://127.0.0.1:8765",
  reconnectDelaySeconds = 0,
  timerAfterFn = function(_, callback)
    callback()
    return {
      stop = function() end,
    }
  end,
  hotkeyBindFn = function(modifiers, key, callback)
    local binding = {
      modifiers = modifiers,
      key = key,
      callback = callback,
      deleted = false,
    }

    function binding:delete()
      self.deleted = true
    end

    table.insert(hotkey_bindings, binding)
    return binding
  end,
  websocketFactory = websocket_factory,
})

assert_equal(connect_count, 1, "expected initial websocket connect")
sockets[1].callback("open", nil)
assert_equal(sockets[1].sent[1].type, "register", "expected register message on open")
assert_equal(hotkey_bindings[1].key, "Right", "expected next hotkey binding")
assert_equal(hotkey_bindings[2].key, "Left", "expected prev hotkey binding")

hotkey_bindings[1].callback()
assert_equal(sockets[1].sent[2].type, "driverCommand", "expected next hotkey to send driverCommand")
assert_equal(sockets[1].sent[2].command.type, "next", "expected next hotkey command payload")

hotkey_bindings[2].callback()
assert_equal(sockets[1].sent[3].type, "driverCommand", "expected prev hotkey to send driverCommand")
assert_equal(sockets[1].sent[3].command.type, "prev", "expected prev hotkey command payload")

sockets[1].callback("received", fixture)
sockets[1].callback("received", clone_state({
  type = "presentationState",
  seq = 8,
  slideId = fixture.slideId,
  layoutId = fixture.layoutId,
  audienceScene = fixture.audienceScene,
  slots = fixture.slots,
  windowBindings = {
    Terminal = fixture.windowBindings.Terminal,
    Slide = {
      app = "Safari",
      titleIncludes = fixture.windowBindings.Slide.titleIncludes,
      pid = 2002,
      macWindowId = 4002,
      strict = true,
    },
  },
  focus = fixture.focus,
  script = fixture.script,
}))
sockets[1].callback("received", clone_state({
  type = "presentationState",
  seq = 6,
  slideId = fixture.slideId,
  layoutId = fixture.layoutId,
  audienceScene = fixture.audienceScene,
  slots = fixture.slots,
  windowBindings = fixture.windowBindings,
  focus = fixture.focus,
  script = fixture.script,
}))

assert_equal(#apply_calls, 2, "expected newer exact-binding state to apply before stale state is ignored")
assert_equal(sockets[1].sent[4].type, "windowBindings", "expected exact window bindings to be reported")
assert_equal(sockets[1].sent[4].bindings.Slide.macWindowId, 4002, "expected slide macWindowId in report")
assert_equal(sockets[1].sent[4].bindings.Slide.pid, 2002, "expected slide pid in report")
assert_equal(sockets[1].sent[4].cleared[1], nil, "expected no cleared bindings in initial report")
assert_equal(sockets[1].sent[5].type, "windowSettled", "expected window-settled ack after applying state")
assert_equal(sockets[1].sent[5].seq, 7, "expected window-settled ack to echo the applied seq")
assert_equal(sockets[1].sent[5].frameMismatches, nil, "expected a clean apply to omit frameMismatches from the ack")
assert_equal(sockets[1].sent[6].type, "windowBindings", "expected a second report when other managed bindings are first resolved")
assert_equal(sockets[1].sent[7].type, "windowSettled", "expected window-settled ack for the second applied state")
assert_equal(sockets[1].sent[7].seq, 8, "expected second window-settled ack to echo the applied seq")
assert_equal(sockets[1].sent[7].frameMismatches[1].source, "Presenter", "expected the ack to carry the mismatch source")
assert_equal(sockets[1].sent[7].frameMismatches[1].requested.h, 560, "expected the ack to carry the requested rect verbatim")
assert_equal(sockets[1].sent[7].frameMismatches[1].observed.h, 611, "expected the ack to carry the observed rect verbatim")

sockets[1].callback("closed", "server restart")
assert_equal(connect_count, 2, "expected reconnect after close")
sockets[2].callback("open", nil)

local reconnect_state = clone_state(fixture)
reconnect_state.seq = 1
sockets[2].callback("received", reconnect_state)

assert_equal(#apply_calls, 3, "expected lower seq after reconnect to be accepted")
assert_equal(apply_calls[3], 1, "expected reconnect state seq to be applied")

controller.stop()
assert_equal(sockets[2].closed, true, "expected stop() to close the websocket")
assert_equal(hotkey_bindings[1].deleted, true, "expected next hotkey binding cleanup")
assert_equal(hotkey_bindings[2].deleted, true, "expected prev hotkey binding cleanup")

-- ---------------------------------------------------------------------------
-- Placement-skip reporting: when apply reports placementSkipped, the ack must
-- carry it and the warning must be logged once per hub connection (not once
-- per presentationState).
-- ---------------------------------------------------------------------------

local skip_apply_calls = {}
local skip_sockets = {}
local skip_logs = {}
local skip_hotkeys = {}

local function skip_websocket_factory(url, callback)
  local socket = {
    callback = callback,
    url = url,
    sent = {},
    closed = false,
  }

  function socket:send(payload)
    table.insert(self.sent, payload)
  end

  function socket:close()
    self.closed = true
  end

  table.insert(skip_sockets, socket)
  return socket
end

local skip_controller = deckhand.start({
  applyStateFn = function(state)
    table.insert(skip_apply_calls, state.seq)
    return {
      applied = {},
      missing = {},
      resolvedBindings = {},
      clearedBindings = {},
      placementSkipped = { reason = "display-arrangement-mismatch" },
    }
  end,
  decodeJson = function(message)
    return message
  end,
  encodeJson = function(payload)
    return payload
  end,
  hubUrl = "ws://127.0.0.1:8765",
  logFn = function(message)
    table.insert(skip_logs, message)
  end,
  reconnectDelaySeconds = 0,
  timerAfterFn = function(_, callback)
    callback()
    return {
      stop = function() end,
    }
  end,
  hotkeyBindFn = function(_, _, callback)
    local binding = { callback = callback, deleted = false }

    function binding:delete()
      self.deleted = true
    end

    table.insert(skip_hotkeys, binding)
    return binding
  end,
  websocketFactory = skip_websocket_factory,
})

skip_sockets[1].callback("open", nil)

local skip_state_one = clone_state(fixture)
skip_state_one.seq = 7
local skip_state_two = clone_state(fixture)
skip_state_two.seq = 8
skip_sockets[1].callback("received", skip_state_one)
skip_sockets[1].callback("received", skip_state_two)

assert_equal(#skip_apply_calls, 2, "expected both presentation states to be applied")

local skip_acks = {}
for _, payload in ipairs(skip_sockets[1].sent) do
  if payload.type == "windowSettled" then
    table.insert(skip_acks, payload)
  end
end

assert_equal(#skip_acks, 2, "expected an ack per presentation state")
assert_equal(skip_acks[1].placementSkipped ~= nil, true, "expected the ack to carry placementSkipped")
assert_equal(skip_acks[1].placementSkipped.reason, "display-arrangement-mismatch", "expected the ack to carry the exact skip reason")
assert_equal(skip_acks[2].placementSkipped.reason, "display-arrangement-mismatch", "expected every ack to carry the skip")

local skip_warnings = {}
for _, message in ipairs(skip_logs) do
  if string.find(message, "skipping window placement", 1, true) then
    table.insert(skip_warnings, message)
  end
end

assert_equal(#skip_warnings, 1, "expected exactly one placement-skip warning per hub connection")

-- A reconnect starts a new hub connection, so the warning must be logged once
-- again on the fresh connection.
skip_sockets[1].callback("closed", "server restart")
skip_sockets[2].callback("open", nil)
local skip_state_three = clone_state(fixture)
skip_state_three.seq = 9
skip_sockets[2].callback("received", skip_state_three)

local reconnect_warnings = {}
for _, message in ipairs(skip_logs) do
  if string.find(message, "skipping window placement", 1, true) then
    table.insert(reconnect_warnings, message)
  end
end

assert_equal(#reconnect_warnings, 2, "expected the warning once per hub connection, not once per process")

skip_controller.stop()
assert_equal(skip_sockets[2].closed, true, "expected stop() to close the placement-skip websocket")

-- ---------------------------------------------------------------------------
-- Regression: without an injected applyStateFn, the default closure must pass
-- a non-nil logFn to apply_state. A mis-scoped local previously captured the
-- global log_fn (nil in production), so the no-op fallback inside apply_state
-- swallowed the settle-failure logs and the slide-actions summary.
-- ---------------------------------------------------------------------------

local default_socket = nil
local function default_socket_factory(url, callback)
  local socket = {
    callback = callback,
    url = url,
    sent = {},
    closed = false,
  }

  function socket:send(payload)
    table.insert(self.sent, payload)
  end

  function socket:close()
    self.closed = true
  end

  default_socket = socket
  return socket
end

local default_controller = deckhand.start({
  decodeJson = function(message)
    return message
  end,
  encodeJson = function(payload)
    return payload
  end,
  hubUrl = "ws://127.0.0.1:8765",
  reconnectDelaySeconds = 0,
  timerAfterFn = function(_, callback)
    callback()
    return {
      stop = function() end,
    }
  end,
  hotkeyBindFn = function(_, _, callback)
    return {
      delete = function() end,
    }
  end,
  websocketFactory = default_socket_factory,
})

default_socket.callback("open", nil)
default_socket.callback("received", clone_state(fixture))

assert_equal(#apply_state_deps_received, 1, "expected the default apply path to call the required apply_state module")
assert_equal(apply_state_deps_received[1].logFn ~= nil, true, "expected apply_state to receive a non-nil logFn")

default_controller.stop()
assert_equal(default_socket.closed, true, "expected stop() to close the default-apply websocket")
