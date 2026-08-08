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
 * Produces `['-n', '-a', appName]`, appending `--args` plus any launch arguments
 * when supplied. The `-n` flag forces a **new instance** so the diff resolver
 * can find a newly-appeared CGWindowID — without it, Electron single-instance
 * apps (VS Code, Slack) silently hand off to the already-running process and
 * reuse the existing window, producing no new CGWindowID to bind.
 *
 * @param {{ app: string, args?: string[] }} options Launch options.
 * @returns {string[]}
 */
export function buildOpenArgs({ app, args }) {
  const openArgs = ['-n', '-a', app];

  if (Array.isArray(args) && args.length > 0) {
    openArgs.push('--args', ...args);
  }

  return openArgs;
}

/**
 * Launch a generic app window via macOS `open -a`.
 *
 * `open` returns before the window appears, so the caller must poll and diff to
 * capture the new window. Electron single-instance apps (VS Code) hand off to
 * an already-running process, which is exactly why owned `app` sources capture
 * by owner-name diff rather than child PID (`plans/app-sources.md`).
 *
 * No-ops off macOS so the launch layer is safe to construct on non-darwin hosts.
 *
 * @param {{ app: string, args?: string[], cwd?: string }} options Launch options.
 * @returns {Promise<{ ownerName: string }>}
 */
export async function launchAppWindow({ app, args, cwd }) {
  if (process.platform !== 'darwin') {
    return { ownerName: app };
  }

  await spawnAndWait('open', buildOpenArgs({ app, args }), cwd, `open -a ${app}`);

  return { ownerName: app };
}
