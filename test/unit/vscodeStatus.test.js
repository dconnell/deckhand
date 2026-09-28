import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listOpenVsCodeWorkspaces,
  parseVsCodeStatusWorkspaces,
  vscodeAdapter,
} from '../../src/apps/vscode.js';

// Mirrors the operator's real `code --status` Workspace Stats block: Window
// rows are display titles (`folder` when no file is focused, `file — folder`
// otherwise), while Folder rows are the aggregated union of open workspace
// roots across ALL windows.
const SAMPLE_STATUS_OUTPUT = [
  'Version:          1.92.0',
  'Commit:           abc123',
  'Workspace Stats: ',
  '|  Window (dc-enclave)',
  '|  Window (README.md — deckhand)',
  '|    Folder (deckhand): 165 files',
  '|      File types: js(118) md(15) ...',
  '|    Folder (dc-enclave): 1768 files',
  '|      File types: log(1543) sh(108) md(62) ...',
  '',
].join('\n');

test('parseVsCodeStatusWorkspaces collects only Folder names from the Workspace Stats section', () => {
  const cases = [
    {
      name: 'sample `code --status` block yields the union of open folders; Window titles are not collected',
      output: SAMPLE_STATUS_OUTPUT,
      expected: ['deckhand', 'dc-enclave'],
    },
    {
      name: 'output without a Workspace Stats section yields no names',
      output: [
        'Version: 1.92.0',
        '|  Window (decoy)',
        '|    Folder (decoy): 1 files',
      ].join('\n'),
      expected: [],
    },
    {
      name: 'Window lines are ignored even inside the section',
      output: [
        '|  Window (before)',
        'Workspace Stats:',
        '|  Window (after)',
        '|    Folder (real): 5 files',
      ].join('\n'),
      expected: ['real'],
    },
    {
      name: 'File types and Conf files lines are ignored',
      output: [
        'Workspace Stats:',
        '|    Folder (only): 9 files',
        '|      File types: js(118)',
        '|      Conf files: settings.json(1)',
      ].join('\n'),
      expected: ['only'],
    },
    {
      name: 'Folder lines with a trailing file count capture the name only',
      output: [
        'Workspace Stats:',
        '|    Folder (deckhand): 165 files',
      ].join('\n'),
      expected: ['deckhand'],
    },
  ];

  for (const { name, output, expected } of cases) {
    const actual = parseVsCodeStatusWorkspaces(output);

    assert.deepEqual([...actual].sort(), [...expected].sort(), name);
  }
});

test('parseVsCodeStatusWorkspaces excludes file-name window-title noise', () => {
  // A window titled `app.js — my-site` must NOT read as project `app` being
  // open: Window rows are display strings, so only the Folder row counts.
  const names = parseVsCodeStatusWorkspaces([
    'Workspace Stats:',
    '|  Window (app.js — my-site)',
    '|    Folder (my-site): 12 files',
  ].join('\n'));

  assert.deepEqual(names, ['my-site']);
  assert.ok(!names.includes('app.js — my-site'));
});

test('parseVsCodeStatusWorkspaces dedupes repeated folder names', () => {
  const names = parseVsCodeStatusWorkspaces([
    'Workspace Stats:',
    '|    Folder (deckhand): 165 files',
    '|    Folder (deckhand): 165 files',
  ].join('\n'));

  assert.deepEqual(names, ['deckhand']);
});

test('parseVsCodeStatusWorkspaces covers a bare window via its Folder row', () => {
  // A bare `Window (dc-enclave)` (no file focused) is still covered: the
  // aggregated Folder row for the same root exists, so dropping Window
  // collection loses no real "what's open" signal.
  const names = parseVsCodeStatusWorkspaces([
    'Workspace Stats:',
    '|  Window (dc-enclave)',
    '|    Folder (dc-enclave): 1768 files',
  ].join('\n'));

  assert.deepEqual(names, ['dc-enclave']);
});

test('listOpenVsCodeWorkspaces returns the parsed folder names on success', async () => {
  const names = await listOpenVsCodeWorkspaces({
    execFn: () => SAMPLE_STATUS_OUTPUT,
  });

  assert.deepEqual(
    [...names].sort(),
    ['deckhand', 'dc-enclave'].sort(),
  );
});

test('listOpenVsCodeWorkspaces accepts an executor that returns a promise of the output', async () => {
  // The default executor runs `code --status` via execFile, so the real
  // contract is promise-based; the probe must resolve it, not treat the
  // promise itself as unparsable output.
  const names = await listOpenVsCodeWorkspaces({
    execFn: () => Promise.resolve(SAMPLE_STATUS_OUTPUT),
  });

  assert.deepEqual(
    [...names].sort(),
    ['deckhand', 'dc-enclave'].sort(),
  );
});

test('listOpenVsCodeWorkspaces returns null when the probe fails', async () => {
  const cases = [
    {
      name: 'exec throws (CLI absent, non-zero exit, or timeout)',
      execFn: () => {
        throw new Error('command not found: code');
      },
    },
    {
      name: 'exec rejects (the async execFile contract)',
      execFn: () => Promise.reject(new Error('command not found: code')),
    },
    {
      name: 'empty output',
      execFn: () => '',
    },
    {
      name: 'output without a parsable section',
      execFn: () => 'some unrelated output',
    },
  ];

  for (const { name, execFn } of cases) {
    assert.equal(await listOpenVsCodeWorkspaces({ execFn }), null, name);
  }
});

test('vscodeAdapter exposes listOpenWorkspaceNames for the preflight probe', () => {
  // Why the preflight prefers the probe over window titles: `code --status`
  // needs no Screen Recording permission (titles come back empty without it)
  // and also reports folders inside multi-root windows, which titles never show.
  // The probe is async (it shells out via execFile), so the preflight collector
  // awaits it; the function is not invoked here because there is no injected
  // executor on the adapter and the real CLI may not exist on this machine.
  assert.equal(typeof vscodeAdapter.listOpenWorkspaceNames, 'function');
});
