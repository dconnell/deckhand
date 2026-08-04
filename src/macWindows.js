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
function getWindowIdsViaCGList(pid) {
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

function getWindowIndexForPid(macWindowId, pid) {
  if (!Number.isInteger(macWindowId) || macWindowId <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const windows = getAllWindowIdsViaCGList(pid);
  const index = windows.findIndex((window) => window.windowId === macWindowId);

  return index >= 0 ? index : null;
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
 * @returns {Array<{ windowId: number, title: string, pid?: number, ownerName?: string }>}
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
    return [];
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

/**
 * Match macOS windows to managed browser source titles.
 *
 * @param {number} pid Chrome process PID.
 * @param {Record<string, { title: string }>} sourceTitles Map of source ID to expected title.
 * @returns {Record<string, { macWindowId: number, pid: number }>}
 */
export function resolveMacWindowIds(pid, sourceTitles) {
  const windows = enumerateWindowsByPid(pid);
  const result = {};

  for (const [sourceId, expected] of Object.entries(sourceTitles)) {
    const match = windows.find((w) => w.title === expected.title);

    if (match) {
      result[sourceId] = {
        macWindowId: match.windowId,
        pid,
      };
    }
  }

  return result;
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

func childElements(_ element: AXUIElement) -> [AXUIElement] {
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

    for child in childElements(element) {
        if let match = findDiscardButton(in: child) {
            return match
        }
    }

    return nil
}

func tryPressDiscardButton(in window: AXUIElement) -> Bool {
    var sheetsRef: CFTypeRef?
    let sheetsResult = AXUIElementCopyAttributeValue(window, kAXSheetsAttribute as CFString, &sheetsRef)
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

${discardHelpers}
let targetIndex = Int(CommandLine.arguments[1])!
let pid = pid_t(CommandLine.arguments[2])!

if let app = NSRunningApplication(processIdentifier: pid) {
    app.activate(options: [.activateIgnoringOtherApps])
}

let axApp = AXUIElementCreateApplication(pid)
var windowsRef: CFTypeRef?
AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef)

if let windows = windowsRef as? [AXUIElement], targetIndex >= 0, targetIndex < windows.count {
    let window = windows[targetIndex]
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)

    let closeResult = AXUIElementPerformAction(window, kAXCloseAction as CFString)
    if closeResult != .success {
        var closeBtn: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXCloseButtonAttribute as CFString, &closeBtn)
        if let button = closeBtn as? AXUIElement {
            _ = AXUIElementPerformAction(button, kAXPressAction as CFString)
        }
    }

${discardAfterClose}
}
`;
}

function raiseMacWindow(windowIndex, pid) {
  const script = `tell application "System Events"
  tell (first process whose unix id is ${Math.floor(pid)})
    set frontmost to true
    set targetWindow to window ${Math.floor(windowIndex) + 1}
    perform action "AXRaise" of targetWindow
  end tell
end tell`;

  try {
    execSync('osascript', {
      encoding: 'utf8',
      timeout: 3000,
      input: script,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch {
    // best-effort raise
  }
}

function closeMacWindowViaAppleScript(windowIndex, pid, { discardUnsavedChanges = false } = {}) {
  const closeAndDiscardScript = discardUnsavedChanges
    ? `
    repeat with i from 1 to 12
      keystroke "w" using {command down}
      delay 0.1
      keystroke "d" using {command down}
      delay 0.1
    end repeat
`
    : `
    repeat with i from 1 to 6
      keystroke "w" using {command down}
      delay 0.1
    end repeat
`;

  const script = `tell application "System Events"
  tell (first process whose unix id is ${Math.floor(pid)})
    set frontmost to true
    set targetWindow to window ${Math.floor(windowIndex) + 1}
    perform action "AXRaise" of targetWindow
    delay 0.1
${closeAndDiscardScript}
  end tell
end tell`;

  try {
    execSync('osascript', {
      encoding: 'utf8',
      timeout: 6000,
      input: script,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch {
    // best-effort close via AppleScript
  }
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
  let targetWindowIndex = getWindowIndexForPid(targetWindowId, targetPid);

  if (targetWindowIndex === null) {
    return !hasWindowIdForPid(targetWindowId, targetPid);
  }

  try {
    execSync(`swift - ${targetWindowIndex} ${targetPid}`, {
      encoding: 'utf8',
      timeout: 5000,
      input: buildCloseWindowSwiftScript(options),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch {
    // best-effort close — the window may have already been closed by the user
  }

  closeMacWindowViaAppleScript(targetWindowIndex, targetPid, {
    discardUnsavedChanges: options.discardUnsavedChanges === true,
  });

  if (!hasWindowIdForPid(targetWindowId, targetPid)) {
    return true;
  }

  if (options.discardUnsavedChanges !== true) {
    return false;
  }

  if (!hasWindowIdForPid(targetWindowId, targetPid)) {
    return true;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    targetWindowIndex = getWindowIndexForPid(targetWindowId, targetPid);
    if (targetWindowIndex === null) {
      return !hasWindowIdForPid(targetWindowId, targetPid);
    }

    raiseMacWindow(targetWindowIndex, targetPid);
    closeMacWindowViaAppleScript(targetWindowIndex, targetPid, {
      discardUnsavedChanges: true,
    });

    try {
      execSync(`swift - ${targetWindowIndex} ${targetPid}`, {
        encoding: 'utf8',
        timeout: 5000,
        input: buildCloseWindowSwiftScript({ discardUnsavedChanges: true }),
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      // continue fallback attempts
    }

    if (!hasWindowIdForPid(targetWindowId, targetPid)) {
      return true;
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
  const windows = enumerateWindowsByOwnerName(ownerName);

  for (const window of windows) {
    if (typeof window.pid === 'number' && window.pid > 0) {
      return window.pid;
    }
  }

  return null;
}
