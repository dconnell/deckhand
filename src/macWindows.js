import { execSync } from 'node:child_process';

const SWIFT_SCRIPT = `
import CoreGraphics
import Foundation

let pid = Int(CommandLine.arguments[1])!
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
var results: [[String: Any]] = []
for w in info {
    let ownerPID = w["kCGWindowOwnerPID"] as? Int ?? 0
    if ownerPID != pid { continue }
    let layer = w["kCGWindowLayer"] as? Int ?? 0
    if layer != 0 { continue }
    let windowId = w["kCGWindowNumber"] as? Int ?? 0
    let bounds = w["kCGWindowBounds"] as? [String: CGFloat] ?? [:]
    let x = bounds["X"] ?? 0
    let y = bounds["Y"] ?? 0
    let width = bounds["Width"] ?? 0
    let height = bounds["Height"] ?? 0
    results.append([
        "windowId": windowId,
        "x": Int(x),
        "y": Int(y),
        "width": Int(width),
        "height": Int(height),
    ])
}
let jsonData = try! JSONSerialization.data(withJSONObject: results, options: [])
print(String(data: jsonData, encoding: .utf8)!)
`;

const SWIFT_SCRIPT_ALL_BY_PID = `
import CoreGraphics
import Foundation

let pid = Int(CommandLine.arguments[1])!
let info = CGWindowListCopyWindowInfo([], kCGNullWindowID) as! [[String: Any]]
var results: [[String: Any]] = []
for w in info {
    let ownerPID = w["kCGWindowOwnerPID"] as? Int ?? 0
    if ownerPID != pid { continue }
    let layer = w["kCGWindowLayer"] as? Int ?? 0
    if layer != 0 { continue }
    let windowId = w["kCGWindowNumber"] as? Int ?? 0
    let bounds = w["kCGWindowBounds"] as? [String: CGFloat] ?? [:]
    let x = bounds["X"] ?? 0
    let y = bounds["Y"] ?? 0
    let width = bounds["Width"] ?? 0
    let height = bounds["Height"] ?? 0
    results.append([
        "windowId": windowId,
        "x": Int(x),
        "y": Int(y),
        "width": Int(width),
        "height": Int(height),
    ])
}
let jsonData = try! JSONSerialization.data(withJSONObject: results, options: [])
print(String(data: jsonData, encoding: .utf8)!)
`;

const SWIFT_SCRIPT_BY_OWNER = `
import CoreGraphics
import Foundation

let env = ProcessInfo.processInfo.environment
let ownerName = env["DECKHAND_OWNER_NAME"] ?? ""
let info = CGWindowListCopyWindowInfo([], kCGNullWindowID) as! [[String: Any]]
var results: [[String: Any]] = []
for w in info {
    let name = w["kCGWindowOwnerName"] as? String ?? ""
    if !ownerName.isEmpty && !name.lowercased().hasPrefix(ownerName.lowercased()) { continue }
    let layer = w["kCGWindowLayer"] as? Int ?? 0
    if layer != 0 { continue }
    let windowId = w["kCGWindowNumber"] as? Int ?? 0
    let ownerPID = w["kCGWindowOwnerPID"] as? Int ?? 0
    let title = w["kCGWindowName"] as? String ?? ""
    let bounds = w["kCGWindowBounds"] as? [String: CGFloat] ?? [:]
    let width = Int(bounds["Width"] ?? 0)
    let height = Int(bounds["Height"] ?? 0)
    results.append([
        "windowId": windowId,
        "title": title,
        "pid": ownerPID,
        "ownerName": name,
        "width": width,
        "height": height,
    ])
}
let jsonData = try! JSONSerialization.data(withJSONObject: results, options: [])
print(String(data: jsonData, encoding: .utf8)!)
`;

/**
 * Get window titles for a process via the macOS Accessibility API (System Events).
 *
 * CGWindowListCopyWindowInfo returns empty kCGWindowName for Chrome, but the
 * Accessibility API via osascript CAN see Chrome window titles.
 *
 * @param {number} pid Process ID.
 * @returns {string[]} Window titles in z-order (frontmost first).
 */
function getWindowTitlesViaAccessibility(pid) {
  try {
    const script = `tell application "System Events" to tell (first process whose unix id is ${pid}) to get title of every window`;
    const output = execSync(`osascript -e '${script}'`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    if (!output || output === 'missing value' || output === '') {
      return [];
    }

    return output.split(', ').map((s) => s.trim());
  } catch {
    return [];
  }
}

/**
 * Get CGWindowIDs for a process via CGWindowListCopyWindowInfo.
 *
 * Returns windows in z-order (frontmost first) with their bounds.
 *
 * @param {number} pid Process ID.
 * @returns {Array<{ windowId: number, x: number, y: number }>}
 */
/**
 * Get CGWindowIDs for a process via CGWindowListCopyWindowInfo.
 *
 * Returns on-screen, layer-0 windows for a PID with their bounds. Title-free by
 * design: callers that resolve window identity by CGWindowID diff (browser
 * sources) do not need the Accessibility API title fetch that
 * {@link enumerateWindowsByPid} performs, so they avoid the osascript
 * subprocess and Accessibility-permission dependency.
 *
 * @param {number} pid Process ID.
 * @returns {Array<{ windowId: number, x: number, y: number, width: number, height: number }>}
 */
export function getWindowIdsViaCGList(pid) {
  if (process.platform !== 'darwin') {
    return [];
  }

  try {
    const output = execSync(`swift - ${pid}`, {
      encoding: 'utf8',
      timeout: 5000,
      input: SWIFT_SCRIPT,
    });

    return JSON.parse(output.trim()).filter((entry) => entry.windowId > 0);
  } catch {
    return [];
  }
}

function getAllWindowIdsViaCGList(pid) {
  if (process.platform !== 'darwin') {
    return [];
  }

  try {
    const output = execSync(`swift - ${pid}`, {
      encoding: 'utf8',
      timeout: 5000,
      input: SWIFT_SCRIPT_ALL_BY_PID,
    });

    return JSON.parse(output.trim()).filter((entry) => entry.windowId > 0);
  } catch {
    return [];
  }
}

function hasWindowIdForPid(macWindowId, pid) {
  if (!Number.isInteger(macWindowId) || macWindowId <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  return getAllWindowIdsViaCGList(pid).some((window) => window.windowId === macWindowId);
}

function getWindowDescriptorForPid(macWindowId, pid) {
  if (!Number.isInteger(macWindowId) || macWindowId <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const windows = getAllWindowIdsViaCGList(pid);
  const match = windows.find((window) => window.windowId === macWindowId);

  if (match === undefined) {
    return null;
  }

  return {
    windowId: match.windowId,
    x: typeof match.x === 'number' ? match.x : 0,
    y: typeof match.y === 'number' ? match.y : 0,
    width: typeof match.width === 'number' ? match.width : 0,
    height: typeof match.height === 'number' ? match.height : 0,
  };
}

/**
 * Enumerate on-screen macOS windows for a given process PID.
 *
 * Combines CGWindowList (for exact CGWindowID values) with the Accessibility
 * API (for window titles, which CGWindowList returns empty for Chrome).
 * Both APIs return windows in z-order for the same PID, so we zip them.
 *
 * @param {number} pid Process ID to filter windows by.
 * @returns {Array<{ windowId: number, title: string }>}
 */
export function enumerateWindowsByPid(pid) {
  if (process.platform !== 'darwin') {
    return [];
  }

  const cgWindows = getWindowIdsViaCGList(pid);
  const axTitles = getWindowTitlesViaAccessibility(pid);

  if (cgWindows.length === 0) {
    return [];
  }

  const result = [];
  const maxLen = Math.max(cgWindows.length, axTitles.length);

  for (let i = 0; i < maxLen; i += 1) {
    const windowId = cgWindows[i]?.windowId ?? 0;
    const title = axTitles[i] ?? '';

    if (windowId > 0) {
      result.push({ windowId, title });
    }
  }

  return result;
}

/**
 * Enumerate macOS windows whose owner name starts with the given prefix.
 *
 * Uses CGWindowListCopyWindowInfo (all windows, not just on-screen) filtered by
 * `kCGWindowOwnerName` case-insensitive prefix match. Two departures from
 * {@link enumerateWindowsByPid} are intentional:
 *
 * - **All windows, not `.optionOnScreenOnly`**: owned apps (iTerm2, VS Code)
 *   may be in the background when the before-snapshot is taken. Excluding
 *   off-screen windows would leave the snapshot empty and cause the diff to
 *   treat every existing window as "new" — binding the launch terminal instead
 *   of the freshly-created one.
 *
 * - **Prefix match (`hasPrefix`), not exact**: iTerm2's `kCGWindowOwnerName`
 *   is `"iTerm"` in the window server regardless of the marketing name, so a
 *   caller passing `"iTerm"` matches both `"iTerm"` and `"iTerm2"` processes.
 *
 * Titles come from `kCGWindowName` rather than the Accessibility API: the title
 * is only a secondary splash-rejection signal, not the identity source of truth.
 *
 * @param {string} ownerName macOS owner (app) name prefix, as in `kCGWindowOwnerName`. Pass an empty string to enumerate all layer-0 windows regardless of owner.
 * @returns {Array<{ windowId: number, title: string, pid?: number, ownerName?: string }> | null} Matching window entries, or `null` when the snapshot itself failed. The distinction matters: the owned-window launch diff (`ownedWindows.js`) reads an empty array as "nothing pre-existed", which would pin the largest pre-existing window as the newly-launched one, while `null` lets callers fail safe and skip binding.
 */
export function enumerateWindowsByOwnerName(ownerName) {
  if (process.platform !== 'darwin') {
    return [];
  }

  try {
    const output = execSync('swift -', {
      encoding: 'utf8',
      timeout: 5000,
      input: SWIFT_SCRIPT_BY_OWNER,
      env: { ...process.env, DECKHAND_OWNER_NAME: ownerName },
    });

    return JSON.parse(output.trim())
      .filter((entry) => entry.windowId > 0)
      .map((entry) => {
        const window = { windowId: entry.windowId, title: entry.title ?? '' };
        if (typeof entry.pid === 'number') {
          window.pid = entry.pid;
        }
        if (typeof entry.ownerName === 'string') {
          window.ownerName = entry.ownerName;
        }
        if (typeof entry.width === 'number') {
          window.width = entry.width;
        }
        if (typeof entry.height === 'number') {
          window.height = entry.height;
        }
        return window;
      });
  } catch {
    // `null` marks a FAILED snapshot, distinct from `[]` ("no windows
    // matched"): callers that diff before/after launches must not read a
    // failed enumeration as an empty desktop, or they bind whatever was
    // already on screen (observed: the terminal hosting deckhand itself).
    return null;
  }
}

/**
 * Resolve the newly-appeared macOS window(s) from before/after snapshots.
 *
 * This is the generic, title-independent identity primitive for owned sources.
 * It returns window entries present in `after` but absent from `before`, so the
 * caller can bind the exact `macWindowId` of a window it just launched without
 * relying on title matching.
 *
 * When confirmation options are provided, transient splash windows are rejected
 * so the caller can keep polling until the real window appears:
 *
 * - `rejectEmptyTitle`: drop windows whose title is empty/whitespace (splash
 *   windows often carry no title).
 * - `titleIncludes`: keep only windows whose title contains the substring.
 *
 * Title is a secondary confirmation signal only (`window-identity.md:36`); the
 * returned `windowId` remains the identity source of truth.
 *
 * @param {Array<{ windowId: number, title?: string }>} before Snapshot taken before launch.
 * @param {Array<{ windowId: number, title?: string }>} after Snapshot taken after launch.
 * @param {{ titleIncludes?: string, rejectEmptyTitle?: boolean }} [options] Optional splash-rejection signals.
 * @returns {Array<{ windowId: number, title?: string }>}
 */
export function diffNewWindows(before, after, options = {}) {
  const beforeIds = new Set(before.map((w) => w.windowId));
  const newWindows = after.filter((w) => !beforeIds.has(w.windowId));

  if (options.titleIncludes === undefined && !options.rejectEmptyTitle) {
    return newWindows;
  }

  return newWindows.filter((w) => {
    if (options.rejectEmptyTitle && (typeof w.title !== 'string' || w.title.trim() === '')) {
      return false;
    }

    if (options.titleIncludes !== undefined) {
      return typeof w.title === 'string' && w.title.includes(options.titleIncludes);
    }

    return true;
  });
}

const SWIFT_DISCARD_UNSAVED_HELPERS = `
func normalizedTitle(_ value: String) -> String {
    return value
        .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        .replacingOccurrences(of: "’", with: "'")
        .replacingOccurrences(of: "‘", with: "'")
}

func attributeString(_ element: AXUIElement, _ attribute: CFString) -> String {
    var ref: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute, &ref)
    guard result == .success else {
        return ""
    }

    return ref as? String ?? ""
}

func collectChildElements(_ element: AXUIElement) -> [AXUIElement] {
    var ref: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref)
    guard result == .success else {
        return []
    }

    return ref as? [AXUIElement] ?? []
}

func windowsForApp(_ app: AXUIElement) -> [AXUIElement] {
    var ref: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref)
    guard result == .success else {
        return []
    }

    return ref as? [AXUIElement] ?? []
}

func findDiscardButton(in element: AXUIElement) -> AXUIElement? {
    let role = attributeString(element, kAXRoleAttribute as CFString)
    if role == kAXButtonRole as String {
        let title = normalizedTitle(
            attributeString(element, kAXTitleAttribute as CFString)
            + " "
            + attributeString(element, kAXDescriptionAttribute as CFString)
        )
        if title.contains("don't save")
            || title.contains("dont save")
            || title.contains("do not save")
            || title.contains("discard") {
            return element
        }
    }

    for child in collectChildElements(element) {
        if let match = findDiscardButton(in: child) {
            return match
        }
    }

    return nil
}

func tryPressDiscardButton(in window: AXUIElement) -> Bool {
    var sheetsRef: CFTypeRef?
    let sheetsResult = AXUIElementCopyAttributeValue(window, "AXSheets" as CFString, &sheetsRef)
    guard sheetsResult == .success, let sheets = sheetsRef as? [AXUIElement] else {
        return false
    }

    for sheet in sheets {
        if let discardButton = findDiscardButton(in: sheet) {
            let pressResult = AXUIElementPerformAction(discardButton, kAXPressAction as CFString)
            if pressResult == .success {
                return true
            }
        }
    }

    return false
}

func tryPressDiscardButton(inApp app: AXUIElement) -> Bool {
    for appWindow in windowsForApp(app) {
        if let discardButton = findDiscardButton(in: appWindow) {
            let pressResult = AXUIElementPerformAction(discardButton, kAXPressAction as CFString)
            if pressResult == .success {
                return true
            }
        }

        if tryPressDiscardButton(in: appWindow) {
            return true
        }
    }

    return false
}
`;

/**
 * Build the Swift script used to close a macOS window by CGWindowID.
 *
 * @param {{ discardUnsavedChanges?: boolean }} [options] Close options.
 * @returns {string}
 */
export function buildCloseWindowSwiftScript({ discardUnsavedChanges = false } = {}) {
  const discardHelpers = discardUnsavedChanges ? SWIFT_DISCARD_UNSAVED_HELPERS : '';
  const discardAfterClose = discardUnsavedChanges
    ? `
            for _ in 0..<20 {
                if tryPressDiscardButton(in: window) || tryPressDiscardButton(inApp: axApp) {
                    break
                }

                usleep(100_000)
            }
`
    : '';

  return `
import Cocoa
import CoreGraphics

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ axElement: AXUIElement) -> CGWindowID

${discardHelpers}
let targetWindowId = UInt32(CommandLine.arguments[1])!
let pid = pid_t(CommandLine.arguments[2])!

if let app = NSRunningApplication(processIdentifier: pid) {
    app.activate(options: [.activateIgnoringOtherApps])
}

let axApp = AXUIElementCreateApplication(pid)
var windowsRef: CFTypeRef?
AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef)

if let windows = windowsRef as? [AXUIElement] {
    for window in windows {
        let windowId = _AXUIElementGetWindow(window)
        if windowId != targetWindowId {
            continue
        }

        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)

        let closeResult = AXUIElementPerformAction(window, "AXClose" as CFString)
        if closeResult != .success {
            var closeBtn: CFTypeRef?
            AXUIElementCopyAttributeValue(window, kAXCloseButtonAttribute as CFString, &closeBtn)
            if let closeBtn {
                let button = closeBtn as! AXUIElement
                _ = AXUIElementPerformAction(button, kAXPressAction as CFString)
            }
        }

${discardAfterClose}        break
    }
}
`;
}

/**
 * Build a close script that resolves an AX window by bounds instead of ID.
 *
 * Some apps (notably VS Code/Electron) can fail private window-id lookups in
 * particular Accessibility states. Bounds matching gives a reliable fallback
 * while still targeting one concrete tracked window.
 *
 * @param {{ discardUnsavedChanges?: boolean }} [options] Close options.
 * @returns {string}
 */
export function buildCloseWindowByBoundsSwiftScript({ discardUnsavedChanges = false } = {}) {
  const discardHelpers = discardUnsavedChanges ? SWIFT_DISCARD_UNSAVED_HELPERS : '';
  const collectHelpers = discardUnsavedChanges
    ? ''
    : `
func collectChildElements(_ element: AXUIElement) -> [AXUIElement] {
    var ref: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref)
    guard status == .success else {
        return []
    }

    return ref as? [AXUIElement] ?? []
}
`;
  const discardAfterClose = discardUnsavedChanges
    ? `
        for _ in 0..<20 {
            if tryPressDiscardButton(in: bestWindow) || tryPressDiscardButton(inApp: axApp) {
                break
            }

            usleep(100_000)
        }
`
    : '';

  return `
import Cocoa
import CoreGraphics

${discardHelpers}

${collectHelpers}

func collectWindows(from element: AXUIElement, depth: Int = 0, maxDepth: Int = 7) -> [AXUIElement] {
    if depth > maxDepth {
        return []
    }

    var result: [AXUIElement] = []
    var roleRef: CFTypeRef?
    let roleStatus = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
    if roleStatus == .success, let role = roleRef as? String, role == kAXWindowRole as String {
        result.append(element)
    }

    for child in collectChildElements(element) {
        result.append(contentsOf: collectWindows(from: child, depth: depth + 1, maxDepth: maxDepth))
    }

    return result
}

func pointForWindow(_ window: AXUIElement) -> CGPoint? {
    var ref: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &ref)
    guard status == .success, let value = ref else {
        return nil
    }

    guard CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }

    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else {
        return nil
    }

    var point = CGPoint.zero
    guard AXValueGetValue(axValue, .cgPoint, &point) else {
        return nil
    }

    return point
}

func sizeForWindow(_ window: AXUIElement) -> CGSize? {
    var ref: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &ref)
    guard status == .success, let value = ref else {
        return nil
    }

    guard CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }

    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgSize else {
        return nil
    }

    var size = CGSize.zero
    guard AXValueGetValue(axValue, .cgSize, &size) else {
        return nil
    }

    return size
}

let targetX = CGFloat(Double(CommandLine.arguments[1])!)
let targetY = CGFloat(Double(CommandLine.arguments[2])!)
let targetWidth = CGFloat(Double(CommandLine.arguments[3])!)
let targetHeight = CGFloat(Double(CommandLine.arguments[4])!)
let pid = pid_t(CommandLine.arguments[5])!

if let app = NSRunningApplication(processIdentifier: pid) {
    app.activate(options: [.activateIgnoringOtherApps])
}

let axApp = AXUIElementCreateApplication(pid)
let windows = collectWindows(from: axApp)

if !windows.isEmpty {
    var bestWindow: AXUIElement? = nil
    var bestScore = Double.greatestFiniteMagnitude

    for window in windows {
        guard let point = pointForWindow(window), let size = sizeForWindow(window) else {
            continue
        }

        let dx = abs(Double(point.x - targetX))
        let dy = abs(Double(point.y - targetY))
        let dw = abs(Double(size.width - targetWidth))
        let dh = abs(Double(size.height - targetHeight))
        let score = dx + dy + dw + dh

        if score < bestScore {
            bestScore = score
            bestWindow = window
        }
    }

    if let bestWindow = bestWindow, bestScore <= 12 {
        _ = AXUIElementPerformAction(bestWindow, kAXRaiseAction as CFString)

        let closeResult = AXUIElementPerformAction(bestWindow, "AXClose" as CFString)
        if closeResult != .success {
            var closeBtn: CFTypeRef?
            AXUIElementCopyAttributeValue(bestWindow, kAXCloseButtonAttribute as CFString, &closeBtn)
            if let closeBtn {
                let button = closeBtn as! AXUIElement
                _ = AXUIElementPerformAction(button, kAXPressAction as CFString)
            }
        }

${discardAfterClose}    }
}
`;
}

/**
 * Total bounds deviation (Manhattan sum of position and size deltas) at or
 * below which the bounds-based close fallback considers a window a match.
 * Mirrors the Swift script's `bestScore <= 12` threshold.
 *
 * @type {number}
 */
export const BOUNDS_FALLBACK_TOLERANCE = 12;

/**
 * Identify the unique same-pid window the bounds-based close fallback may
 * target, or report that no unambiguous target exists.
 *
 * Why the uniqueness requirement: the fallback closes whichever window of the
 * pid scores closest to the remembered bounds, making it the only close path
 * that can hit a DIFFERENT window of the same pid — and apps like VS Code run
 * every window on one shared process. With zero or multiple in-tolerance
 * candidates the intended target cannot be identified, so nothing may be
 * closed: leave the window open and let the caller warn.
 *
 * @param {Array<{ windowId: number, x: number, y: number, width: number, height: number }>} samePidWindows Layer-0 windows of the pid (e.g. from `getAllWindowIdsViaCGList`).
 * @param {{ windowId: number, x: number, y: number, width: number, height: number } | null} targetWindow Bounds descriptor of the bound window.
 * @param {number} [tolerance] Maximum total bounds deviation for a match.
 * @returns {{ windowId: number, x: number, y: number, width: number, height: number } | null} The single in-tolerance window, or `null` when the target is absent or ambiguous.
 */
export function findUniqueBoundsFallbackCandidate(samePidWindows, targetWindow, tolerance = BOUNDS_FALLBACK_TOLERANCE) {
  if (targetWindow === null || !Array.isArray(samePidWindows)) {
    return null;
  }

  const matches = samePidWindows.filter((window) => {
    const dx = Math.abs(window.x - targetWindow.x);
    const dy = Math.abs(window.y - targetWindow.y);
    const dw = Math.abs(window.width - targetWindow.width);
    const dh = Math.abs(window.height - targetWindow.height);
    return dx + dy + dw + dh <= tolerance;
  });

  return matches.length === 1 ? matches[0] : null;
}

/**
 * Close a specific macOS window by CGWindowID via the Accessibility API.
 *
 * Used during shutdown to close owned app windows (iTerm2, generic apps) that
 * Deckhand launched, without quitting the entire application (which would also
 * close the terminal Deckhand was launched from).
 *
 * Best-effort: any Swift or AX error is swallowed so that one un-closeable
 * window cannot block the rest of the shutdown sequence.
 *
 * @param {number} macWindowId The CGWindowID of the window to close.
 * @param {number} pid The process ID owning the window.
 * @param {{ discardUnsavedChanges?: boolean }} [options] Close options.
 * @returns {boolean} True when the target window is no longer present.
 */
export function closeMacWindow(macWindowId, pid, options = {}) {
  if (process.platform !== 'darwin') {
    return false;
  }

  if (typeof macWindowId !== 'number' || typeof pid !== 'number') {
    return false;
  }

  const targetWindowId = Math.floor(macWindowId);
  const targetPid = Math.floor(pid);

  const targetWindow = getWindowDescriptorForPid(targetWindowId, targetPid);

  if (!hasWindowIdForPid(targetWindowId, targetPid)) {
    return true;
  }

  const maxAttempts = options.discardUnsavedChanges === true ? 3 : 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      execSync(`swift - ${targetWindowId} ${targetPid}`, {
        encoding: 'utf8',
        timeout: 5000,
        input: buildCloseWindowSwiftScript(options),
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      // best-effort close — continue with presence check
    }

    if (!hasWindowIdForPid(targetWindowId, targetPid)) {
      return true;
    }

    if (targetWindow !== null) {
      const fallbackCandidate = findUniqueBoundsFallbackCandidate(
        getAllWindowIdsViaCGList(targetPid),
        targetWindow,
      );

      if (fallbackCandidate === null) {
        // Fail safe: with zero or multiple in-tolerance same-pid windows the
        // bounds script could close the WRONG window (all VS Code windows
        // share one process). Leave the window open — the unconfirmed close
        // surfaces to the caller (`closeOwnedAppWindows`) as a warning naming
        // the source and binding.
      } else {
        try {
          execSync(
            `swift - ${targetWindow.x} ${targetWindow.y} ${targetWindow.width} ${targetWindow.height} ${targetPid}`,
            {
              encoding: 'utf8',
              timeout: 5000,
              input: buildCloseWindowByBoundsSwiftScript(options),
              stdio: ['pipe', 'ignore', 'ignore'],
            },
          );
        } catch {
          // continue with presence check
        }
      }

      if (!hasWindowIdForPid(targetWindowId, targetPid)) {
        return true;
      }
    }
  }

  return !hasWindowIdForPid(targetWindowId, targetPid);
}

/**
 * Find the PID of the first on-screen window matching an owner name.
 *
 * @param {string} ownerName macOS owner (app) name.
 * @returns {number | null}
 */
export function findPidByOwnerName(ownerName) {
  // Snapshot failure (`null`) and "no matching windows" both mean: no pid.
  const windows = enumerateWindowsByOwnerName(ownerName) ?? [];

  for (const window of windows) {
    if (typeof window.pid === 'number' && window.pid > 0) {
      return window.pid;
    }
  }

  return null;
}
