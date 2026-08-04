import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIterm2WriteText, buildIterm2AppleScript } from '../../src/launchers/iterm2.js';
import { buildOpenArgs, buildVsCodeLaunchArgs, isVisualStudioCodeApp } from '../../src/launchers/app.js';

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

test('isVisualStudioCodeApp matches Visual Studio Code aliases', () => {
  assert.equal(isVisualStudioCodeApp('Visual Studio Code'), true);
  assert.equal(isVisualStudioCodeApp('Code'), true);
  assert.equal(isVisualStudioCodeApp('visual studio code'), true);
  assert.equal(isVisualStudioCodeApp('Visual Studio'), false);
});

test('buildVsCodeLaunchArgs injects --new-window and --user-data-dir when absent', () => {
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
