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
