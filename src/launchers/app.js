import { spawn } from 'node:child_process';

function spawnAndWait(command, args, cwd, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd ?? undefined,
      stdio: 'ignore',
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited with code ${code}`));
      }
    });
  });
}

/**
 * Build the argv for launching an app via macOS `open`.
 *
 * Produces `['-n', '-a', appName]`. When `files` is supplied, those paths are
 * appended as direct `open` arguments (opened as documents by the app) *before*
 * any `--args` block, since macOS `open` only opens positional files, not
 * `--args`-forwarded values — document-centric apps such as Preview, QuickTime
 * Player, and TextEdit ignore `--args` entirely. When launch `args` are also
 * supplied, they follow `--args` and are forwarded to the app's `main()`.
 *
 * `openArgs` is an escape hatch that takes precedence over both `files` and
 * `args`: when supplied, the tokens are appended verbatim after `-a <app>`
 * with no `--args` insertion and no positional handling, so the operator
 * controls exact `open` grammar for apps/features the named fields don't cover
 * (e.g. `-g`, `--env`, or opening a URL in a non-Chrome browser). It is
 * validated as mutually exclusive with `args`/`files` at the config layer.
 *
 * The `-n` flag forces a **new instance** so the diff resolver can find a
 * newly-appearing CGWindowID — without it, Electron single-instance apps (VS
 * Code, Slack) silently hand off to the already-running process and reuse the
 * existing window, producing no new CGWindowID to bind.
 *
 * @param {{ app: string, args?: string[], files?: string[], openArgs?: string[] }} options Launch options.
 * @returns {string[]}
 */
export function buildOpenArgs({ app, args, files, openArgs } = {}) {
  const openList = ['-n', '-a', app];

  if (Array.isArray(openArgs) && openArgs.length > 0) {
    openList.push(...openArgs);
    return openList;
  }

  if (Array.isArray(files) && files.length > 0) {
    openList.push(...files);
  }

  if (Array.isArray(args) && args.length > 0) {
    openList.push('--args', ...args);
  }

  return openList;
}

/**
 * Launch a generic app window via macOS `open -a`.
 *
 * `open` returns before the window appears, so the caller must poll and diff to
 * capture the new window. Electron single-instance apps (VS Code) hand off to
 * an already-running process, which is exactly why owned `app` sources capture
 * by owner-name diff rather than child PID (`plans/app-sources.md`).
 *
 * `files` are passed as direct `open` arguments so document-centric apps
 * (Preview, QuickTime Player) open them, unlike `args` which are forwarded to
 * the app's `main()` and ignored by such apps. `openArgs`, when supplied,
 * overrides both and is appended verbatim.
 *
 * No-ops off macOS so the launch layer is safe to construct on non-darwin hosts.
 *
 * @param {{ app: string, args?: string[], cwd?: string, files?: string[], openArgs?: string[] }} options Launch options.
 * @returns {Promise<{ ownerName: string }>}
 */
export async function launchAppWindow({ app, args, cwd, files, openArgs } = {}) {
  if (process.platform !== 'darwin') {
    return { ownerName: app };
  }

  await spawnAndWait('open', buildOpenArgs({ app, args, files, openArgs }), cwd, `open -a ${app}`);

  return { ownerName: app };
}
