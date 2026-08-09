import { launchChromeWindowWithUrl } from '../launchers/chrome.js';

const SLACK_APP_ALIASES = new Set([
  'slack',
]);

/**
 * Supported `slack://` URL targets. `channel` covers public, private, and
 * group DMs; `user` opens a one-on-one DM. Slack's URI scheme does not define
 * any other target kinds.
 */
const SUPPORTED_TARGETS = new Set(['channel', 'user']);

function isSlackApp(app) {
  if (typeof app !== 'string') {
    return false;
  }

  return SLACK_APP_ALIASES.has(app.trim().toLowerCase());
}

/**
 * Build a `slack://` URL from structured channel/user config.
 *
 * @param {{ target?: string, team: string, id: string }} options
 * @returns {string}
 */
export function buildSlackUri({ target = 'channel', team, id } = {}) {
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`unknown slack target: ${target}`);
  }
  if (typeof team !== 'string' || team === '') {
    throw new Error('buildSlackUri requires a team id');
  }
  if (typeof id !== 'string' || id === '') {
    throw new Error('buildSlackUri requires a channel or user id');
  }

  return `slack://${target}?team=${team}&id=${id}`;
}

/**
 * Parse a `slack://` URI into its target/team/id components.
 *
 * @param {string} uri
 * @returns {{ target: string, team: string, id: string }}
 */
export function parseSlackUri(uri) {
  if (typeof uri !== 'string' || uri === '') {
    throw new Error('parseSlackUri requires a non-empty string');
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`parseSlackUri could not parse uri: ${uri}`);
  }

  if (parsed.protocol !== 'slack:') {
    throw new Error(`parseSlackUri requires a slack: scheme uri: ${uri}`);
  }

  const target = parsed.hostname;
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`parseSlackUri encountered unknown or missing target: ${target || '(none)'}`);
  }

  const team = parsed.searchParams.get('team');
  const id = parsed.searchParams.get('id');

  if (typeof team !== 'string' || team === '') {
    throw new Error(`parseSlackUri requires a team query parameter: ${uri}`);
  }
  if (typeof id !== 'string' || id === '') {
    throw new Error(`parseSlackUri requires an id query parameter: ${uri}`);
  }

  return { target, team, id };
}

/**
 * Build the Slack web-client URL used when the operator opts into browser mode.
 *
 * Both channels and DMs use the same `app.slack.com/client/<team>/<id>` shape;
 * Slack distinguishes them by the id prefix (C/D for channels, U for users).
 *
 * @param {{ team: string, id: string }} options
 * @returns {string}
 */
export function buildSlackWebUrl({ team, id }) {
  if (typeof team !== 'string' || team === '') {
    throw new Error('buildSlackWebUrl requires a team id');
  }
  if (typeof id !== 'string' || id === '') {
    throw new Error('buildSlackWebUrl requires a channel or user id');
  }

  return `https://app.slack.com/client/${team}/${id}`;
}

/**
 * Normalize Slack source config into a single resolved shape regardless of
 * whether the operator wrote the structured `slack` field or the raw `uri`
 * shorthand.
 *
 * Returns `null` when neither field is present — the adapter's `matches()`
 * uses that to fall through to the default adapter for plain `app: "Slack"`.
 *
 * @param {{ slack?: { target?: string, team?: string, id?: string, newWindow?: boolean }, uri?: string, newWindow?: boolean } | null} source
 * @returns {{ target: string, team: string, id: string, newWindow: boolean } | null}
 */
export function resolveSlackConfig(source) {
  if (!source || typeof source !== 'object') {
    return null;
  }

  if (source.slack && typeof source.slack === 'object') {
    const { target = 'channel', team, id } = source.slack;

    if (typeof team !== 'string' || team === '' || typeof id !== 'string' || id === '') {
      return null;
    }

    return {
      target,
      team,
      id,
      newWindow: source.slack.newWindow === true,
    };
  }

  if (typeof source.uri === 'string' && source.uri !== '') {
    const parsed = parseSlackUri(source.uri);

    return {
      ...parsed,
      newWindow: source.newWindow === true,
    };
  }

  return null;
}

/**
 * Slack app adapter.
 *
 * Slack's `slack://` URL scheme navigates the already-running desktop app
 * rather than spawning a new window — that means Deckhand cannot own or close
 * the resulting state. This adapter supports two modes to give the operator a
 * real choice:
 *
 * - **Navigation mode (default).** `open "slack://channel?..."` tells the
 *   running Slack to switch to a channel/DM. No new window, no diff binding,
 *   no close. The Slack window stays wherever the operator placed it;
 *   OBS/Hammerspoon fall back to app + titleIncludes matching.
 *
 * - **Browser mode (`newWindow: true`).** A new Google Chrome window is
 *   created via AppleScript pointing at `https://app.slack.com/client/...`.
 *   The operator's normal Chrome profile is used (so they are already logged
 *   in), the new window is bindable by CGWindowID diff, and shutdown closes
 *   that exact window via the standard AX path.
 *
 * `open -n -a "Google Chrome" URL` does NOT work — Chrome silently forwards
 * the URL to the running instance and opens a tab rather than a window.
 * AppleScript `make new window` is the only reliable way to spawn a fresh
 * Chrome window with a URL in an existing process.
 *
 * Config accepted in two shapes:
 *
 * ```json
 * { "app": "Slack", "slack": { "target": "channel", "team": "T...", "id": "C..." }, "newWindow": true }
 * { "app": "Slack", "uri": "slack://channel?team=T...&id=C..." }
 * ```
 */
export const slackAdapter = {
  id: 'slack',
  matches(source) {
    return isSlackApp(source?.app) && resolveSlackConfig(source) !== null;
  },
  cgWindowOwnerName(source) {
    const cfg = resolveSlackConfig(source);
    return cfg?.newWindow ? 'Google Chrome' : 'Slack';
  },
  buildBootstrapBinding(source, configuredBinding = {}) {
    const cfg = resolveSlackConfig(source);

    if (cfg?.newWindow) {
      return {
        ...configuredBinding,
        app: 'Google Chrome',
        titleIncludes: configuredBinding.titleIncludes ?? 'Slack',
      };
    }

    return {
      ...configuredBinding,
      app: 'Slack',
    };
  },
  ownsWindow(source) {
    const cfg = resolveSlackConfig(source);
    return cfg?.newWindow === true;
  },
  async launch(source, ctx = {}) {
    const cfg = resolveSlackConfig(source);

    if (cfg === null) {
      throw new Error('Slack adapter requires either `slack: {target, team, id}` or `uri: "slack://..."`');
    }

    if (cfg.newWindow) {
      const url = buildSlackWebUrl({ team: cfg.team, id: cfg.id });
      const launchChrome = ctx.launchChromeWindowWithUrl ?? launchChromeWindowWithUrl;
      return launchChrome(url);
    }

    const uri = source.uri ?? buildSlackUri(cfg);
    const launchApp = ctx.launchAppWindow ?? (async () => ({}));
    return launchApp({ app: 'Slack', openArgs: [uri] });
  },
  discardUnsavedChangesOnClose: false,
};

export { isSlackApp };
