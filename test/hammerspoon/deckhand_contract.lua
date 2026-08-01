package.path = package.path
  .. ";./hammerspoon/?.lua"
  .. ";./hammerspoon/fixtures/?.lua"

local deckhand = require("deckhand")
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
    return {
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
assert_equal(sockets[1].sent[5].type, "windowBindings", "expected a second report when other managed bindings are first resolved")

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
