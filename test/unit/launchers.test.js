import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVsCodeLaunchArgs, isVisualStudioCodeApp } from '../../src/apps/vscode.js';
import { buildIterm2WriteText, buildIterm2AppleScript } from '../../src/launchers/iterm2.js';
import { buildTerminalWriteText, buildTerminalAppleScript } from '../../src/launchers/appleTerminal.js';
import { buildGhosttySurfaceConfig, buildGhosttyAppleScript } from '../../src/launchers/ghostty.js';
import { buildAlacrittyMsgArgs } from '../../src/launchers/alacritty.js';
import { buildKittyAtLaunchArgs, buildKittyAtCloseArgs } from '../../src/launchers/kitty.js';
import { buildOpenArgs } from '../../src/launchers/app.js';

test('buildIterm2WriteText composes cd and command for the new session', () => {
  assert.equal(
    buildIterm2WriteText({ command: 'npm run dev', cwd: '/repos/demo' }),
    "cd '/repos/demo' && npm run dev",
  );
});

test('buildIterm2WriteText emits only cd when no command is configured', () => {
  assert.equal(buildIterm2WriteText({ cwd: '/repos/demo' }), "cd '/repos/demo'");
});

test('buildIterm2WriteText emits only the command when no cwd is configured', () => {
  assert.equal(buildIterm2WriteText({ command: 'npm run dev' }), 'npm run dev');
});

test('buildIterm2WriteText returns null when neither command nor cwd is configured', () => {
  assert.equal(buildIterm2WriteText({}), null);
});

test('buildIterm2WriteText shell-quotes paths containing single quotes', () => {
  assert.equal(
    buildIterm2WriteText({ cwd: "/repos/dan's demo" }),
    "cd '/repos/dan'\\''s demo'",
  );
});

test('buildIterm2AppleScript creates a window and writes the session text', () => {
  const script = buildIterm2AppleScript({ command: 'npm run dev', cwd: '/repos/demo' });

  assert.ok(script.includes('create window with default profile'));
  assert.ok(script.includes("write text \"cd '/repos/demo' && npm run dev\""));
  assert.ok(script.includes('return id of (current session of'));
});

test('buildIterm2AppleScript creates a bare window when no command or cwd is configured', () => {
  const script = buildIterm2AppleScript({});

  assert.ok(script.includes('create window with default profile'));
  assert.ok(!script.includes('write text'));
  assert.ok(script.includes('return id of (current session of'));
});

test('buildOpenArgs builds an open -n -a invocation with launch args', () => {
  assert.deepEqual(
    buildOpenArgs({ app: 'Visual Studio Code', args: ['--new-window', '/repos/demo'] }),
    ['-n', '-a', 'Visual Studio Code', '--args', '--new-window', '/repos/demo'],
  );
});

test('buildOpenArgs omits --args when no launch args are configured', () => {
  assert.deepEqual(
    buildOpenArgs({ app: 'Visual Studio Code' }),
    ['-n', '-a', 'Visual Studio Code'],
  );
});

test('buildOpenArgs places files as direct open args before --args', () => {
  assert.deepEqual(
    buildOpenArgs({ app: 'Preview', files: ['/abs/image.jpg'], args: ['--foo'] }),
    ['-n', '-a', 'Preview', '/abs/image.jpg', '--args', '--foo'],
  );
});

test('buildOpenArgs places files without --args when no launch args are configured', () => {
  assert.deepEqual(
    buildOpenArgs({ app: 'Preview', files: ['/abs/image.jpg', '/abs/second.png'] }),
    ['-n', '-a', 'Preview', '/abs/image.jpg', '/abs/second.png'],
  );
});

test('buildOpenArgs ignores a non-array files value', () => {
  assert.deepEqual(
    buildOpenArgs({ app: 'Preview', files: '/abs/image.jpg' }),
    ['-n', '-a', 'Preview'],
  );
});

test('buildOpenArgs passes openArgs verbatim after -a with no --args insertion', () => {
  assert.deepEqual(
    buildOpenArgs({ app: 'Safari', openArgs: ['-g', 'https://example.com'] }),
    ['-n', '-a', 'Safari', '-g', 'https://example.com'],
  );
});

test('buildOpenArgs prefers openArgs over args and files when both are supplied', () => {
  assert.deepEqual(
    buildOpenArgs({ app: 'Safari', openArgs: ['-g'], args: ['--flag'], files: ['/abs/image.jpg'] }),
    ['-n', '-a', 'Safari', '-g'],
  );
});

test('buildOpenArgs ignores a non-array openArgs value', () => {
  assert.deepEqual(
    buildOpenArgs({ app: 'Safari', openArgs: '-g' }),
    ['-n', '-a', 'Safari'],
  );
});

test('isVisualStudioCodeApp matches Visual Studio Code aliases', () => {
  assert.equal(isVisualStudioCodeApp('Visual Studio Code'), true);
  assert.equal(isVisualStudioCodeApp('Code'), true);
  assert.equal(isVisualStudioCodeApp('visual studio code'), true);
  assert.equal(isVisualStudioCodeApp('Visual Studio'), false);
});

test('buildVsCodeLaunchArgs injects --new-window when absent', () => {
  assert.deepEqual(
    buildVsCodeLaunchArgs({ args: ['/repos/demo'] }),
    ['--new-window', '/repos/demo'],
  );
});

test('buildVsCodeLaunchArgs preserves an explicit --new-window', () => {
  assert.deepEqual(
    buildVsCodeLaunchArgs({
      args: ['--new-window', '/repos/demo'],
    }),
    ['--new-window', '/repos/demo'],
  );
});

test('buildVsCodeLaunchArgs tolerates non-array args input', () => {
  assert.deepEqual(
    buildVsCodeLaunchArgs({ args: undefined }),
    ['--new-window'],
  );
});

test('buildTerminalWriteText composes cd and command for the new Terminal.app window', () => {
  assert.equal(
    buildTerminalWriteText({ command: 'npm run dev', cwd: '/repos/demo' }),
    "cd '/repos/demo' && npm run dev",
  );
});

test('buildTerminalWriteText emits only cd when no command is configured', () => {
  assert.equal(buildTerminalWriteText({ cwd: '/repos/demo' }), "cd '/repos/demo'");
});

test('buildTerminalWriteText emits only the command when no cwd is configured', () => {
  assert.equal(buildTerminalWriteText({ command: 'npm run dev' }), 'npm run dev');
});

test('buildTerminalWriteText returns null when neither command nor cwd is configured', () => {
  assert.equal(buildTerminalWriteText({}), null);
});

test('buildTerminalWriteText shell-quotes paths containing single quotes', () => {
  assert.equal(
    buildTerminalWriteText({ cwd: "/repos/dan's demo" }),
    "cd '/repos/dan'\\''s demo'",
  );
});

test('buildTerminalAppleScript uses do script and returns window id when command/cwd are configured', () => {
  const script = buildTerminalAppleScript({ command: 'npm run dev', cwd: '/repos/demo' });

  assert.ok(script.includes('tell application "Terminal"'));
  assert.ok(script.includes('do script "cd \'/repos/demo\' && npm run dev"'));
  assert.ok(script.includes('return id of window 1'));
});

test('buildTerminalAppleScript creates a bare window when no command or cwd is configured', () => {
  const script = buildTerminalAppleScript({});

  assert.ok(script.includes('make new window'));
  assert.ok(script.includes('return id of newWin'));
  assert.ok(!script.includes('do script'));
});

test('buildGhosttySurfaceConfig emits both initial working directory and command fields', () => {
  assert.equal(
    buildGhosttySurfaceConfig({ command: 'npm run dev', cwd: '/repos/demo' }),
    '{initial working directory:"/repos/demo", command:"npm run dev"}',
  );
});

test('buildGhosttySurfaceConfig emits only command when no cwd is configured', () => {
  assert.equal(
    buildGhosttySurfaceConfig({ command: 'npm run dev' }),
    '{command:"npm run dev"}',
  );
});

test('buildGhosttySurfaceConfig escapes embedded double quotes in cwd and command', () => {
  assert.equal(
    buildGhosttySurfaceConfig({ command: 'echo "hi"', cwd: '/repo/a"b' }),
    '{initial working directory:"/repo/a\\"b", command:"echo \\"hi\\""}',
  );
});

test('buildGhosttySurfaceConfig returns null when neither command nor cwd is configured', () => {
  assert.equal(buildGhosttySurfaceConfig({}), null);
});

test('buildGhosttyAppleScript uses new window with configuration and returns window id', () => {
  const script = buildGhosttyAppleScript({ command: 'npm run dev', cwd: '/repos/demo' });

  assert.ok(script.includes('tell application "Ghostty"'));
  assert.ok(script.includes('new window with configuration'));
  assert.ok(script.includes('initial working directory:"/repos/demo"'));
  assert.ok(script.includes('command:"npm run dev"'));
  assert.ok(script.includes('return id of newWin'));
});

test('buildGhosttyAppleScript creates a bare window when no command or cwd is configured', () => {
  const script = buildGhosttyAppleScript({});

  assert.ok(script.includes('set newWin to (new window)'));
  assert.ok(script.includes('return id of newWin'));
  assert.ok(!script.includes('with configuration'));
});

test('buildAlacrittyMsgArgs wraps the command in sh -c to preserve shell tokenization', () => {
  assert.deepEqual(
    buildAlacrittyMsgArgs({ command: 'npm run dev', cwd: '/repos/demo', socketPath: '/tmp/alac.sock' }),
    ['msg', '--socket', '/tmp/alac.sock', 'create-window', '--working-directory', '/repos/demo', '--command', 'sh', '-c', 'npm run dev'],
  );
});

test('buildAlacrittyMsgArgs omits socket and cwd flags when not configured', () => {
  assert.deepEqual(
    buildAlacrittyMsgArgs({ command: 'npm run dev' }),
    ['msg', 'create-window', '--command', 'sh', '-c', 'npm run dev'],
  );
});

test('buildAlacrittyMsgArgs omits --command when not configured', () => {
  assert.deepEqual(
    buildAlacrittyMsgArgs({ cwd: '/repos/demo', socketPath: '/tmp/alac.sock' }),
    ['msg', '--socket', '/tmp/alac.sock', 'create-window', '--working-directory', '/repos/demo'],
  );
});

test('buildKittyAtLaunchArgs builds an os-window launch with cwd and sh -c wrapped command', () => {
  assert.deepEqual(
    buildKittyAtLaunchArgs({ command: 'npm run dev', cwd: '/repos/demo' }),
    ['@', 'launch', '--type', 'os-window', '--cwd', '/repos/demo', 'sh', '-c', 'npm run dev'],
  );
});

test('buildKittyAtLaunchArgs omits --cwd when not configured', () => {
  assert.deepEqual(
    buildKittyAtLaunchArgs({ command: 'npm run dev' }),
    ['@', 'launch', '--type', 'os-window', 'sh', '-c', 'npm run dev'],
  );
});

test('buildKittyAtLaunchArgs omits command entirely when not configured', () => {
  assert.deepEqual(
    buildKittyAtLaunchArgs({ cwd: '/repos/demo' }),
    ['@', 'launch', '--type', 'os-window', '--cwd', '/repos/demo'],
  );
});

test('buildKittyAtCloseArgs builds a close-window match by kitty window id', () => {
  assert.deepEqual(
    buildKittyAtCloseArgs('42'),
    ['@', 'close-window', '--match', 'id:42'],
  );
});

test('buildKittyAtCloseArgs returns null for an invalid kitty window id', () => {
  assert.equal(buildKittyAtCloseArgs(undefined), null);
  assert.equal(buildKittyAtCloseArgs(''), null);
  assert.equal(buildKittyAtCloseArgs(null), null);
});
