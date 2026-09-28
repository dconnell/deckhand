import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectOwnedAppInstanceConflicts,
  filterRealWindows,
  resolveWorkspaceHint,
} from '../../src/preflightOwnedApps.js';
import { createCaptureLogger, createNoopLogger } from '../helpers/logger.js';

/**
 * Minimal adapter stub shaped like the real registry adapters: the collector
 * only reads `requiresExclusiveInstance` and `cgWindowOwnerName`.
 */
function createGatedAdapter(ownerName) {
  return {
    matches: () => true,
    cgWindowOwnerName: () => ownerName,
    requiresExclusiveInstance: true,
  };
}

function createUngatedAdapter(ownerName) {
  return {
    matches: () => true,
    cgWindowOwnerName: () => ownerName,
  };
}

/**
 * Gated adapter stub that can also answer the `code --status` workspace probe,
 * shaped like the real vscode adapter: the probe runs `code --status` as an
 * async subprocess, so the stub resolves a promise to pin that contract.
 */
function createProbingGatedAdapter(ownerName, probeResult) {
  return {
    ...createGatedAdapter(ownerName),
    listOpenWorkspaceNames: () => Promise.resolve(probeResult),
  };
}

function createEnumerateSpy(windowsByOwner = {}) {
  const calls = [];

  return {
    calls,
    enumerateWindowsByOwnerNameFn: (ownerName) => {
      calls.push(ownerName);
      return windowsByOwner[ownerName] ?? [];
    },
  };
}

function createCase({
  config,
  adapterByApp,
  windowsByOwner = {},
  enumerationError = null,
}) {
  return {
    config,
    resolveAppAdapterFn: (source) => adapterByApp[source.app],
    enumerateWindowsByOwnerNameFn: (ownerName) => {
      if (enumerationError !== null) {
        throw enumerationError;
      }

      return windowsByOwner[ownerName] ?? [];
    },
  };
}

async function collectConflicts(input) {
  return collectOwnedAppInstanceConflicts({
    config: input.config,
    enumerateWindowsByOwnerNameFn: input.enumerateWindowsByOwnerNameFn,
    resolveAppAdapterFn: input.resolveAppAdapterFn ?? ((source) => input.adapterByApp[source.app]),
    logger: input.logger ?? createNoopLogger(),
  });
}

test('collectOwnedAppInstanceConflicts reports one conflict per gated app source with open windows', async () => {
  const cases = [
    {
      name: 'vscode-style gated source with two open windows',
      input: createCase({
        config: { sources: { Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' } } },
        adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
        windowsByOwner: {
          Code: [
            { windowId: 1, title: 'preflightOwnedApps.js — deckhand' },
            { windowId: 2, title: 'README.md — deckhand' },
          ],
        },
      }),
      expected: [{
        sourceId: 'Editor',
        app: 'Visual Studio Code',
        ownerName: 'Code',
        windowCount: 2,
        match: null,
      }],
    },
    {
      name: 'gated source whose owner reports a single window',
      input: createCase({
        config: { sources: { Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' } } },
        adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
        windowsByOwner: { Code: [{ windowId: 9, title: 'slides.md — deckhand' }] },
      }),
      expected: [{
        sourceId: 'Editor',
        app: 'Visual Studio Code',
        ownerName: 'Code',
        windowCount: 1,
        match: null,
      }],
    },
  ];

  for (const { name, input, expected } of cases) {
    assert.deepEqual(await collectConflicts(input), expected, name);
  }
});

test('collectOwnedAppInstanceConflicts reports no conflict when the gated owner has zero windows', async () => {
  const conflicts = await collectOwnedAppInstanceConflicts({
    config: { sources: { Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' } } },
    enumerateWindowsByOwnerNameFn: () => [],
    resolveAppAdapterFn: () => createGatedAdapter('Code'),
    logger: createNoopLogger(),
  });

  assert.deepEqual(conflicts, []);
});

test('collectOwnedAppInstanceConflicts skips terminal-family apps even when they have open windows', async () => {
  // Terminal-family apps are deliberately NOT gated: deckhand adds windows to
  // the already-running instance by design (operators launch deckhand from a
  // terminal), so open iTerm windows must not block startup.
  const conflicts = await collectOwnedAppInstanceConflicts({
    config: { sources: { Terminal: { id: 'Terminal', kind: 'app', app: 'iTerm2' } } },
    enumerateWindowsByOwnerNameFn: () => [{ windowId: 1 }, { windowId: 2 }, { windowId: 3 }],
    resolveAppAdapterFn: () => createUngatedAdapter('iTerm'),
    logger: createNoopLogger(),
  });

  assert.deepEqual(conflicts, []);
});

test('collectOwnedAppInstanceConflicts skips the check and logs a warning when enumeration throws', async () => {
  const logger = createCaptureLogger();

  const conflicts = await collectOwnedAppInstanceConflicts({
    config: { sources: { Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' } } },
    enumerateWindowsByOwnerNameFn: () => {
      throw new Error('CGWindowList exploded');
    },
    resolveAppAdapterFn: () => createGatedAdapter('Code'),
    logger,
  });

  assert.deepEqual(conflicts, []);
  assert.equal(logger.warns.length, 1);
  assert.match(logger.warns[0].message, /Failed to enumerate windows for owned app during preflight/);
  assert.equal(logger.warns[0].context.source.app, 'Visual Studio Code');
  assert.match(logger.warns[0].context.error, /CGWindowList exploded/);
});

test('collectOwnedAppInstanceConflicts flags only the gated source in a mixed config', async () => {
  // VS Code running + iTerm2 running: only VS Code conflicts. iTerm2 joins the
  // running instance by design, so its open windows are expected, not an error.
  const conflicts = await collectOwnedAppInstanceConflicts({
    config: {
      sources: {
        Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' },
        Terminal: { id: 'Terminal', kind: 'app', app: 'iTerm2' },
      },
    },
    enumerateWindowsByOwnerNameFn: (ownerName) => (
      ownerName === 'Code'
        ? [{ windowId: 1, title: 'slides.md — deckhand' }]
        : [{ windowId: 2, title: 'zsh' }, { windowId: 3, title: 'htop' }]
    ),
    resolveAppAdapterFn: (source) => (source.app === 'Visual Studio Code'
      ? createGatedAdapter('Code')
      : createUngatedAdapter('iTerm')),
    logger: createNoopLogger(),
  });

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 1,
    match: null,
  }]);
});

test('collectOwnedAppInstanceConflicts counts only titled windows when untitled helper entries are present', async () => {
  // Real-world report: CGWindowList returned 6 entries for the VS Code owner
  // while the operator had 2 real windows — Electron registers untitled
  // helper/utility entries alongside the real ones.
  const conflicts = await collectConflicts(createCase({
    config: { sources: { Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' } } },
    adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
    windowsByOwner: {
      Code: [
        { windowId: 1, title: 'postinstall.js — dc-enclave' },
        { windowId: 2, title: 'readme.md — deckhand' },
        { windowId: 3 },
        { windowId: 4 },
        { windowId: 5 },
        { windowId: 6 },
      ],
    },
  }));

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 2,
    match: null,
  }]);
});

test('collectOwnedAppInstanceConflicts conflicts only on windows of the configured workspace', async () => {
  const conflicts = await collectConflicts(createCase({
    config: {
      sources: {
        Editor: {
          id: 'Editor',
          kind: 'app',
          app: 'Visual Studio Code',
          args: ['--new-window', '/Users/me/repos/dc-enclave'],
        },
      },
    },
    adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
    windowsByOwner: {
      Code: [
        { windowId: 1, title: 'postinstall.js — dc-enclave' },
        { windowId: 2, title: 'readme — unrelated' },
      ],
    },
  }));

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 1,
    match: 'dc-enclave',
  }]);
});

test('collectOwnedAppInstanceConflicts reports no conflict when the configured workspace is not open', async () => {
  // The operator may keep unrelated VS Code projects open: without the
  // configured workspace itself, nothing blocks startup.
  const conflicts = await collectConflicts(createCase({
    config: {
      sources: {
        Editor: {
          id: 'Editor',
          kind: 'app',
          app: 'Visual Studio Code',
          args: ['--new-window', '/Users/me/repos/dc-enclave'],
        },
      },
    },
    adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
    windowsByOwner: {
      Code: [
        { windowId: 1, title: 'readme — unrelated' },
        { windowId: 2, title: 'other — second' },
      ],
    },
  }));

  assert.deepEqual(conflicts, []);
});

test('collectOwnedAppInstanceConflicts matches the workspace hint case-insensitively', async () => {
  const conflicts = await collectConflicts(createCase({
    config: {
      sources: {
        Editor: {
          id: 'Editor',
          kind: 'app',
          app: 'Visual Studio Code',
          args: ['--new-window', '/Users/me/repos/dc-enclave'],
        },
      },
    },
    adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
    windowsByOwner: { Code: [{ windowId: 1, title: 'README — DC-ENCLAVE' }] },
  }));

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 1,
    match: 'dc-enclave',
  }]);
});

test('collectOwnedAppInstanceConflicts falls back to a size filter when titles are unreadable', async () => {
  // Without Screen Recording permission every title comes back empty, so the
  // titled-window heuristic has nothing to work with; window size still
  // separates real windows from toolbar strips.
  const conflicts = await collectConflicts(createCase({
    config: { sources: { Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' } } },
    adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
    windowsByOwner: {
      Code: [
        { windowId: 1, width: 1800, height: 39 },
        { windowId: 2, width: 1400, height: 900 },
      ],
    },
  }));

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 1,
    match: null,
  }]);
});

test('collectOwnedAppInstanceConflicts derives the workspace hint from cwd when args and files are absent', async () => {
  const conflicts = await collectConflicts(createCase({
    config: {
      sources: {
        Editor: {
          id: 'Editor',
          kind: 'app',
          app: 'Visual Studio Code',
          cwd: '/Users/me/repos/dc-enclave',
        },
      },
    },
    adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
    windowsByOwner: { Code: [{ windowId: 1, title: 'postinstall.js — dc-enclave' }] },
  }));

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 1,
    match: 'dc-enclave',
  }]);
});

test('filterRealWindows keeps only titled windows when any entry has a title', () => {
  const windows = [
    { windowId: 1, title: 'main.js — deckhand' },
    { windowId: 2, title: '   ' },
    { windowId: 3 },
  ];

  assert.deepEqual(filterRealWindows(windows), [{ windowId: 1, title: 'main.js — deckhand' }]);
});

test('filterRealWindows falls back to a size filter when no entry has a title', () => {
  const windows = [
    { windowId: 1, width: 1800, height: 39 },
    { windowId: 2, width: 1400, height: 900 },
    { windowId: 3 },
    { windowId: 4, width: 200, height: 600 },
  ];

  // Entry 3 carries no dimensions: with no title and no size there is no basis
  // to call it a helper, so it is kept conservatively.
  assert.deepEqual(filterRealWindows(windows), [windows[1], windows[2]]);
});

test('filterRealWindows returns an empty list for non-array input', () => {
  assert.deepEqual(filterRealWindows(undefined), []);
});

test('resolveWorkspaceHint scans args, then files, then cwd for the first absolute path', () => {
  assert.equal(resolveWorkspaceHint({ args: ['--new-window', '/Users/me/repos/dc-enclave'] }), 'dc-enclave');
  assert.equal(resolveWorkspaceHint({ files: ['/Users/me/repos/dc-enclave/notes.md'] }), 'notes.md');
  assert.equal(resolveWorkspaceHint({ cwd: '/Users/me/repos/dc-enclave/' }), 'dc-enclave');
  assert.equal(resolveWorkspaceHint({
    args: ['--verbose'],
    files: ['relative/notes.md'],
    cwd: '/Users/me/repos/dc-enclave',
  }), 'dc-enclave');
  assert.equal(resolveWorkspaceHint({
    args: ['--new-window'],
    files: ['/Users/me/repos/dc-enclave'],
    cwd: '/tmp/somewhere-else',
  }), 'dc-enclave');
});

test('resolveWorkspaceHint returns null when no value is an absolute path', () => {
  assert.equal(resolveWorkspaceHint({}), null);
  assert.equal(resolveWorkspaceHint({ args: ['--new-window'] }), null);
  assert.equal(resolveWorkspaceHint({ files: ['relative/notes.md'] }), null);
  assert.equal(resolveWorkspaceHint(undefined), null);
});

test('resolveWorkspaceHint returns null for cwd / instead of an empty basename', () => {
  // path.basename('/') is '' — an empty hint would match every titled window
  // (title.includes('') is always true), so it must not be returned as a hint.
  assert.equal(resolveWorkspaceHint({ cwd: '/' }), null);
  assert.equal(resolveWorkspaceHint({ args: ['/'], files: ['/'], cwd: '/' }), null);
});

test('resolveWorkspaceHint skips empty-basename candidates and keeps scanning', () => {
  assert.equal(
    resolveWorkspaceHint({ args: ['--new-window', '/'], files: ['/Users/me/repos/dc-enclave'] }),
    'dc-enclave',
  );
  assert.equal(
    resolveWorkspaceHint({ args: ['/Users/me/repos/dc-enclave'], files: ['/'] }),
    'dc-enclave',
  );
});

test('collectOwnedAppInstanceConflicts treats an empty-basename hint as no hint', async () => {
  // cwd: '/' used to produce hint '' — every titled window then "matched" the
  // workspace and the conflict rendered as `already has "" open`. With no
  // usable hint the source must fall back to plain any-window semantics.
  const conflicts = await collectConflicts(createCase({
    config: {
      sources: {
        Editor: {
          id: 'Editor',
          kind: 'app',
          app: 'Visual Studio Code',
          cwd: '/',
        },
      },
    },
    adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
    windowsByOwner: {
      Code: [
        { windowId: 1, title: 'postinstall.js — dc-enclave' },
        { windowId: 2, title: 'readme — unrelated' },
      ],
    },
  }));

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 2,
    match: null,
  }]);
});

test('collectOwnedAppInstanceConflicts warns when hint mode sees real windows but no titles are readable', async () => {
  // Without Screen Recording permission every title comes back empty. In hint
  // mode that means the workspace check silently verified nothing — fail open,
  // but say so in the log.
  const logger = createCaptureLogger();

  const conflicts = await collectConflicts({
    ...createCase({
      config: {
        sources: {
          Editor: {
            id: 'Editor',
            kind: 'app',
            app: 'Visual Studio Code',
            args: ['--new-window', '/Users/me/repos/dc-enclave'],
          },
        },
      },
      adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
      windowsByOwner: {
        Code: [
          { windowId: 1, title: '', width: 1400, height: 900 },
          { windowId: 2, title: '', width: 1400, height: 900 },
        ],
      },
    }),
    logger,
  });

  assert.deepEqual(conflicts, []);
  assert.equal(logger.warns.length, 1);
  assert.equal(
    logger.warns[0].message,
    'Could not read window titles; unable to verify whether the workspace is already open',
  );
  assert.deepEqual(logger.warns[0].context, { source: 'Editor', app: 'Visual Studio Code' });
});

test('collectOwnedAppInstanceConflicts does not warn when hint mode can actually verify', async () => {
  // Guard against over-warning: the unreadable-titles warn applies only when
  // there are real windows AND none of them carries a non-empty title.
  const cases = [
    {
      name: 'zero real windows',
      windows: [],
    },
    {
      name: 'titled windows but none matching the hint',
      windows: [
        { windowId: 1, title: 'readme — unrelated' },
        { windowId: 2, title: 'other — second' },
      ],
    },
    {
      name: 'titled window matching the hint',
      windows: [{ windowId: 1, title: 'postinstall.js — dc-enclave' }],
    },
  ];

  for (const { name, windows } of cases) {
    const logger = createCaptureLogger();

    const conflicts = await collectConflicts({
      ...createCase({
        config: {
          sources: {
            Editor: {
              id: 'Editor',
              kind: 'app',
              app: 'Visual Studio Code',
              args: ['--new-window', '/Users/me/repos/dc-enclave'],
            },
          },
        },
        adapterByApp: { 'Visual Studio Code': createGatedAdapter('Code') },
        windowsByOwner: { Code: windows },
      }),
      logger,
    });

    assert.deepEqual(logger.warns, [], name);
    if (name === 'titled window matching the hint') {
      assert.equal(conflicts.length, 1, name);
    } else {
      assert.deepEqual(conflicts, [], name);
    }
  }
});

const HINTED_EDITOR_CONFIG = {
  sources: {
    Editor: {
      id: 'Editor',
      kind: 'app',
      app: 'Visual Studio Code',
      args: ['--new-window', '/Users/me/repos/dc-enclave'],
    },
  },
};

test('collectOwnedAppInstanceConflicts blocks on the workspace probe when it reports the configured workspace', async () => {
  // The probe (`code --status`) needs no Screen Recording permission, so its
  // answer is authoritative: a workspace-name match blocks with no window
  // count, and window enumeration is never consulted.
  const enumerate = createEnumerateSpy({ Code: [{ windowId: 1, title: 'readme — unrelated' }] });

  const conflicts = await collectConflicts({
    config: HINTED_EDITOR_CONFIG,
    adapterByApp: { 'Visual Studio Code': createProbingGatedAdapter('Code', ['deckhand', 'dc-enclave']) },
    ...enumerate,
  });

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: null,
    match: 'dc-enclave',
  }]);
  assert.deepEqual(enumerate.calls, [], 'the probe is authoritative; enumeration must not run');
});

test('collectOwnedAppInstanceConflicts proceeds without enumeration when the probe reports no match', async () => {
  // `[]` from the probe means "ran fine, nothing open" — unrelated windows of
  // the same app must not block startup, and enumeration stays silent.
  const enumerate = createEnumerateSpy({ Code: [{ windowId: 1, title: 'postinstall.js — dc-enclave' }] });

  const conflicts = await collectConflicts({
    config: HINTED_EDITOR_CONFIG,
    adapterByApp: { 'Visual Studio Code': createProbingGatedAdapter('Code', ['deckhand', 'other-project']) },
    ...enumerate,
  });

  assert.deepEqual(conflicts, []);
  assert.deepEqual(enumerate.calls, [], 'the probe is authoritative; enumeration must not run');
});

test('collectOwnedAppInstanceConflicts falls back to enumeration when the probe fails', async () => {
  // `null` means the probe itself failed (no CLI, non-zero exit, timeout,
  // unparsable): the pre-existing enumeration + title-matching path applies.
  const conflicts = await collectConflicts({
    config: HINTED_EDITOR_CONFIG,
    adapterByApp: { 'Visual Studio Code': createProbingGatedAdapter('Code', null) },
    ...createEnumerateSpy({
      Code: [
        { windowId: 1, title: 'postinstall.js — dc-enclave' },
        { windowId: 2, title: 'readme — unrelated' },
      ],
    }),
  });

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 1,
    match: 'dc-enclave',
  }]);
});

test('collectOwnedAppInstanceConflicts treats a throwing probe like a failed probe', async () => {
  const conflicts = await collectConflicts({
    config: HINTED_EDITOR_CONFIG,
    adapterByApp: {
      'Visual Studio Code': {
        ...createGatedAdapter('Code'),
        // The real probe rejects when the CLI cannot run; the collector must
        // treat a rejected promise exactly like a sync throw.
        async listOpenWorkspaceNames() {
          throw new Error('code --status exploded');
        },
      },
    },
    ...createEnumerateSpy({
      Code: [{ windowId: 1, title: 'postinstall.js — dc-enclave' }],
    }),
  });

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 1,
    match: 'dc-enclave',
  }]);
});

test('collectOwnedAppInstanceConflicts awaits a pending async probe before deciding', async () => {
  // Regression guard for the async probe conversion: if the collector forgot
  // to await, the promise itself reads as a non-array contract violation and
  // the run silently falls back to enumeration — losing the authoritative
  // probe answer this gate depends on.
  const enumerate = createEnumerateSpy({ Code: [{ windowId: 1, title: 'readme — unrelated' }] });

  const conflicts = await collectConflicts({
    config: HINTED_EDITOR_CONFIG,
    adapterByApp: {
      'Visual Studio Code': {
        ...createGatedAdapter('Code'),
        listOpenWorkspaceNames: () => new Promise((resolve) => {
          setTimeout(() => resolve(['deckhand', 'dc-enclave']), 5);
        }),
      },
    },
    ...enumerate,
  });

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: null,
    match: 'dc-enclave',
  }]);
  assert.deepEqual(enumerate.calls, [], 'a pending probe must still be authoritative; enumeration must not run');
});

test('collectOwnedAppInstanceConflicts does not consult the probe when there is no workspace hint', async () => {
  // Hint-less sources keep the any-window semantics; the probe is only
  // meaningful for workspace-scoped checks, so it must not even run.
  let probeCalls = 0;
  const adapter = {
    matches: () => true,
    cgWindowOwnerName: () => 'Code',
    requiresExclusiveInstance: true,
    // Returning a matching name makes this adversarial: if the collector ever
    // wrongly consults the probe, both the counter and the conflict shape
    // (match: 'dc-enclave' instead of null) change observably.
    listOpenWorkspaceNames() {
      probeCalls += 1;
      return ['dc-enclave'];
    },
  };

  const conflicts = await collectConflicts({
    config: { sources: { Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' } } },
    resolveAppAdapterFn: () => adapter,
    ...createEnumerateSpy({
      Code: [
        { windowId: 1, title: 'readme — deckhand' },
        { windowId: 2, title: 'other — second' },
      ],
    }),
  });

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 2,
    match: null,
  }]);
  assert.equal(probeCalls, 0, 'must not even run the probe when no workspace hint exists');
});

test('collectOwnedAppInstanceConflicts awaits promise-returning enumerators (the async CGWindowList default)', async () => {
  // The production `enumerateWindowsByOwnerName` is async after the Phase B
  // subprocess conversion; injected enumerators that resolve via a promise
  // must keep the exact same conflict semantics as synchronous fakes — a
  // hint-less gated source conflicts on every enumerated window.
  const conflicts = await collectOwnedAppInstanceConflicts({
    config: { sources: { Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' } } },
    enumerateWindowsByOwnerNameFn: async () => [
      { windowId: 1, title: 'slides.md — deckhand' },
      { windowId: 2, title: 'readme — unrelated' },
    ],
    resolveAppAdapterFn: () => createGatedAdapter('Code'),
    logger: createNoopLogger(),
  });

  assert.deepEqual(conflicts, [{
    sourceId: 'Editor',
    app: 'Visual Studio Code',
    ownerName: 'Code',
    windowCount: 2,
    match: null,
  }]);
});

test('collectOwnedAppInstanceConflicts skips the check when an async enumerator rejects', async () => {
  const logger = createCaptureLogger();

  const conflicts = await collectOwnedAppInstanceConflicts({
    config: { sources: { Editor: { id: 'Editor', kind: 'app', app: 'Visual Studio Code' } } },
    enumerateWindowsByOwnerNameFn: () => Promise.reject(new Error('swift timed out')),
    resolveAppAdapterFn: () => createGatedAdapter('Code'),
    logger,
  });

  assert.deepEqual(conflicts, []);
  assert.equal(logger.warns.length, 1);
  assert.match(logger.warns[0].message, /Failed to enumerate windows for owned app during preflight/);
  assert.match(logger.warns[0].context.error, /swift timed out/);
});
