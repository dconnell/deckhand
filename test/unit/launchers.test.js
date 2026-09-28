import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildVsCodeLaunchArgs, isVisualStudioCodeApp } from '../../src/apps/vscode.js';
import {
  buildIterm2WriteText,
  buildIterm2AppleScript,
  closeIterm2OwnedWindow,
  findIterm2Pid,
  launchIterm2Window,
} from '../../src/launchers/iterm2.js';
import {
  buildTerminalWriteText,
  buildTerminalAppleScript,
  closeTerminalOwnedWindow,
  findTerminalPid,
  launchTerminalWindow,
} from '../../src/launchers/appleTerminal.js';
import {
  buildGhosttySurfaceConfig,
  buildGhosttyAppleScript,
  closeGhosttyOwnedWindow,
  findGhosttyPid,
  launchGhosttyWindow,
} from '../../src/launchers/ghostty.js';
import {
  buildAlacrittyMsgArgs,
  findAlacrittySocket,
  findAlacrittyPid,
  launchAlacrittyWindow,
} from '../../src/launchers/alacritty.js';
import {
  buildKittyAtLaunchArgs,
  buildKittyAtCloseArgs,
  closeKittyOwnedWindow,
  findKittyPid,
  launchKittyWindow,
} from '../../src/launchers/kitty.js';
import { buildChromeWindowAppleScript, findChromePid, launchChromeWindowWithUrl } from '../../src/launchers/chrome.js';
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

test('buildIterm2AppleScript targets iTerm2 by bundle id so it compiles when iTerm2 is not running', () => {
  const script = buildIterm2AppleScript({ command: 'npm run dev', cwd: '/repos/demo' });

  // The name "iTerm2" only resolves while the app is running; on a cold start
  // osascript compiles the tell block without iTerm2's terminology and rejects
  // `create window with default profile` with a -2741 syntax error.
  assert.ok(script.includes('tell application id "com.googlecode.iterm2"'));
  assert.ok(!script.includes('tell application "iTerm2"'));
});

test('launchIterm2Window runs osascript asynchronously and resolves pid + sessionId', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });

    return script.includes('System Events') ? '4321\n' : 'session-uuid-1\n';
  };

  const result = await launchIterm2Window({
    command: 'npm run dev',
    cwd: '/repos/demo',
    execOsascriptFn,
  });

  assert.deepEqual(result, { pid: 4321, sessionId: 'session-uuid-1' });
  assert.equal(calls.length, 2);

  // execFile contract: each AppleScript travels as a single `-e` argv element
  // (never through a shell), with the pre-existing per-call timeout bounds.
  assert.ok(calls[0].script.includes('create window with default profile'));
  assert.equal(calls[0].options.timeoutMs, 10000);
  assert.ok(calls[1].script.includes('System Events'));
  assert.equal(calls[1].options.timeoutMs, 5000);
});

test('launchIterm2Window omits pid/sessionId when the probes yield nothing', { skip: process.platform !== 'darwin' }, async () => {
  const result = await launchIterm2Window({
    execOsascriptFn: async () => '   ',
  });

  assert.deepEqual(result, {});
});

test('launchIterm2Window rejects when the launch AppleScript fails', { skip: process.platform !== 'darwin' }, async () => {
  // Same failure contract as the previous sync implementation: the runtime
  // logs and skips the source instead of binding a phantom window.
  await assert.rejects(
    launchIterm2Window({
      command: 'npm run dev',
      execOsascriptFn: async () => {
        throw new Error('osascript: window creation failed');
      },
    }),
    /window creation failed/,
  );
});

test('closeIterm2OwnedWindow swallows osascript failures and skips empty session ids', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script) => {
    calls.push(script);
    throw new Error('window already closed');
  };

  // Best-effort by contract: a failed close must never hang or reject shutdown.
  await closeIterm2OwnedWindow('session-1', { execOsascriptFn });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('"session-1"'));

  await closeIterm2OwnedWindow('', { execOsascriptFn });
  assert.equal(calls.length, 1, 'an empty session id must not spawn osascript');
});

test('findIterm2Pid returns the parsed unix id, or null on failure or non-numeric output', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(await findIterm2Pid({ execOsascriptFn: async () => '4321\n' }), 4321);
  assert.equal(
    await findIterm2Pid({ execOsascriptFn: async () => { throw new Error('no iTerm running'); } }),
    null,
  );
  assert.equal(await findIterm2Pid({ execOsascriptFn: async () => 'iTerm2\n' }), null);
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

test('findTerminalPid returns the parsed unix id, or null on failure or non-numeric output', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });
    return '4321\n';
  };

  assert.equal(await findTerminalPid({ execOsascriptFn }), 4321);
  assert.equal(calls[0].options.timeoutMs, 5000);

  assert.equal(
    await findTerminalPid({ execOsascriptFn: async () => { throw new Error('no Terminal running'); } }),
    null,
  );
  assert.equal(await findTerminalPid({ execOsascriptFn: async () => 'Terminal\n' }), null);
});

test('launchTerminalWindow runs osascript asynchronously and resolves pid + terminalWindowId', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });

    return script.includes('System Events') ? '4321\n' : '5001\n';
  };

  const result = await launchTerminalWindow({
    command: 'npm run dev',
    cwd: '/repos/demo',
    execOsascriptFn,
  });

  assert.deepEqual(result, { pid: 4321, terminalWindowId: '5001' });
  assert.equal(calls.length, 2);

  // execFile contract: each AppleScript travels as a single `-e` argv element
  // (never through a shell), with the pre-existing per-call timeout bounds.
  assert.ok(calls[0].script.includes('do script'));
  assert.equal(calls[0].options.timeoutMs, 10000);
  assert.ok(calls[1].script.includes('System Events'));
  assert.equal(calls[1].options.timeoutMs, 5000);
});

test('launchTerminalWindow omits pid/windowId when the probes yield nothing', { skip: process.platform !== 'darwin' }, async () => {
  const result = await launchTerminalWindow({
    execOsascriptFn: async () => '   ',
  });

  assert.deepEqual(result, {});
});

test('closeTerminalOwnedWindow swallows osascript failures and skips non-numeric window ids', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });
    throw new Error('window already closed');
  };

  // Best-effort by contract: a failed close must never hang or reject shutdown.
  await closeTerminalOwnedWindow('5001', { execOsascriptFn });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].script.includes('id is 5001'));
  assert.equal(calls[0].options.timeoutMs, 5000);
  assert.equal(calls[0].options.discardOutput, true);

  await closeTerminalOwnedWindow('', { execOsascriptFn });
  await closeTerminalOwnedWindow('not-a-number', { execOsascriptFn });
  assert.equal(calls.length, 1, 'an unusable window id must not spawn osascript');
});

test('findGhosttyPid returns the parsed unix id, or null on failure or non-numeric output', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });
    return '4321\n';
  };

  assert.equal(await findGhosttyPid({ execOsascriptFn }), 4321);
  assert.equal(calls[0].options.timeoutMs, 5000);

  assert.equal(
    await findGhosttyPid({ execOsascriptFn: async () => { throw new Error('no Ghostty running'); } }),
    null,
  );
  assert.equal(await findGhosttyPid({ execOsascriptFn: async () => 'Ghostty\n' }), null);
});

test('launchGhosttyWindow runs osascript asynchronously and resolves pid + ghosttyWindowId', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });

    return script.includes('System Events') ? '4321\n' : 'tab-group-xyz\n';
  };

  const result = await launchGhosttyWindow({
    command: 'npm run dev',
    cwd: '/repos/demo',
    execOsascriptFn,
  });

  assert.deepEqual(result, { pid: 4321, ghosttyWindowId: 'tab-group-xyz' });
  assert.equal(calls.length, 2);

  assert.ok(calls[0].script.includes('new window with configuration'));
  assert.equal(calls[0].options.timeoutMs, 10000);
  assert.ok(calls[1].script.includes('System Events'));
  assert.equal(calls[1].options.timeoutMs, 5000);
});

test('closeGhosttyOwnedWindow swallows osascript failures and skips empty window ids', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });
    throw new Error('window already closed');
  };

  await closeGhosttyOwnedWindow('tab-group-xyz', { execOsascriptFn });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].script.includes('"tab-group-xyz"'));
  assert.equal(calls[0].options.timeoutMs, 5000);
  assert.equal(calls[0].options.discardOutput, true);

  await closeGhosttyOwnedWindow('', { execOsascriptFn });
  assert.equal(calls.length, 1, 'an empty window id must not spawn osascript');
});

test('findKittyPid returns the parsed unix id, or null on failure or non-numeric output', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });
    return '4321\n';
  };

  assert.equal(await findKittyPid({ execOsascriptFn }), 4321);
  assert.equal(calls[0].options.timeoutMs, 5000);

  assert.equal(
    await findKittyPid({ execOsascriptFn: async () => { throw new Error('no kitty running'); } }),
    null,
  );
  assert.equal(await findKittyPid({ execOsascriptFn: async () => 'kitty\n' }), null);
});

test('launchKittyWindow runs the remote-control launch asynchronously and resolves pid + kittyWindowId', { skip: process.platform !== 'darwin' }, async () => {
  process.env.KITTY_LISTEN_ON = 'unix:/tmp/kitty-test';

  try {
    const calls = [];
    const execKittyFn = async (args, options) => {
      calls.push({ args, options });

      return '42\n';
    };
    const execOsascriptFn = async () => '4321\n';

    const result = await launchKittyWindow({
      command: 'npm run dev',
      cwd: '/repos/demo',
      execKittyFn,
      execOsascriptFn,
    });

    assert.deepEqual(result, { pid: 4321, kittyWindowId: '42' });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].args,
      ['@', 'launch', '--type', 'os-window', '--cwd', '/repos/demo', 'sh', '-c', 'npm run dev'],
    );
    assert.equal(calls[0].options.timeoutMs, 10000);
  } finally {
    delete process.env.KITTY_LISTEN_ON;
  }
});

test('launchKittyWindow throws before spawning when KITTY_LISTEN_ON is not configured', { skip: process.platform !== 'darwin' }, async () => {
  const savedValue = process.env.KITTY_LISTEN_ON;
  delete process.env.KITTY_LISTEN_ON;

  try {
    let spawned = false;

    await assert.rejects(
      launchKittyWindow({
        command: 'npm run dev',
        execKittyFn: async () => {
          spawned = true;

          return '';
        },
        execOsascriptFn: async () => '4321\n',
      }),
      /KITTY_LISTEN_ON is not set/,
    );

    assert.equal(spawned, false);
  } finally {
    if (savedValue !== undefined) {
      process.env.KITTY_LISTEN_ON = savedValue;
    }
  }
});

test('closeKittyOwnedWindow swallows remote-control failures and skips invalid window ids', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execKittyFn = async (args, options) => {
    calls.push({ args, options });
    throw new Error('window already closed');
  };

  // Best-effort by contract: a failed close must never hang or reject shutdown.
  await closeKittyOwnedWindow('42', { execKittyFn });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['@', 'close-window', '--match', 'id:42']);
  assert.equal(calls[0].options.timeoutMs, 5000);
  assert.equal(calls[0].options.discardOutput, true);

  await closeKittyOwnedWindow('', { execKittyFn });
  await closeKittyOwnedWindow(undefined, { execKittyFn });
  assert.equal(calls.length, 1, 'an invalid window id must not spawn kitty');
});

test('findAlacrittySocket returns the first existing socket for the enumerated pids, or null', { skip: process.platform !== 'darwin' }, async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-alacritty-'));

  try {
    const calls = [];
    const execOsascriptFn = async (script, options) => {
      calls.push({ script, options });

      return '4711, 4712\n';
    };

    // Only the second pid gets a socket on disk — discovery must skip the first.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(tmpDir, 'Alacritty-4712.sock'), '');

    const socketPath = await findAlacrittySocket({ execOsascriptFn, tmpDir });

    assert.equal(socketPath, path.join(tmpDir, 'Alacritty-4712.sock'));
    assert.ok(calls[0].script.includes('every process whose name is "Alacritty"'));
    assert.equal(calls[0].options.timeoutMs, 5000);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('findAlacrittySocket returns null on empty, missing-value, or failed probes', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(
    await findAlacrittySocket({ execOsascriptFn: async () => '', tmpDir: os.tmpdir() }),
    null,
  );
  assert.equal(
    await findAlacrittySocket({ execOsascriptFn: async () => 'missing value', tmpDir: os.tmpdir() }),
    null,
  );
  assert.equal(
    await findAlacrittySocket({
      execOsascriptFn: async () => { throw new Error('no Alacritty running'); },
      tmpDir: os.tmpdir(),
    }),
    null,
  );
});

test('findAlacrittyPid returns the parsed unix id, or null on failure or non-numeric output', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(await findAlacrittyPid({ execOsascriptFn: async () => '4321\n' }), 4321);
  assert.equal(
    await findAlacrittyPid({ execOsascriptFn: async () => { throw new Error('no Alacritty running'); } }),
    null,
  );
  assert.equal(await findAlacrittyPid({ execOsascriptFn: async () => 'Alacritty\n' }), null);
});

test('launchAlacrittyWindow spawns the IPC create-window call asynchronously and resolves pid', { skip: process.platform !== 'darwin' }, async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-alacritty-'));

  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(tmpDir, 'Alacritty-4711.sock'), '');

    const spawns = [];

    const spawnFn = (command, args) => {
      spawns.push({ command, args });

      return {
        on(event, handler) {
          if (event === 'close') {
            handler(0);
          }
        },
      };
    };

    const result = await launchAlacrittyWindow({
      command: 'npm run dev',
      cwd: '/repos/demo',
      execOsascriptFn: async (script) => (script.includes('every process') ? '4711\n' : '4321\n'),
      tmpDir,
      spawnFn,
    });

    assert.deepEqual(result, { pid: 4321 });
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, 'alacritty');
    assert.deepEqual(
      spawns[0].args,
      ['msg', '--socket', path.join(tmpDir, 'Alacritty-4711.sock'), 'create-window', '--working-directory', '/repos/demo', '--command', 'sh', '-c', 'npm run dev'],
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('launchAlacrittyWindow rejects before spawning when no IPC socket is discoverable', { skip: process.platform !== 'darwin' }, async () => {
  let spawned = false;

  await assert.rejects(
    launchAlacrittyWindow({
      command: 'npm run dev',
      execOsascriptFn: async () => 'missing value',
      spawnFn: () => {
        spawned = true;

        return { on() {} };
      },
    }),
    /Alacritty is not running with an IPC socket/,
  );

  assert.equal(spawned, false);
});

test('launchAlacrittyWindow rejects when the create-window call exits non-zero', { skip: process.platform !== 'darwin' }, async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-alacritty-'));

  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(tmpDir, 'Alacritty-4711.sock'), '');

    await assert.rejects(
      launchAlacrittyWindow({
        command: 'npm run dev',
        execOsascriptFn: async () => '4711\n',
        tmpDir,
        spawnFn: () => ({
          on(event, handler) {
            if (event === 'close') {
              handler(1);
            }
          },
        }),
      }),
      /exited with code 1/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('findChromePid returns the parsed unix id, or null on failure or non-numeric output', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });
    return '4321\n';
  };

  assert.equal(await findChromePid({ execOsascriptFn }), 4321);
  assert.equal(calls[0].options.timeoutMs, 5000);

  assert.equal(
    await findChromePid({ execOsascriptFn: async () => { throw new Error('no Chrome running'); } }),
    null,
  );
  assert.equal(await findChromePid({ execOsascriptFn: async () => 'Google Chrome\n' }), null);
});

test('launchChromeWindowWithUrl runs osascript asynchronously and resolves the Chrome pid', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const execOsascriptFn = async (script, options) => {
    calls.push({ script, options });

    return script.includes('System Events') ? '4321\n' : '';
  };

  const result = await launchChromeWindowWithUrl('https://app.slack.com/client/T1/C1', { execOsascriptFn });

  assert.deepEqual(result, { pid: 4321 });
  assert.equal(calls.length, 2);

  // The launch script is built from the pinned builder and travels as a single
  // `-e` argv element with the pre-existing 10s launch bound.
  assert.equal(calls[0].script, buildChromeWindowAppleScript('https://app.slack.com/client/T1/C1'));
  assert.equal(calls[0].options.timeoutMs, 10000);
  assert.ok(calls[1].script.includes('System Events'));
  assert.equal(calls[1].options.timeoutMs, 5000);
});

test('launchChromeWindowWithUrl rejects on a missing URL without spawning', { skip: process.platform !== 'darwin' }, async () => {
  let spawned = false;

  await assert.rejects(
    launchChromeWindowWithUrl('', {
      execOsascriptFn: () => {
        spawned = true;

        return Promise.resolve('');
      },
    }),
    /requires a non-empty URL/,
  );

  await assert.rejects(
    launchChromeWindowWithUrl(undefined, { execOsascriptFn: async () => '' }),
    /requires a non-empty URL/,
  );

  assert.equal(spawned, false);
});

test('launchChromeWindowWithUrl rejects when the launch AppleScript fails', { skip: process.platform !== 'darwin' }, async () => {
  // Same failure contract as before the conversion: launch failures propagate
  // so the runtime can log and skip the source.
  await assert.rejects(
    launchChromeWindowWithUrl('https://example.com', {
      execOsascriptFn: async () => {
        throw new Error('osascript: Chrome not running');
      },
    }),
    /Chrome not running/,
  );
});
