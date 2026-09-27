local window_match = require("window_match")

local M = {}

-- Sticky per-window memory of geometry a window provably cannot reach:
-- macOS/Chrome can refuse a target rect and park the window at a stable
-- achievable frame forever, and re-issuing setFrame on every apply only
-- shakes it. Keyed by window id, each entry remembers the attempted target
-- and the frame the window actually settled on, so a later apply that sees
-- the same target and the same parked frame skips the geometry entirely.
-- Only FAILED settles are remembered: a settled window's next pre-check
-- matches the target anyway and never consults the memory.
local frame_attempt_memory = {}

-- Test hook: the memory is module state that persists across applies in a
-- live Hammerspoon session, so the Lua contract tests must be able to clear
-- it between scenario blocks (mirroring how their calls tables are cleared).
M.reset_frame_memory = function()
  frame_attempt_memory = {}
end

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

-- Exact rect equality for the frame memory's target key: a changed layout
-- target must invalidate the remembered parked frame.
local function same_rect(a, b)
  if a == nil or b == nil then
    return false
  end

  return (a.x or 0) == (b.x or 0)
    and (a.y or 0) == (b.y or 0)
    and (a.w or 0) == (b.w or 0)
    and (a.h or 0) == (b.h or 0)
end

local function default_sleep()
  if hs and hs.timer and hs.timer.usleep then
    hs.timer.usleep(DEFAULT_SETTLE_SLEEP_US)
  end
end

-- Default screen enumeration for the placement guard: pcall-guarded so a
-- missing hs.screen module (Lua contract tests) or a Hammerspoon hiccup both
-- read as "screens unknown" instead of raising.
local function default_all_screens()
  if hs == nil or hs.screen == nil or hs.screen.allScreens == nil then
    return nil
  end

  local ok, screens = pcall(hs.screen.allScreens)
  if not ok or type(screens) ~= "table" then
    return nil
  end

  return screens
end

-- Default front-to-back window enumeration for the steady-state skip:
-- pcall-guarded so a missing hs.window module (Lua contract tests) or a
-- Hammerspoon hiccup both read as "stacking unknown" instead of raising,
-- matching the fail-open posture of default_all_screens.
local function default_ordered_windows()
  if hs == nil or hs.window == nil or hs.window.orderedWindows == nil then
    return nil
  end

  local ok, windows = pcall(hs.window.orderedWindows)
  if not ok or type(windows) ~= "table" then
    return nil
  end

  return windows
end

-- Reads a screen's full frame (true edges, not the menu-bar/Dock-inset frame:
-- configured rects deliberately use edges like y=-229 above a menu-bar-less
-- monitor). Returns nil for anything unmockable or malformed so callers can
-- fail open.
local function screen_full_frame(screen)
  if screen == nil then
    return nil
  end

  -- No type(screen) branch: real Hammerspoon screen objects are userdata,
  -- which plain-lua contract tests cannot fake, so tables and userdata must
  -- take the single colon-call path below. The frame check stays table-typed
  -- because hs.geometry rects are pure-Lua tables.
  local ok, frame = pcall(function()
    return screen:fullFrame()
  end)
  if not ok or type(frame) ~= "table" then
    return nil
  end

  return frame
end

-- Collects every configured rect that the guard would apply geometry for:
-- all slot rects plus visible-overlay rects. Hidden overlays contribute
-- nothing (they are minimized, never placed).
local function configured_rects(state)
  local rects = {}

  for _, slot in ipairs(state.slots or {}) do
    if slot.rect ~= nil then
      table.insert(rects, slot.rect)
    end
  end

  for _, overlay in ipairs(state.overlays or {}) do
    if overlay.rect ~= nil and overlay.hidden ~= true then
      table.insert(rects, overlay.rect)
    end
  end

  return rects
end

-- The placement guard, all-or-nothing: geometry may proceed only when every
-- configured rect fits inside the union bounding box of the current screens'
-- full frames. Fail-open whenever screens cannot be enumerated (no module,
-- threw, empty, or a malformed screen) so placement behaves exactly as before
-- the guard existed. Returns false only when screens are known AND at least
-- one configured rect falls outside them, because a half-placed layout (stage
-- windows moved, overlays dumped wherever macOS likes) is worse than leaving
-- every window untouched.
local function placement_allowed(state, screens)
  if type(screens) ~= "table" then
    return true
  end

  local frames = {}
  for _, screen in ipairs(screens) do
    local frame = screen_full_frame(screen)
    if frame == nil then
      return true
    end

    table.insert(frames, frame)
  end

  if #frames == 0 then
    return true
  end

  local rects = configured_rects(state)
  if #rects == 0 then
    return true
  end

  local min_x, min_y, max_x, max_y
  for _, frame in ipairs(frames) do
    local left = frame.x or 0
    local top = frame.y or 0
    local right = left + (frame.w or 0)
    local bottom = top + (frame.h or 0)

    if min_x == nil or left < min_x then
      min_x = left
    end
    if min_y == nil or top < min_y then
      min_y = top
    end
    if max_x == nil or right > max_x then
      max_x = right
    end
    if max_y == nil or bottom > max_y then
      max_y = bottom
    end
  end

  for _, rect in ipairs(rects) do
    local left = rect.x or 0
    local top = rect.y or 0
    -- Edges inclusive: a rect flush with the union bbox counts as inside.
    if left < min_x or top < min_y or (left + (rect.w or 0)) > max_x or (top + (rect.h or 0)) > max_y then
      return false
    end
  end

  return true
end

-- Polls until the window reports the target frame. Returns nil when the window
-- settled (or the wait was skipped for an unmockable/missing window); returns
-- the last observed frame as a plain { x, y, w, h } table when the window gave
-- up, so callers can surface the mismatch to the coordinator.
local function wait_for_window_frame(window, target_rect, source, options)
  if window == nil or target_rect == nil or window.frame == nil then
    return nil
  end

  local sleep = options.sleep or default_sleep
  local tolerance = options.frameTolerance or 1
  local max_attempts = options.settleMaxAttempts or DEFAULT_SETTLE_MAX_ATTEMPTS
  local log_fn = options.logFn or function() end
  local actual = nil

  for attempt = 1, max_attempts do
    actual = window:frame()
    if rect_matches(actual, target_rect, tolerance) then
      return nil
    end

    if attempt < max_attempts then
      sleep()
    end
  end

  log_fn(string.format(
    "[deckhand:hammerspoon] Window for source %s did not settle to target frame x=%s y=%s w=%s h=%s; continuing with observed x=%s y=%s w=%s h=%s",
    tostring(source),
    tostring(target_rect.x),
    tostring(target_rect.y),
    tostring(target_rect.w),
    tostring(target_rect.h),
    tostring(actual and actual.x),
    tostring(actual and actual.y),
    tostring(actual and actual.w),
    tostring(actual and actual.h)
  ))
  if actual == nil then
    return nil
  end

  return { x = actual.x, y = actual.y, w = actual.w, h = actual.h }
end

-- Fail-open id read: a missing or throwing id() (or a nil window) reads as
-- "no id", which callers treat as "skip the id-keyed logic" instead of raising.
local function read_window_id(window)
  if window == nil then
    return nil
  end

  local ok, id = pcall(function()
    return window:id()
  end)
  if not ok or id == nil then
    return nil
  end

  return id
end

-- Default system focused-window lookup for the focus-probe fallback:
-- pcall-guarded so a missing hs.window module (Lua contract tests) or a
-- Hammerspoon hiccup both read as "fallback unavailable" instead of raising.
local function default_focused_window()
  if hs == nil or hs.window == nil or hs.window.focusedWindow == nil then
    return nil
  end

  local ok, window = pcall(hs.window.focusedWindow)
  if not ok then
    return nil
  end

  return window
end

-- Records a give-up as a plain-table mismatch entry; the requested rect is
-- flattened because hs.geometry objects carry extra table parts the JSON
-- encoder would serialize.
local function record_frame_mismatch(frame_mismatches, source, target_rect, observed)
  if observed == nil then
    return
  end

  table.insert(frame_mismatches, {
    source = source,
    requested = { x = target_rect.x, y = target_rect.y, w = target_rect.w, h = target_rect.h },
    observed = { x = observed.x, y = observed.y, w = observed.w, h = observed.h },
  })
end

-- One window's geometry attempt, shared by the slot and overlay paths and
-- guarded by the sticky frame memory: a window that provably cannot reach its
-- target (macOS/Chrome refuse the rect) parks at a stable achievable frame,
-- and re-framing it on every apply only shakes it. When the remembered target
-- still matches and the window still sits at the remembered parked frame, the
-- whole attempt (setFrame, settle wait, mismatch report, framed action) is
-- skipped; when anything changed (target moved, window dragged) the stale
-- memory is cleared and the attempt reruns, storing a fresh entry on failure.
-- Returns true when a real attempt ran, false when the sticky skip engaged.
local function attempt_frame(window, target_rect, source, current_frame, actions, frame_mismatches, deps, log_fn)
  local id = read_window_id(window)
  local remembered = id ~= nil and frame_attempt_memory[id] or nil
  if remembered ~= nil
    and same_rect(remembered.target, target_rect)
    and rect_matches(current_frame, remembered.observed, deps.frameTolerance or 1) then
    return false
  end

  if id ~= nil then
    frame_attempt_memory[id] = nil
  end

  window:setFrame(target_rect)
  table.insert(actions, "framed " .. source)
  local observed = wait_for_window_frame(window, target_rect, source, {
    frameTolerance = deps.frameTolerance,
    logFn = log_fn,
    settleMaxAttempts = deps.settleMaxAttempts,
    sleep = deps.sleep,
  })
  if observed ~= nil then
    record_frame_mismatch(frame_mismatches, source, target_rect, observed)
    if id ~= nil then
      frame_attempt_memory[id] = {
        target = { x = target_rect.x, y = target_rect.y, w = target_rect.w, h = target_rect.h },
        observed = observed,
      }
    end
  end

  return true
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

-- Builds the desired front-to-back cast for a slide: visible overlays in
-- reverse list order (last listed = frontmost, the raise loop's effect), then
-- the focus source, then the remaining slots in reverse list order. Hidden
-- overlays are minimized, never raised, so they are not part of the cast.
-- Returns the cast entries (source, window, id) plus the focus target's
-- index inside the sequence, or nil when any window's id cannot be read so
-- the caller fails open instead of skipping on partial information.
local function desired_cast(state, resolved, focus_source)
  local list = {}
  local focus_index = nil
  local readable = true

  local function append(source)
    local window = resolved[source]
    if window == nil then
      return nil
    end

    local ok, id = pcall(function()
      return window:id()
    end)
    if not ok or id == nil then
      readable = false
      return nil
    end

    local entry = { source = source, window = window, id = id }
    table.insert(list, entry)
    return entry
  end

  for i = #(state.overlays or {}), 1, -1 do
    local overlay = state.overlays[i]
    if overlay.hidden ~= true then
      append(overlay.source)
    end
  end

  if focus_source ~= nil and append(focus_source) ~= nil then
    focus_index = #list
  end

  for i = #(state.slots or {}), 1, -1 do
    local slot = state.slots[i]
    if slot.source ~= focus_source then
      append(slot.source)
    end
  end

  if not readable then
    return nil, nil
  end

  local ids = {}
  for _, entry in ipairs(list) do
    table.insert(ids, entry.id)
  end

  return { list = list, ids = ids }, focus_index
end

-- Reads ids from the current front-to-back window list. One misbehaving
-- window (a throwing id, an unreadable id, a non-window entry) makes the
-- whole reading uncertain, so the entire read fails to nil and the caller
-- runs the choreography instead of skipping on partial information.
local function current_stacking_ids(ordered_windows)
  if type(ordered_windows) ~= "table" then
    return nil
  end

  local ids = {}
  for _, window in ipairs(ordered_windows) do
    local ok, id = pcall(function()
      return window:id()
    end)
    if not ok or id == nil then
      return nil
    end

    table.insert(ids, id)
  end

  return ids
end

-- pcall-guarded frame read matching the placement guard's fail-open posture:
-- a missing method, a throw, or a malformed frame all read as unknown (nil).
local function read_window_frame(window)
  if window == nil or window.frame == nil then
    return nil
  end

  local ok, frame = pcall(window.frame, window)
  if not ok or type(frame) ~= "table" then
    return nil
  end

  return frame
end

-- Strict rect overlap: sharing only an edge (or corner) does not count, so a
-- window flush against the stage is not covering it.
local function rects_intersect(a, b)
  local ax = a.x or 0
  local ay = a.y or 0
  local bx = b.x or 0
  local by = b.y or 0
  return ax < bx + (b.w or 0)
    and bx < ax + (a.w or 0)
    and ay < by + (b.h or 0)
    and by < ay + (a.h or 0)
end

-- The current front-to-back order restricted to the cast's windows, mapped
-- back to source names for the mismatch diagnostic. Returns nil when any cast
-- id is missing from the current order entirely: that window would be left
-- wherever it is, so the caller must fail open to the full choreography.
local function observed_cast_sources(current_ids, cast)
  if type(current_ids) ~= "table" or type(cast) ~= "table" then
    return nil
  end

  local source_by_id = {}
  for _, entry in ipairs(cast.list) do
    source_by_id[entry.id] = entry.source
  end

  local observed = {}
  for _, id in ipairs(current_ids) do
    if source_by_id[id] ~= nil then
      table.insert(observed, source_by_id[id])
    end
  end

  if #observed < #cast.list then
    return nil
  end

  return observed
end

-- Cast relative order, overlap-aware. On a multi-display setup the cast
-- windows mostly live on different displays and do not overlap each other, so
-- their relative z-order is cosmetically irrelevant — macOS's merged window
-- order just never reproduces the desired sequence, and re-stacking for those
-- cosmetic inversions flashed the deck on every slide navigation. The
-- observed order is therefore "correct" when NO overlapping pair is inverted:
-- for a pair the desired order puts a ABOVE b (a earlier in the cast), a
-- violation exists only when a and b's frames strictly intersect
-- (edge-sharing excluded, same rule as the interference check) AND a sits
-- below b in the current front-to-back ids. Non-overlapping pairs accept any
-- relative order, so this is strictly more permissive than the old strict
-- subsequence-equality check, never less. Fail open: an unreadable cast frame
-- (via the same pcall'd read the interference check uses) makes that window's
-- pairs count as overlapping so its order stays enforced, and a missing
-- position (a cast id absent from the current order — normally caught first
-- by observed_cast_sources) counts as inverted. Returns true when an
-- inverted overlapping pair exists, i.e. the caller must re-stack.
local function cast_order_conflicts(current_ids, cast)
  if type(current_ids) ~= "table" or type(cast) ~= "table" then
    return true
  end

  -- Fewer than two cast windows have no pair that could be inverted.
  if #cast.list < 2 then
    return false
  end

  local position = {}
  for index, id in ipairs(current_ids) do
    position[id] = index
  end

  local frames = {}
  for _, entry in ipairs(cast.list) do
    frames[entry.id] = read_window_frame(entry.window)
  end

  for i = 1, #cast.list do
    local above = cast.list[i]
    for j = i + 1, #cast.list do
      local below = cast.list[j]
      local frame_above = frames[above.id]
      local frame_below = frames[below.id]
      -- An unreadable frame on either side reads as overlapping: the pair's
      -- order stays enforced rather than trusted on unknown geometry.
      local overlaps = frame_above == nil or frame_below == nil
        or rects_intersect(frame_above, frame_below)
      local above_position = position[above.id]
      local below_position = position[below.id]
      if overlaps and (above_position == nil or below_position == nil or above_position > below_position) then
        return true
      end
    end
  end

  return false
end

-- Overlap-aware interference: a foreign window only matters when it sits
-- ABOVE a cast window in the front-to-back z-order AND its frame strictly
-- intersects that cast window's frame — i.e. it is actually covering part of
-- the stage. A benign window higher in the global z-order but on another
-- display (or another non-overlapping region) must be ignored, or the strict
-- top-of-z-order posture would run the flash-inducing raise cycle on every
-- apply in multi-display setups. Fail open: an unreadable id, an unknown
-- frame on a foreign window, or an unreadable frame on a cast window all
-- read as interference so an uncertain stage is always re-stacked.
local function cast_interference(ordered_windows, cast)
  if type(ordered_windows) ~= "table" then
    return true
  end

  local cast_ids = {}
  for _, entry in ipairs(cast.list) do
    cast_ids[entry.id] = true
  end

  -- Walk BACK to front remembering cast frames seen so far: a foreign window
  -- encountered now sits ABOVE exactly those cast windows, so only they can
  -- be covered by it.
  local cast_frames_below = {}
  for i = #ordered_windows, 1, -1 do
    local window = ordered_windows[i]
    local ok, id = pcall(function()
      return window:id()
    end)
    if not ok or id == nil then
      return true
    end

    local frame = read_window_frame(window)
    if frame == nil then
      return true
    end

    if cast_ids[id] then
      table.insert(cast_frames_below, frame)
    else
      for _, cast_frame in ipairs(cast_frames_below) do
        if rects_intersect(frame, cast_frame) then
          return true
        end
      end
    end
  end

  return false
end

-- Reads a window's minimized state; nil when isMinimized is missing or
-- throws, so each caller can fail open in its own direction (a hidden
-- overlay minimizes anyway, a visible overlay unminimizes anyway).
local function minimized_state(window)
  if window == nil or window.isMinimized == nil then
    return nil
  end

  local ok, minimized = pcall(window.isMinimized, window)
  if not ok then
    return nil
  end

  return minimized == true
end

function M.apply(state, dependencies)
  local deps = dependencies or {}
  local find_window = deps.findWindow or window_match.findWindow
  local log_fn = deps.logFn or function() end
  local make_rect = deps.makeRect or function(rect)
    return hs.geometry.rect(rect.x, rect.y, rect.w, rect.h)
  end
  local all_screens = deps.allScreens or default_all_screens
  local ordered_windows = deps.orderedWindows or default_ordered_windows

  -- hs.window:setFrame() mis-positions windows placed flush against the bottom
  -- or Dock edge (documented Hammerspoon quirk). setFrameCorrectness makes it
  -- use the reliable three-step resize. Guarded so the Lua contract tests,
  -- which mock `hs` minimally, still run.
  if hs and hs.window and hs.window.setFrameCorrectness ~= nil then
    hs.window.setFrameCorrectness = true
  end

  -- Zero Hammerspoon's window animation (default 0.2s) so setFrame applies
  -- geometry immediately and deterministically: with animation enabled the
  -- settle wait below would read intermediate geometry mid-flight and never
  -- observe the target frame. Guarded so the Lua contract tests, which mock
  -- `hs` minimally, still run.
  if hs and hs.window and hs.window.animationDuration ~= nil then
    hs.window.animationDuration = 0
  end

  local resolved = {}
  local applied = {}
  local missing = {}
  local resolved_bindings = {}
  local cleared_bindings = {}
  local frame_mismatches = {}
  -- Real actions taken this apply, in execution order, for the one-line
  -- summary emitted after actuation (the live-setup diagnostic hook).
  local actions = {}
  local binding_catalog = state.managedWindowBindings or state.windowBindings or {}

  -- Screen enumeration is evaluated once per apply; a throw from an injected
  -- enumerator fails open exactly like the guarded default.
  local ok_screens, screens = pcall(all_screens)
  if not ok_screens then
    screens = nil
  end

  local placement_skipped = nil
  if not placement_allowed(state, screens) then
    placement_skipped = { reason = "display-arrangement-mismatch" }
  end

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
        -- Arrangement-mismatch skip: leave geometry untouched (all-or-nothing
        -- with the overlays), keeping bindings/raise/focus choreography.
        if placement_skipped == nil then
          local target_rect = make_rect(slot.rect)
          -- Re-applying identical geometry on every slide navigation makes an
          -- already-placed window visibly shake (setFrame with
          -- setFrameCorrectness is a multi-step resize), so skip the whole
          -- geometry pass when the window already reports the target rect
          -- within the settle tolerance. A missing frame method (unmockable
          -- window) fails open to the original always-apply behavior.
          local current_frame = nil
          if window.frame ~= nil then
            current_frame = window:frame()
          end
          if not rect_matches(current_frame, target_rect, deps.frameTolerance or 1) then
            attempt_frame(window, target_rect, slot.source, current_frame, actions, frame_mismatches, deps, log_fn)
          end
          table.insert(applied, slot.source)
        end
      else
        table.insert(missing, slot.source)
      end
    end
  end

  local focus_source = state.focus
  if focus_source == nil and state.slots and state.slots[1] then
    focus_source = state.slots[1].source
  end

  -- Proportional actuation plan, replacing the old all-or-nothing
  -- choreography skip: the raise/focus cycle now only runs when the cast (the
  -- slide's slots plus its visible overlays) is itself wrong — its relative
  -- z-order mismatches, or a foreign window actually covers part of it. A
  -- merely-unfocused stage gets a single focus() plus re-raising the overlays
  -- that belong above the focus target, and a fully-correct stage is left
  -- untouched (no raise flash on slide navigation). Fail open to "full" on
  -- any uncertainty, matching the guarded defaults' posture.
  local plan = "full"
  local restack_reason = nil
  local desired = nil
  local focus_index = nil
  if placement_skipped == nil then
    local focus_window = nil
    if focus_source ~= nil then
      focus_window = resolved[focus_source]
    end

    -- Three-state focus probe with a fallback chain. No resolvable focus
    -- target means the choreography would not focus anything, so focus counts
    -- as already correct. A readable isFocused decides between "ok" and
    -- "needed". When the probe is inconclusive (missing or throwing — the
    -- user's setup throws on every apply), a system focusedWindow id
    -- comparison provides a second opinion; only when BOTH are unavailable
    -- does "unknown" keep today's full choreography rather than acting on a
    -- guess.
    local focus_state = "ok"
    if focus_window ~= nil then
      focus_state = "unknown"
      if focus_window.isFocused ~= nil then
        local ok_focus, is_focused = pcall(focus_window.isFocused, focus_window)
        if ok_focus then
          focus_state = is_focused == true and "ok" or "needed"
        else
          -- The probe itself failed: log it once per apply (the live-setup
          -- diagnostic hook), trimmed to one line, then let the fallback
          -- below decide.
          log_fn(string.format(
            "[deckhand:hammerspoon] Focus probe failed for source %s: %s; falling back to focusedWindow comparison",
            tostring(focus_source),
            tostring(is_focused):match("^[^\r\n]*")
          ))
        end
      end

      if focus_state == "unknown" then
        -- Fallback: compare the focus window's id with the system's focused
        -- window id. Unavailable inputs (missing hs.window, a nil or throwing
        -- lookup, an unreadable id on either side) keep the "unknown"
        -- fail-open. This must run BEFORE restack_reason is decided so a
        -- successful fallback yields plan none/focus-only, not "full".
        local ok_lookup, system_window = pcall(deps.focusedWindow or default_focused_window)
        local focus_id = read_window_id(focus_window)
        local system_id = nil
        if ok_lookup and system_window ~= nil then
          system_id = read_window_id(system_window)
        end

        if focus_id ~= nil and system_id ~= nil then
          focus_state = focus_id == system_id and "ok" or "needed"
        end
      end
    end

    -- pcall'd like the screen enumeration so a throwing injected enumerator
    -- fails open exactly like the guarded default.
    local ok_windows, ordered = pcall(ordered_windows)
    local current_ids = nil
    if ok_windows then
      current_ids = current_stacking_ids(ordered)
    end

    if current_ids ~= nil then
      desired, focus_index = desired_cast(state, resolved, focus_source)
    end

    -- The desired front-to-back cast as source names, for the mismatch
    -- diagnostic below (available whenever the cast itself was readable).
    local expected_order = nil
    if desired ~= nil then
      local sources = {}
      for _, entry in ipairs(desired.list) do
        table.insert(sources, entry.source)
      end
      expected_order = table.concat(sources, ">")
    end

    if focus_state == "unknown" then
      -- The focus probe is the uncertain input: name it, since the stacking
      -- reads may be perfectly readable here.
      restack_reason = "focus unknown"
    elseif current_ids == nil or desired == nil then
      -- The stacking (or cast id) read is the uncertain input: re-stack
      -- rather than skip on partial information.
      restack_reason = "stacking unknown"
    else
      local observed = observed_cast_sources(current_ids, desired)
      if observed == nil then
        -- A cast window missing from the current order would be left
        -- wherever it is: fail open, and say the observed order is
        -- unavailable rather than guessing at it.
        restack_reason = "cast order mismatch (expected " .. expected_order .. ", observed unavailable)"
      elseif cast_order_conflicts(current_ids, desired) then
        -- Only inverted pairs of windows whose frames actually overlap
        -- count; the summary names both orders so a live deck's merged
        -- multi-display z-order can be diagnosed from the log.
        restack_reason = "cast order mismatch (expected " .. expected_order
          .. ", observed " .. table.concat(observed, ">") .. ")"
      elseif cast_interference(ordered, desired) then
        restack_reason = "interference"
      end
    end

    if restack_reason ~= nil then
      plan = "full"
    elseif focus_state == "needed" then
      plan = "focus-only"
    else
      plan = "none"
    end
  end

  if plan == "full" then
    for _, slot in ipairs(state.slots or {}) do
      local window = resolved[slot.source]
      if window and window.raise then
        window:raise()
        table.insert(actions, "raised " .. slot.source)
      end
    end
  end

  local focused = nil
  if plan ~= "none" and focus_source ~= nil then
    local target = resolved[focus_source]
    if target then
      target:focus()
      focused = focus_source
      table.insert(actions, "focused " .. focus_source)

      -- Focus-only recovery: focus() pulls the target to the ABSOLUTE front,
      -- so the overlays that belong above it must be re-raised afterwards —
      -- closest to the focus target first and the topmost overlay last,
      -- because every raise lands at the absolute front and would invert the
      -- final overlay order otherwise.
      if plan == "focus-only" and desired ~= nil then
        for i = (focus_index or 1) - 1, 1, -1 do
          local entry = desired.list[i]
          if entry.window.raise then
            entry.window:raise()
            table.insert(actions, "raised " .. entry.source)
          end
        end
      end
    end
  end

  for _, overlay in ipairs(state.overlays or {}) do
    local binding = binding_catalog[overlay.source]
    if binding then
      local window = resolved[overlay.source]
      if window then
        if overlay.hidden == true then
          -- Proportional minimize: an already-minimized window is left alone.
          -- An unreadable minimized state (missing or throwing isMinimized)
          -- fails open to today's always-minimize.
          if minimized_state(window) ~= true and window.minimize then
            window:minimize()
            table.insert(actions, "minimized " .. overlay.source)
          end
        elseif overlay.rect then
          -- The whole visible-overlay choreography (unminimize, geometry,
          -- raise) is gated on placement being allowed. On an arrangement
          -- mismatch the deck is effectively laptop-only, and raising (or
          -- restoring) a presenter-side overlay (teleprompter, Console, OBS)
          -- would cover the slot windows the presenter needs to see/capture —
          -- so overlays are kept back entirely. A hidden overlay therefore
          -- also stays minimized here on purpose: it will be restored once
          -- the monitors are reattached and placement recovers.
          if placement_skipped == nil then
            -- Proportional unminimize: only a still-minimized overlay needs
            -- restoring; an unreadable minimized state (missing or throwing
            -- isMinimized) fails open to today's always-unminimize.
            if minimized_state(window) ~= false and window.unminimize then
              window:unminimize()
              table.insert(actions, "unminimized " .. overlay.source)
            end
            local target_rect = make_rect(overlay.rect)
            -- Same skip-if-placed guard as the slots: re-applying identical
            -- geometry shakes the overlay on every slide change, and the
            -- in-bounds clamp rides along with it. Unminimize and raise still
            -- run because restore/z-order is choreography, not geometry.
            local current_frame = nil
            if window.frame ~= nil then
              current_frame = window:frame()
            end
            if not rect_matches(current_frame, target_rect, deps.frameTolerance or 1) then
              local attempted = attempt_frame(window, target_rect, overlay.source, current_frame, actions, frame_mismatches, deps, log_fn)
              -- Chrome enforces a minimum window width above the configured overlay
              -- width, so it may clamp the size below (the settle wait logs that and
              -- continues), and setFrame can mis-position windows flush to an edge;
              -- pass the intended rect (not the mid-flight current frame) to
              -- setFrameInScreenBounds so the overlay (presenter window or an
              -- external app window) stays clamped fully on-screen. Skipped when
              -- the sticky frame memory skipped the attempt too: nothing moved.
              if attempted and window.setFrameInScreenBounds then
                window:setFrameInScreenBounds(target_rect)
              end
            end
            table.insert(applied, overlay.source)
            -- Raising is choreography, not geometry: it joins the
            -- proportional plan so an already-stacked deck never flips
            -- windows to the front on a slide change (the focus-only path
            -- re-raises exactly the overlays that belong above the focus
            -- target instead, right after the focus call).
            if plan == "full" and window.raise then
              window:raise()
              table.insert(actions, "raised " .. overlay.source)
            end
          end
        end
      else
        table.insert(missing, overlay.source)
      end
    else
      -- No binding for this overlay source: report it so the observer logs
      -- the gap instead of silently skipping the overlay.
      table.insert(missing, overlay.source)
    end
  end

  -- One diagnostic summary line naming every real action of this apply (the
  -- hook for spotting unwanted raise cycles on a live deck); silent when
  -- nothing acted. The restack reason leads the line because it explains the
  -- choreography that followed it.
  if #actions > 0 then
    local fragments = {}
    if restack_reason ~= nil then
      table.insert(fragments, "restacked (" .. restack_reason .. ")")
    end
    for _, action in ipairs(actions) do
      table.insert(fragments, action)
    end

    log_fn("[deckhand:hammerspoon] Slide actions: " .. table.concat(fragments, "; "))
  end

  return {
    applied = applied,
    clearedBindings = cleared_bindings,
    focused = focused,
    frameMismatches = frame_mismatches,
    missing = missing,
    placementSkipped = placement_skipped,
    resolvedBindings = resolved_bindings,
  }
end

return M
