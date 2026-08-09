import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChromeWindowAppleScript } from '../../src/launchers/chrome.js';

test('buildChromeWindowAppleScript composes a make-new-window script with the URL set on the active tab', () => {
  const script = buildChromeWindowAppleScript('https://app.slack.com/client/T1/C1');

  assert.ok(script.includes('tell application "Google Chrome"'));
  assert.ok(script.includes('set newWin to (make new window)'));
  assert.ok(script.includes('set URL of active tab of newWin to "https://app.slack.com/client/T1/C1"'));
});

test('buildChromeWindowAppleScript escapes embedded double quotes and backslashes in the URL', () => {
  const script = buildChromeWindowAppleScript('https://example.com/"weird"?x=1\\2');

  assert.ok(script.includes('"https://example.com/\\"weird\\"?x=1\\\\2"'));
});
