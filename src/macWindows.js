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
    results.append([
        "windowId": windowId,
        "x": Int(x),
        "y": Int(y),
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

const SWIFT_CLOSE_WINDOW = `
import Cocoa
import CoreGraphics

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ axElement: AXUIElement) -> CGWindowID

let targetWindowId = UInt32(CommandLine.arguments[1])!
let pid = pid_t(CommandLine.arguments[2])!

let axApp = AXUIElementCreateApplication(pid)
var windowsRef: CFTypeRef?
AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef)

if let windows = windowsRef as? [AXUIElement] {
    for window in windows {
        let wid = _AXUIElementGetWindow(window)
        if wid == targetWindowId {
            var closeBtn: CFTypeRef?
            AXUIElementCopyAttributeValue(window, kAXCloseButtonAttribute as CFString, &closeBtn)
            if let btn = closeBtn {
                AXUIElementPerformAction(btn, kAXPressAction as CFString)
            }
            break
        }
    }
}
`;

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
 * @returns {void}
 */
export function closeMacWindow(macWindowId, pid) {
  if (process.platform !== 'darwin') {
    return;
  }

  if (typeof macWindowId !== 'number' || typeof pid !== 'number') {
    return;
  }

  try {
    execSync(`swift - ${Math.floor(macWindowId)} ${Math.floor(pid)}`, {
      encoding: 'utf8',
      timeout: 5000,
      input: SWIFT_CLOSE_WINDOW,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch {
    // best-effort close — the window may have already been closed by the user
  }
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
