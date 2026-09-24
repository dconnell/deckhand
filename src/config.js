import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const BUILTIN_DRIVER_TYPES = ['revealjs'];
const VALID_SLOT_POSITIONS = new Set(['full', 'left', 'right']);
const PRESENTER_OVERLAY_SOURCE = 'Presenter';
const CONSOLE_OVERLAY_SOURCE = 'Console';
// Overlay sources Deckhand owns itself; externalWindows must not shadow them.
const RESERVED_OVERLAY_SOURCES = new Set([PRESENTER_OVERLAY_SOURCE, CONSOLE_OVERLAY_SOURCE]);
const BROWSER_SOURCE_KIND = 'browser';
const APP_SOURCE_KIND = 'app';
const VALID_SOURCE_KINDS = new Set([BROWSER_SOURCE_KIND, APP_SOURCE_KIND]);
const VALID_BROWSER_ACTIONS = new Set(['activateTab', 'navigate']);
const VALID_STT_MODES = new Set(['step', 'vad']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value, pathName, message = 'must be an object') {
  if (!isPlainObject(value)) {
    throw new ConfigError(pathName, message);
  }

  return value;
}

function assertNonEmptyString(value, pathName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(pathName, 'must be a non-empty string');
  }

  return value.trim();
}

function assertBoolean(value, pathName) {
  if (typeof value !== 'boolean') {
    throw new ConfigError(pathName, 'must be a boolean');
  }

  return value;
}

function normalizePort(value, pathName) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(pathName, 'must be an integer between 1 and 65535');
  }

  return value;
}

function normalizeInteger(value, pathName) {
  if (!Number.isInteger(value)) {
    throw new ConfigError(pathName, 'must be an integer');
  }

  return value;
}

function normalizePositiveInteger(value, pathName, label = 'positive integer') {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(pathName, `must be a ${label}`);
  }

  return value;
}

function normalizePositiveNumber(value, pathName) {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new ConfigError(pathName, 'must be a positive number');
  }

  return value;
}

function normalizeIntegerAtLeast(value, pathName, minimum, label = `integer greater than or equal to ${minimum}`) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new ConfigError(pathName, `must be an ${label}`);
  }

  return value;
}

function normalizeNumberAtLeast(value, pathName, minimum, label = `number greater than or equal to ${minimum}`) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < minimum) {
    throw new ConfigError(pathName, `must be a ${label}`);
  }

  return value;
}

function normalizeAbsolutePath(value, pathName) {
  const resolved = assertNonEmptyString(value, pathName);

  if (!path.isAbsolute(resolved)) {
    throw new ConfigError(pathName, 'must be an absolute path');
  }

  return resolved;
}

/**
 * Validate an array of filesystem paths for an app source `files` field.
 *
 * Each entry must be a non-empty string. Absolute entries are kept as-is;
 * relative entries are resolved against `baseDir` (falling back to
 * `process.cwd()`) so a presentation may commit assets next to its config and
 * reference them portably. Unlike `cwd`/`args` — where a stale placeholder
 * still opens a window — a missing `files` path makes `open` exit non-zero
 * with no window, so resolving relative paths against the presentation
 * directory is what lets a shipped sample image open out of the box.
 *
 * @param {unknown} value The raw value.
 * @param {string} pathName The config path used in errors.
 * @param {string} [baseDir] Directory to resolve relative entries against.
 * @returns {string[]}
 */
function normalizeAbsolutePathArray(value, pathName, baseDir) {
  const entries = normalizeStringArray(value, pathName);
  const resolveAgainst = baseDir ?? process.cwd();

  return entries.map((entry, index) => {
    if (!path.isAbsolute(entry)) {
      return path.resolve(resolveAgainst, entry);
    }

    return entry;
  });
}

function normalizeStringArray(value, pathName) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new ConfigError(pathName, 'must be an array of non-empty strings');
  }

  return [...value];
}

function normalizeObsUrl(value, pathName) {
  const url = assertNonEmptyString(value, pathName);

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error('unsupported protocol');
    }

    return url;
  } catch {
    throw new ConfigError(pathName, 'must be a valid absolute OBS WebSocket URL');
  }
}

function normalizeNavigateUrl(value, pathName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(pathName, 'must be a valid absolute URL');
  }

  const url = value.trim();

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }

    return url;
  } catch {
    throw new ConfigError(pathName, 'must be a valid absolute URL');
  }
}

function normalizeDriver(driver) {
  const value = assertPlainObject(driver, 'driver');
  const type = assertNonEmptyString(value.type, 'driver.type');

  if (!BUILTIN_DRIVER_TYPES.includes(type)) {
    throw new ConfigError('driver.type', `must be one of: ${BUILTIN_DRIVER_TYPES.join(', ')}`);
  }

  return { type };
}

function normalizeBrowserWindow(window, pathName) {
  if (window === undefined) {
    return { label: null };
  }

  const value = assertPlainObject(window, pathName);
  const normalized = { label: null };

  if (value.label !== undefined) {
    normalized.label = assertNonEmptyString(value.label, `${pathName}.label`);
  }

  return normalized;
}

function normalizeBrowserTab(alias, entry, pathName) {
  const value = assertPlainObject(entry, pathName);
  const url = normalizeNavigateUrl(value.url, `${pathName}.url`);

  const tab = { url };

  if (value.preload !== undefined) {
    const preload = assertBoolean(value.preload, `${pathName}.preload`);

    if (!preload) {
      throw new ConfigError(`${pathName}.preload`, 'must preload all declared tabs at startup');
    }

    tab.preload = true;
  } else {
    tab.preload = true;
  }

  if (value.initial !== undefined) {
    tab.initial = assertBoolean(value.initial, `${pathName}.initial`);
  }

  return tab;
}

function normalizeBrowserCatalog(browser, pathName) {
  const value = assertPlainObject(browser, pathName);
  const tabsValue = assertPlainObject(value.tabs, `${pathName}.tabs`);
  const tabEntries = Object.entries(tabsValue);

  if (tabEntries.length === 0) {
    throw new ConfigError(`${pathName}.tabs`, 'must declare at least one tab');
  }

  const tabs = Object.fromEntries(
    tabEntries.map(([alias, entry]) => {
      const cleanAlias = assertNonEmptyString(alias, `${pathName}.tabs`);
      return [cleanAlias, normalizeBrowserTab(cleanAlias, entry, `${pathName}.tabs.${alias}`)];
    }),
  );

  const initialEntries = Object.entries(tabs).filter(([, tab]) => tab.initial === true);

  if (initialEntries.length > 1) {
    throw new ConfigError(pathName, 'must declare exactly one initial tab');
  }

  const initialTab = initialEntries.length === 1 ? initialEntries[0][0] : Object.keys(tabs)[0];

  for (const tab of Object.values(tabs)) {
    delete tab.initial;
  }

  const window = normalizeBrowserWindow(value.window, `${pathName}.window`);

  return {
    windowLabel: window.label,
    tabs,
    initialTab,
  };
}

/**
 * Normalize the `sources` catalog entry.
 *
 * @param {string} sourceId The source ID key from the catalog.
 * @param {unknown} entry The raw source descriptor.
 * @param {string} [baseDir] Directory to resolve relative `files` paths against.
 * @returns {{ id: string, kind: string, browser?: { windowLabel: string | null, tabs: Record<string, { url: string, preload: boolean }>, initialTab: string }, command?: string, cwd?: string, app?: string, args?: string[], files?: string[] }}
 */
function normalizeSourceEntry(sourceId, entry, baseDir) {
  const pathName = `sources.${sourceId}`;
  const value = assertPlainObject(entry, pathName);

  // Presenter/Console are Deckhand-owned overlay bindings; a catalog source
  // with the same id would silently collide with them in the overlay model.
  if (RESERVED_OVERLAY_SOURCES.has(sourceId)) {
    throw new ConfigError(pathName, `is a reserved overlay source id (reserved: ${[...RESERVED_OVERLAY_SOURCES].join(', ')})`);
  }

  const kind = assertNonEmptyString(value.kind, `${pathName}.kind`);

  if (!VALID_SOURCE_KINDS.has(kind)) {
    throw new ConfigError(`${pathName}.kind`, `must be one of: ${[...VALID_SOURCE_KINDS].join(', ')}`);
  }

  const source = {
    id: sourceId,
    kind,
  };

  if (kind === BROWSER_SOURCE_KIND) {
    source.browser = normalizeBrowserCatalog(value.browser, `${pathName}.browser`);
  } else if (kind === APP_SOURCE_KIND) {
    source.app = assertNonEmptyString(value.app, `${pathName}.app`);
    if (value.openArgs !== undefined && (value.args !== undefined || value.files !== undefined)) {
      throw new ConfigError(`${pathName}.openArgs`, 'is mutually exclusive with args and files');
    }
    normalizeOwnedLaunchFields(value, source, pathName, ['args', 'cwd', 'command', 'files', 'openArgs'], baseDir);
    normalizeSlackFields(value, source, pathName);
  }

  return source;
}

/**
 * Normalize the optional launch fields shared by owned app-window sources.
 *
 * `command`/`args`/`cwd`/`files` are only meaningful to the launch layer; here
 * we only validate their shape. Per-kind required fields (e.g. `app`) are
 * handled by the caller.
 *
 * @param {Record<string, unknown>} value The raw source descriptor.
 * @param {Record<string, unknown>} source The normalized source being built.
 * @param {string} pathName The config path of the source entry.
 * @param {Array<'command' | 'args' | 'cwd' | 'files'>} fields The optional fields to copy.
 */
function normalizeOwnedLaunchFields(value, source, pathName, fields, baseDir) {
  for (const field of fields) {
    if (value[field] === undefined) {
      continue;
    }

    if (field === 'args') {
      source.args = normalizeStringArray(value.args, `${pathName}.args`);
    } else if (field === 'cwd') {
      source.cwd = normalizeAbsolutePath(value.cwd, `${pathName}.cwd`);
    } else if (field === 'command') {
      source.command = assertNonEmptyString(value.command, `${pathName}.command`);
    } else if (field === 'files') {
      source.files = normalizeAbsolutePathArray(value.files, `${pathName}.files`, baseDir);
    } else if (field === 'openArgs') {
      source.openArgs = normalizeStringArray(value.openArgs, `${pathName}.openArgs`);
    }
  }
}

/**
 * Normalize Slack-adapter fields (`slack`, `uri`, `newWindow`).
 *
 * These are app-source fields the Slack adapter reads; the config layer only
 * validates their shape and passes them through. The Slack adapter
 * (`src/apps/slack.js`) is responsible for the structural validation that
 * actually decides navigation vs. browser mode.
 *
 * @param {Record<string, unknown>} value The raw source descriptor.
 * @param {Record<string, unknown>} source The normalized source being built.
 * @param {string} pathName The config path of the source entry.
 */
function normalizeSlackFields(value, source, pathName) {
  if (value.slack !== undefined) {
    source.slack = assertPlainObject(value.slack, `${pathName}.slack`);
  }

  if (value.uri !== undefined) {
    source.uri = assertNonEmptyString(value.uri, `${pathName}.uri`);
  }

  if (value.newWindow !== undefined) {
    if (typeof value.newWindow !== 'boolean') {
      throw new ConfigError(`${pathName}.newWindow`, 'must be a boolean');
    }
    source.newWindow = value.newWindow;
  }
}

/**
 * Normalize the authoritative `sources` catalog.
 *
 * @param {unknown} sources The raw sources object.
 * @param {string} [baseDir] Directory to resolve relative `files` paths against.
 * @returns {Record<string, { id: string, kind: string, browser?: { windowLabel: string | null, tabs: Record<string, { url: string, preload: boolean }>, initialTab: string }, command?: string, cwd?: string, app?: string, args?: string[], files?: string[] }>}
 */
function normalizeSources(sources, baseDir) {
  const value = assertPlainObject(sources, 'sources');
  const entries = Object.entries(value);

  if (entries.length === 0) {
    throw new ConfigError('sources', 'must define at least one source');
  }

  return Object.fromEntries(entries.map(([sourceId, entry]) => [sourceId, normalizeSourceEntry(sourceId, entry, baseDir)]));
}

function normalizeObsTransitions(value) {
  const t = assertPlainObject(value, 'obs.transitions');

  return {
    forward: typeof t.forward === 'string' && t.forward.trim() !== '' ? t.forward.trim() : null,
    backward: typeof t.backward === 'string' && t.backward.trim() !== '' ? t.backward.trim() : null,
    freezeScene: typeof t.freezeScene === 'string' && t.freezeScene.trim() !== '' ? t.freezeScene.trim() : 'Deckhand_Freeze',
    freezeImage: typeof t.freezeImage === 'string' && t.freezeImage.trim() !== '' ? t.freezeImage.trim() : 'Deckhand_Freeze Frame',
    freezeImagePath: typeof t.freezeImagePath === 'string' && t.freezeImagePath.trim() !== '' ? t.freezeImagePath.trim() : null,
    durationMs: Number.isFinite(t.durationMs) ? t.durationMs : 300,
    settleMs: Number.isFinite(t.settleMs) ? t.settleMs : 200,
    navigationWaitMs: Number.isFinite(t.navigationWaitMs) ? t.navigationWaitMs : 1000,
    windowSettleMs: Number.isFinite(t.windowSettleMs) ? t.windowSettleMs : 2000,
    freezeDimPercent: normalizeFreezeDimPercent(t.freezeDimPercent),
  };
}

/**
 * Validate the freeze-frame dim percentage.
 *
 * `0` disables the dim entirely; otherwise the value must lie in `0..100` and
 * is applied as a reduction of the freeze image source's opacity so the
 * presenter can see that a slide change has begun.
 *
 * @param {unknown} value The raw config value.
 * @returns {number}
 */
function normalizeFreezeDimPercent(value) {
  if (value === undefined) {
    return 5;
  }

  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 100) {
    throw new ConfigError('obs.transitions.freezeDimPercent', 'must be a number between 0 and 100');
  }

  return value;
}

function normalizeObs(obs) {
  const value = assertPlainObject(obs, 'obs');

  let transitions;
  if (value.transitions === undefined) {
    transitions = normalizeObsTransitions({});
  } else if (value.transitions === false || value.transitions === null) {
    transitions = null;
  } else {
    transitions = normalizeObsTransitions(value.transitions);
  }

  return {
    url: normalizeObsUrl(value.url, 'obs.url'),
    password: typeof value.password === 'string' ? value.password : '',
    transitions,
    prune: value.prune === undefined ? true : assertBoolean(value.prune, 'obs.prune'),
  };
}

function normalizeHub(hub) {
  const value = assertPlainObject(hub, 'hub');

  return {
    host: typeof value.host === 'string' && value.host.trim() !== '' ? value.host.trim() : '127.0.0.1',
    port: normalizePort(value.port, 'hub.port'),
  };
}

const RECOVERY_SUB_BLOCKS = new Set(['obsReconnect', 'browserRecover', 'resumeSlide']);

/**
 * Normalize a backoff sub-block (obsReconnect / browserRecover): an optional
 * `enabled` flag plus positive-integer `initialDelayMs` / `maxDelayMs` knobs.
 *
 * @param {unknown} value Raw sub-block.
 * @param {{ initialDelayMs: number, maxDelayMs: number }} defaults Fallbacks.
 * @param {string} pathName Config path prefix for errors.
 * @returns {{ enabled: boolean, initialDelayMs: number, maxDelayMs: number }}
 */
function normalizeRecoveryBackoff(value, defaults, pathName) {
  const block = value === undefined ? {} : assertPlainObject(value, pathName);
  const enabled = block.enabled === undefined ? true : assertBoolean(block.enabled, `${pathName}.enabled`);
  const initialDelayMs = block.initialDelayMs === undefined
    ? defaults.initialDelayMs
    : normalizePositiveInteger(block.initialDelayMs, `${pathName}.initialDelayMs`);
  const maxDelayMs = block.maxDelayMs === undefined
    ? defaults.maxDelayMs
    : normalizePositiveInteger(block.maxDelayMs, `${pathName}.maxDelayMs`);

  if (initialDelayMs > maxDelayMs) {
    throw new ConfigError(`${pathName}.initialDelayMs`, 'must not exceed maxDelayMs');
  }

  return { enabled, initialDelayMs, maxDelayMs };
}

/**
 * Normalize the optional top-level `recovery` block. Every sub-block defaults
 * to an enabled state so Deckhand recovers transports with zero configuration;
 * operators only need to opt out per subsystem.
 *
 * @param {unknown} recovery Raw recovery block.
 * @returns {{ obsReconnect: { enabled: boolean, initialDelayMs: number, maxDelayMs: number }, browserRecover: { enabled: boolean, initialDelayMs: number, maxDelayMs: number }, resumeSlide: { enabled: boolean } }}
 */
function normalizeRecovery(recovery) {
  if (recovery === undefined) {
    return {
      obsReconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5000 },
      browserRecover: { enabled: true, initialDelayMs: 500, maxDelayMs: 10000 },
      resumeSlide: { enabled: true },
    };
  }

  const value = assertPlainObject(recovery, 'recovery');

  for (const key of Object.keys(value)) {
    if (!RECOVERY_SUB_BLOCKS.has(key)) {
      throw new ConfigError(`recovery.${key}`, 'unknown recovery sub-block');
    }
  }

  return {
    obsReconnect: normalizeRecoveryBackoff(value.obsReconnect, { initialDelayMs: 250, maxDelayMs: 5000 }, 'recovery.obsReconnect'),
    browserRecover: normalizeRecoveryBackoff(value.browserRecover, { initialDelayMs: 500, maxDelayMs: 10000 }, 'recovery.browserRecover'),
    resumeSlide: (() => {
      const block = value.resumeSlide === undefined ? {} : assertPlainObject(value.resumeSlide, 'recovery.resumeSlide');

      return { enabled: block.enabled === undefined ? true : assertBoolean(block.enabled, 'recovery.resumeSlide.enabled') };
    })(),
  };
}

function normalizeLayoutSlot(layoutId, slot, index, sources) {
  const pathName = `layouts.${layoutId}.slots[${index}]`;
  const value = assertPlainObject(slot, pathName);
  const source = assertNonEmptyString(value.source, `${pathName}.source`);
  const position = assertNonEmptyString(value.position, `${pathName}.position`);

  if (!VALID_SLOT_POSITIONS.has(position)) {
    throw new ConfigError(`${pathName}.position`, 'must be one of: full, left, right');
  }

  if (!Object.prototype.hasOwnProperty.call(sources, source)) {
    throw new ConfigError(`${pathName}.source`, 'must reference a known source');
  }

  return {
    source,
    position,
  };
}

function normalizeOverlayRect(rect, pathName) {
  const value = assertPlainObject(rect, pathName);

  return {
    x: normalizeInteger(value.x, `${pathName}.x`),
    y: normalizeInteger(value.y, `${pathName}.y`),
    w: normalizePositiveInteger(value.w, `${pathName}.w`),
    h: normalizePositiveInteger(value.h, `${pathName}.h`),
  };
}

/**
 * Normalize a single overlay entry against a set of allowed window sources.
 *
 * @param {unknown} overlay The raw overlay entry.
 * @param {string} pathName The config path used in errors.
 * @param {Set<string>} allowedSources Overlay sources currently allowed
 *   (`Presenter`, `Console`, plus any `presenter.externalWindows` keys).
 * @returns {{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }}
 */
function normalizeOverlay(overlay, pathName, allowedSources) {
  const value = assertPlainObject(overlay, pathName);
  const source = assertNonEmptyString(value.source, `${pathName}.source`);

  if (!allowedSources.has(source)) {
    throw new ConfigError(`${pathName}.source`, `must be one of: ${[...allowedSources].join(', ')}`);
  }

  const hasRect = value.rect !== undefined;
  const hasHidden = value.hidden !== undefined;

  if (hasRect && hasHidden) {
    throw new ConfigError(pathName, 'must declare exactly one of rect or hidden');
  }

  if (!hasRect && !hasHidden) {
    throw new ConfigError(pathName, 'must declare rect or hidden');
  }

  if (hasHidden && value.hidden !== true) {
    throw new ConfigError(`${pathName}.hidden`, 'must be true when provided');
  }

  if (hasRect) {
    return {
      source,
      rect: normalizeOverlayRect(value.rect, `${pathName}.rect`),
    };
  }

  return {
    source,
    hidden: true,
  };
}

/**
 * Normalize an overlays array, rejecting duplicate sources within it.
 *
 * @param {unknown} value The raw overlays value.
 * @param {string} pathName The config path of the owning block.
 * @param {Set<string>} allowedSources Overlay sources currently allowed.
 * @returns {Array<{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }>}
 */
function normalizeOverlays(value, pathName, allowedSources) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new ConfigError(`${pathName}.overlays`, 'must be an array');
  }

  const seenSources = new Set();

  return value.map((overlay, index) => {
    const normalized = normalizeOverlay(overlay, `${pathName}.overlays[${index}]`, allowedSources);

    if (seenSources.has(normalized.source)) {
      throw new ConfigError(`${pathName}.overlays[${index}].source`, 'must be unique within overlays');
    }

    seenSources.add(normalized.source);
    return normalized;
  });
}

function normalizeLayout(layoutId, layout, sources, allowedOverlaySources) {
  const pathName = `layouts.${layoutId}`;
  const value = assertPlainObject(layout, pathName);
  const audienceScene = assertNonEmptyString(value.audienceScene, `${pathName}.audienceScene`);
  const slots = value.slots;
  const overlays = normalizeOverlays(value.overlays, pathName, allowedOverlaySources);

  if (!Array.isArray(slots)) {
    throw new ConfigError(`${pathName}.slots`, 'must be an array');
  }

  if (slots.length === 0) {
    throw new ConfigError(`${pathName}.slots`, 'must contain at least one slot');
  }

  const normalizedSlots = slots.map((slot, index) => normalizeLayoutSlot(layoutId, slot, index, sources));
  const seenSources = new Set();
  const layoutSources = [];

  for (let index = 0; index < normalizedSlots.length; index += 1) {
    const slotInfo = normalizedSlots[index];

    if (seenSources.has(slotInfo.source)) {
      throw new ConfigError(`layouts.${layoutId}.slots[${index}].source`, 'must be unique within a layout');
    }

    seenSources.add(slotInfo.source);
    layoutSources.push(slotInfo.source);
  }

  return {
    id: layoutId,
    audienceScene,
    slots: normalizedSlots,
    sources: layoutSources,
    overlays,
  };
}

function normalizeLayouts(layouts, sources, allowedOverlaySources) {
  const value = assertPlainObject(layouts, 'layouts');
  const entries = Object.entries(value);

  if (entries.length === 0) {
    throw new ConfigError('layouts', 'must define at least one layout');
  }

  return Object.fromEntries(
    entries.map(([layoutId, layout]) => [layoutId, normalizeLayout(layoutId, layout, sources, allowedOverlaySources)]),
  );
}

function normalizeBrowserActionEntry(entry, pathName, sources) {
  const value = assertPlainObject(entry, pathName);
  const source = assertNonEmptyString(value.source, `${pathName}.source`);

  if (!Object.prototype.hasOwnProperty.call(sources, source)) {
    throw new ConfigError(`${pathName}.source`, 'must reference a known source');
  }

  if (sources[source].kind !== BROWSER_SOURCE_KIND) {
    throw new ConfigError(`${pathName}.source`, 'must reference a browser-capable source');
  }

  const action = assertNonEmptyString(value.action, `${pathName}.action`);

  if (!VALID_BROWSER_ACTIONS.has(action)) {
    throw new ConfigError(`${pathName}.action`, `must be one of: ${[...VALID_BROWSER_ACTIONS].join(', ')}`);
  }

  const tabAlias = assertNonEmptyString(value.tab, `${pathName}.tab`);

  if (!Object.prototype.hasOwnProperty.call(sources[source].browser.tabs, tabAlias)) {
    throw new ConfigError(`${pathName}.tab`, 'must reference a declared tab for this source');
  }

  const command = {
    type: action,
    source,
    tab: tabAlias,
  };

  if (action === 'navigate') {
    command.url = normalizeNavigateUrl(value.url, `${pathName}.url`);
  }

  return command;
}

function normalizeSlideEntry(slideId, entry, layouts, sources, allowedOverlaySources) {
  const pathName = `slides.${slideId}`;
  const value = assertPlainObject(entry, pathName);
  const layoutId = assertNonEmptyString(value.layout, `${pathName}.layout`);
  const overlays = normalizeOverlays(value.overlays, pathName, allowedOverlaySources);

  if (!Object.prototype.hasOwnProperty.call(layouts, layoutId)) {
    throw new ConfigError(`${pathName}.layout`, 'must reference a known layout');
  }

  const browser = value.browser === undefined ? [] : value.browser;

  if (!Array.isArray(browser)) {
    throw new ConfigError(`${pathName}.browser`, 'must be an array');
  }

  let focus = null;
  if (value.focus !== undefined) {
    focus = assertNonEmptyString(value.focus, `${pathName}.focus`);

    if (!Object.prototype.hasOwnProperty.call(sources, focus)) {
      throw new ConfigError(`${pathName}.focus`, 'must reference a known source');
    }

    if (!layouts[layoutId].sources.includes(focus)) {
      throw new ConfigError(`${pathName}.focus`, 'must reference a source present in layout');
    }
  }

  let script = null;
  if (value.script !== undefined) {
    if (typeof value.script !== 'string') {
      throw new ConfigError(`${pathName}.script`, 'must be a string');
    }

    script = value.script;
  }

  return {
    layoutId,
    focus,
    script,
    commands: browser.map((item, index) => normalizeBrowserActionEntry(item, `${pathName}.browser[${index}]`, sources)),
    overlays,
  };
}

function normalizeSlides(slides, layouts, sources, allowedOverlaySources) {
  const value = assertPlainObject(slides, 'slides');

  return Object.fromEntries(
    Object.entries(value).map(([slideId, entry]) => [
      slideId,
      normalizeSlideEntry(slideId, entry, layouts, sources, allowedOverlaySources),
    ]),
  );
}

function normalizeWindowSelector(value, pathName) {
  const selector = assertPlainObject(value, pathName);
  const app = assertNonEmptyString(selector.app, `${pathName}.app`);
  const normalized = { app };

  if (selector.titleIncludes !== undefined) {
    normalized.titleIncludes = assertNonEmptyString(selector.titleIncludes, `${pathName}.titleIncludes`);
  }

  return normalized;
}

function normalizePresenterStage(stage) {
  const value = assertPlainObject(stage, 'presenter.stage');
  const width = normalizePositiveInteger(value.width, 'presenter.stage.width', 'positive even integer');

  if (width % 2 !== 0) {
    throw new ConfigError('presenter.stage.width', 'must be a positive even integer');
  }

  return {
    x: normalizeInteger(value.x, 'presenter.stage.x'),
    y: normalizeInteger(value.y, 'presenter.stage.y'),
    width,
    height: normalizePositiveInteger(value.height, 'presenter.stage.height'),
  };
}

function normalizePresenterWindows(windows) {
  const value = assertPlainObject(windows, 'presenter.windows');

  return Object.fromEntries(
    Object.entries(value).map(([source, selector]) => [source, normalizeWindowSelector(selector, `presenter.windows.${source}`)]),
  );
}

/**
 * Normalize `presenter.externalWindows`: a map of developer-chosen overlay
 * source ids to window selectors for apps Deckhand does not own (e.g. OBS).
 *
 * Keys become valid overlay `source` values, so they must not shadow the
 * built-in `Presenter`/`Console` sources or collide with declared `sources`
 * catalog ids, which describe windows Deckhand manages through its own
 * source model.
 *
 * @param {unknown} value The raw `presenter.externalWindows` value.
 * @param {Record<string, unknown>} sources The normalized sources catalog.
 * @returns {Record<string, { app: string, titleIncludes?: string }>}
 */
function normalizePresenterExternalWindows(value, sources) {
  if (value === undefined) {
    return {};
  }

  const raw = assertPlainObject(value, 'presenter.externalWindows');

  return Object.fromEntries(
    Object.entries(raw).map(([id, selector]) => {
      const cleanId = assertNonEmptyString(id, 'presenter.externalWindows');

      if (RESERVED_OVERLAY_SOURCES.has(cleanId)) {
        throw new ConfigError(
          `presenter.externalWindows.${cleanId}`,
          `is a reserved overlay source (reserved: ${[...RESERVED_OVERLAY_SOURCES].join(', ')})`,
        );
      }

      if (Object.prototype.hasOwnProperty.call(sources, cleanId)) {
        throw new ConfigError(`presenter.externalWindows.${cleanId}`, 'collides with a declared source id');
      }

      return [cleanId, normalizeWindowSelector(selector, `presenter.externalWindows.${cleanId}`)];
    }),
  );
}

function normalizePresenterStt(stt) {
  if (stt === undefined) {
    return null;
  }

  const value = assertPlainObject(stt, 'presenter.stt');

   if (value.chunkSeconds !== undefined) {
    throw new ConfigError(
      'presenter.stt.chunkSeconds',
      'was replaced by whisper-stream settings: mode, stepMs, lengthMs, and keepMs',
    );
  }

  const mode = value.mode === undefined ? 'step' : assertNonEmptyString(value.mode, 'presenter.stt.mode');
  if (!VALID_STT_MODES.has(mode)) {
    throw new ConfigError('presenter.stt.mode', `must be one of: ${Array.from(VALID_STT_MODES).join(', ')}`);
  }

  const stepMs = normalizePositiveInteger(value.stepMs ?? 1000, 'presenter.stt.stepMs');
  const lengthMs = normalizePositiveInteger(value.lengthMs ?? 4000, 'presenter.stt.lengthMs');
  const keepMs = normalizeIntegerAtLeast(value.keepMs ?? 250, 'presenter.stt.keepMs', 0, 'non-negative integer');

  if (lengthMs < stepMs) {
    throw new ConfigError('presenter.stt.lengthMs', 'must be greater than or equal to presenter.stt.stepMs');
  }

  if (keepMs > stepMs) {
    throw new ConfigError('presenter.stt.keepMs', 'must be less than or equal to presenter.stt.stepMs');
  }

  const normalized = {
    whisperBin: normalizeAbsolutePath(value.whisperBin, 'presenter.stt.whisperBin'),
    model: normalizeAbsolutePath(value.model, 'presenter.stt.model'),
    mode,
    captureId: normalizeIntegerAtLeast(value.captureId ?? -1, 'presenter.stt.captureId', -1, 'integer greater than or equal to -1'),
    stepMs,
    lengthMs,
    keepMs,
    threads: normalizePositiveInteger(value.threads ?? 4, 'presenter.stt.threads'),
    audioCtx: normalizeIntegerAtLeast(value.audioCtx ?? 0, 'presenter.stt.audioCtx', 0, 'non-negative integer'),
    beamSize: normalizeIntegerAtLeast(value.beamSize ?? -1, 'presenter.stt.beamSize', -1, 'integer greater than or equal to -1'),
    keepContext: value.keepContext === undefined ? false : assertBoolean(value.keepContext, 'presenter.stt.keepContext'),
    noFallback: value.noFallback === undefined ? true : assertBoolean(value.noFallback, 'presenter.stt.noFallback'),
    useGpu: value.useGpu === undefined ? true : assertBoolean(value.useGpu, 'presenter.stt.useGpu'),
    flashAttn: value.flashAttn === undefined ? true : assertBoolean(value.flashAttn, 'presenter.stt.flashAttn'),
  };

  if (value.language !== undefined) {
    normalized.language = assertNonEmptyString(value.language, 'presenter.stt.language');
  }

  if (value.vadThreshold !== undefined) {
    const vadThreshold = value.vadThreshold;

    if (typeof vadThreshold !== 'number' || Number.isNaN(vadThreshold) || vadThreshold < 0 || vadThreshold > 1) {
      throw new ConfigError('presenter.stt.vadThreshold', 'must be a number between 0 and 1');
    }

    normalized.vadThreshold = vadThreshold;
  }

  if (value.freqThreshold !== undefined) {
    normalized.freqThreshold = normalizeNumberAtLeast(
      value.freqThreshold,
      'presenter.stt.freqThreshold',
      0,
      'non-negative number',
    );
  }

  return normalized;
}

function normalizePresenterTeleprompter(teleprompter, { requireWindow = false } = {}) {
  let normalized;

  if (teleprompter === undefined) {
    normalized = { followEnabledByDefault: true, window: null };
  } else {
    const value = assertPlainObject(teleprompter, 'presenter.teleprompter');

    normalized = {
      followEnabledByDefault: value.followEnabledByDefault === undefined
        ? true
        : assertBoolean(value.followEnabledByDefault, 'presenter.teleprompter.followEnabledByDefault'),
      tracking: normalizePresenterTracking(value.tracking),
      window: value.window === undefined
        ? null
        : normalizeWindowSelector(value.window, 'presenter.teleprompter.window'),
    };
  }

  if (normalized.tracking === undefined) {
    normalized.tracking = normalizePresenterTracking(undefined);
  }

  if (requireWindow && normalized.window === null) {
    throw new ConfigError('presenter.teleprompter.window', 'is required when overlays reference Presenter');
  }

  return normalized;
}

function normalizePresenterTracking(tracking) {
  if (tracking === undefined) {
    return {
      farJumpLines: 8,
      offScriptMs: 3000,
      lostMs: 8000,
      minConfidence: 0.35,
    };
  }

  const value = assertPlainObject(tracking, 'presenter.teleprompter.tracking');
  const minConfidence = value.minConfidence === undefined ? 0.35 : value.minConfidence;

  if (typeof minConfidence !== 'number' || Number.isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new ConfigError('presenter.teleprompter.tracking.minConfidence', 'must be a number between 0 and 1');
  }

  return {
    farJumpLines: normalizePositiveInteger(value.farJumpLines ?? 8, 'presenter.teleprompter.tracking.farJumpLines'),
    offScriptMs: normalizePositiveInteger(value.offScriptMs ?? 3000, 'presenter.teleprompter.tracking.offScriptMs'),
    lostMs: normalizePositiveInteger(value.lostMs ?? 8000, 'presenter.teleprompter.tracking.lostMs'),
    minConfidence,
  };
}

/**
 * Determine whether any overlay positions the presenter's own window.
 *
 * Only `Presenter`-sourced overlays need a teleprompter window selector:
 * Console and external-window overlays describe other windows Deckhand does
 * not follow for script tracking. This predicate backs only that requirement;
 * the `presenter` block guard uses {@link usesAnyOverlays}.
 *
 * @param {Record<string, { overlays: Array<{ source: string }> }>} layouts Normalized layouts.
 * @param {Record<string, { overlays: Array<{ source: string }> }>} slides Normalized slides.
 * @param {Array<{ source: string }>} [presenterOverlays] Normalized presenter-level overlays.
 * @returns {boolean}
 */
function usesPresenterOverlays(layouts, slides, presenterOverlays = []) {
  return Object.values(layouts).some((layout) => layout.overlays.some((overlay) => overlay.source === PRESENTER_OVERLAY_SOURCE))
    || Object.values(slides).some((slide) => slide.overlays.some((overlay) => overlay.source === PRESENTER_OVERLAY_SOURCE))
    || presenterOverlays.some((overlay) => overlay.source === PRESENTER_OVERLAY_SOURCE);
}

/**
 * Determine whether any layout, slide, or presenter-level overlay exists.
 *
 * Unlike {@link usesPresenterOverlays}, the overlay source does not matter:
 * overlays of any source only render in presenter mode, so a config that
 * declares one must configure the `presenter` block.
 *
 * @param {Record<string, { overlays: Array<{ source: string }> }>} layouts Normalized layouts.
 * @param {Record<string, { overlays: Array<{ source: string }> }>} slides Normalized slides.
 * @param {Array<{ source: string }>} [presenterOverlays] Normalized presenter-level overlays.
 * @returns {boolean}
 */
function usesAnyOverlays(layouts, slides, presenterOverlays = []) {
  return Object.values(layouts).some((layout) => layout.overlays.length > 0)
    || Object.values(slides).some((slide) => slide.overlays.length > 0)
    || presenterOverlays.length > 0;
}

function normalizePresenterHttp(http) {
  if (http === undefined) {
    return {
      host: '127.0.0.1',
      port: 3001,
    };
  }

  const value = assertPlainObject(http, 'presenter.http');

  return {
    host: typeof value.host === 'string' && value.host.trim() !== '' ? value.host.trim() : '127.0.0.1',
    port: normalizePort(value.port ?? 3001, 'presenter.http.port'),
  };
}

function normalizeChrome(chrome) {
  if (chrome === undefined) {
    return null;
  }

  const value = assertPlainObject(chrome, 'chrome');
  const normalized = {};

  if (value.executablePath !== undefined) {
    normalized.executablePath = normalizeAbsolutePath(value.executablePath, 'chrome.executablePath');
  }

  if (value.profileDir !== undefined) {
    normalized.profileDir = normalizeAbsolutePath(value.profileDir, 'chrome.profileDir');
  }

  if (value.profileName !== undefined) {
    normalized.profileName = assertNonEmptyString(value.profileName, 'chrome.profileName');
  }

  if (value.debugPort !== undefined) {
    normalized.debugPort = normalizePort(value.debugPort, 'chrome.debugPort');
  }

  if (value.extraArgs !== undefined) {
    if (!Array.isArray(value.extraArgs) || value.extraArgs.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      throw new ConfigError('chrome.extraArgs', 'must be an array of non-empty strings');
    }
    normalized.extraArgs = [...value.extraArgs];
  }

  return normalized;
}

function normalizePresenter(presenter, layouts, slides, sources) {
  if (presenter === undefined) {
    return null;
  }

  const value = assertPlainObject(presenter, 'presenter');
  const platformName = value.platform === undefined ? 'macos' : assertNonEmptyString(value.platform, 'presenter.platform');

  if (platformName !== 'macos') {
    throw new ConfigError('presenter.platform', 'must be "macos" for presenter mode');
  }

  const stage = normalizePresenterStage(value.stage);
  const windows = normalizePresenterWindows(value.windows);
  const requiredSources = new Set(Object.values(layouts).flatMap((layout) => layout.sources));

  for (const source of requiredSources) {
    if (Object.prototype.hasOwnProperty.call(windows, source)) {
      continue;
    }

    // Owned source kinds (browser, app) derive their owner name from
    // the source descriptor and resolve exact macWindowId bindings at launch,
    // so a presenter.windows selector is optional rather than required.
    const kind = sources[source]?.kind;
    if (kind !== undefined && VALID_SOURCE_KINDS.has(kind)) {
      continue;
    }

    throw new ConfigError(`presenter.windows.${source}`, 'must be configured for every layout source');
  }

  for (const windowSource of Object.keys(windows)) {
    if (!Object.prototype.hasOwnProperty.call(sources, windowSource)) {
      throw new ConfigError(`presenter.windows.${windowSource}`, 'must reference a known source');
    }
  }

  const externalWindows = normalizePresenterExternalWindows(value.externalWindows, sources);
  const allowedOverlaySources = new Set([PRESENTER_OVERLAY_SOURCE, CONSOLE_OVERLAY_SOURCE, ...Object.keys(externalWindows)]);
  const overlays = normalizeOverlays(value.overlays, 'presenter', allowedOverlaySources);

  return {
    platform: platformName,
    stage,
    windows,
    overlays,
    externalWindows,
    stt: normalizePresenterStt(value.stt),
    teleprompter: normalizePresenterTeleprompter(value.teleprompter, {
      requireWindow: usesPresenterOverlays(layouts, slides, overlays),
    }),
    http: normalizePresenterHttp(value.http),
  };
}

/**
 * Error raised when a presentation config fails validation.
 */
export class ConfigError extends Error {
  /**
   * @param {string} pathName The failing config path.
   * @param {string} message Validation details.
   */
  constructor(pathName, message) {
    super(pathName === 'config' ? message : `${pathName} ${message}`);
    this.name = 'ConfigError';
    this.path = pathName;
  }
}

/**
 * Normalize a raw config object into the coordinator's internal model.
 *
 * @param {unknown} rawConfig The parsed config JSON.
 * @param {{ baseDir?: string }} [options] Loader options. `baseDir` resolves
 *   relative `files` paths (e.g. a presentation's committed image assets)
 *   against the presentation directory.
 * @returns {{ driver: { type: string }, obs: { url: string, password: string, prune: boolean, transitions: null | { forward: string | null, backward: string | null, freezeScene: string, freezeImage: string, freezeImagePath: string | null, durationMs: number, settleMs: number, navigationWaitMs: number, windowSettleMs: number, freezeDimPercent: number } }, hub: { host: string, port: number }, sources: Record<string, { id: string, kind: string, browser?: { windowLabel: string | null, tabs: Record<string, { url: string, preload: boolean }>, initialTab: string }, command?: string, cwd?: string, app?: string, args?: string[], files?: string[] }>, layouts: Record<string, { id: string, audienceScene: string, slots: Array<{ source: string, position: 'full' | 'left' | 'right' }>, sources: string[] }>, slides: Record<string, { layoutId: string, focus: string | null, script: string | null, commands: Array<{ type: 'activateTab' | 'navigate', source: string, tab: string, url?: string }> }>, chrome: null | { executablePath?: string, profileDir?: string, profileName?: string, debugPort?: number, extraArgs?: string[] }, presenter: null | { platform: 'macos', stage: { x: number, y: number, width: number, height: number }, windows: Record<string, { app: string, titleIncludes?: string }>, overlays: Array<{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }>, externalWindows: Record<string, { app: string, titleIncludes?: string }>, stt: null | { whisperBin: string, model: string, mode: 'step' | 'vad', captureId: number, stepMs: number, lengthMs: number, keepMs: number, threads: number, audioCtx: number, beamSize: number, keepContext: boolean, noFallback: boolean, useGpu: boolean, flashAttn: boolean, language?: string, vadThreshold?: number, freqThreshold?: number }, teleprompter: { followEnabledByDefault: boolean }, http: { host: string, port: number } }, recovery: { obsReconnect: { enabled: boolean, initialDelayMs: number, maxDelayMs: number }, browserRecover: { enabled: boolean, initialDelayMs: number, maxDelayMs: number }, resumeSlide: { enabled: boolean } } }}
 */
export function normalizeConfig(rawConfig, { baseDir } = {}) {
  const root = assertPlainObject(rawConfig, 'config');
  const sources = normalizeSources(root.sources, baseDir);

  // Layouts and slides normalize before the presenter block, but their valid
  // overlay sources already depend on `presenter.externalWindows` keys, so
  // extract the ids here from the raw value (shape validation still happens
  // in normalizePresenter). A non-object presenter block contributes no ids.
  const externalWindowIds = isPlainObject(root.presenter?.externalWindows)
    ? Object.keys(root.presenter.externalWindows)
    : [];
  const allowedOverlaySources = new Set([PRESENTER_OVERLAY_SOURCE, CONSOLE_OVERLAY_SOURCE, ...externalWindowIds]);

  const layouts = normalizeLayouts(root.layouts, sources, allowedOverlaySources);
  const slides = normalizeSlides(root.slides, layouts, sources, allowedOverlaySources);

  if (root.presenter === undefined && usesAnyOverlays(layouts, slides)) {
    throw new ConfigError('presenter', 'must be configured when overlays are used');
  }

  return {
    driver: normalizeDriver(root.driver),
    obs: normalizeObs(root.obs),
    hub: normalizeHub(root.hub),
    sources,
    layouts,
    slides,
    chrome: normalizeChrome(root.chrome),
    presenter: normalizePresenter(root.presenter, layouts, slides, sources),
    recovery: normalizeRecovery(root.recovery),
  };
}

/**
 * Verify that every resolved `files` path for owned app sources exists on disk.
 *
 * `normalizeConfig` only validates shape (and resolves relative paths against
 * the presentation directory); it never touches the filesystem so it stays
 * unit-testable. A missing `files` path, unlike a stale `cwd`/`args`
 * placeholder, makes `open` exit non-zero with no window, so this load-time
 * check surfaces typos and placeholders as a clear `sources.<id>.files[i]`
 * error instead of a confusing launch-time `open ... exited with code 1`.
 *
 * @param {{ sources: Record<string, { kind: string, files?: string[] }> }} config Normalized config.
 */
export async function assertOwnedAppFilesExist(config) {
  for (const [sourceId, source] of Object.entries(config.sources)) {
    if (source?.kind !== 'app' || !Array.isArray(source.files)) {
      continue;
    }

    for (let index = 0; index < source.files.length; index += 1) {
      try {
        await access(source.files[index]);
      } catch {
        throw new ConfigError(`sources.${sourceId}.files[${index}]`, `file does not exist: ${source.files[index]}`);
      }
    }
  }
}

/**
 * Read and validate a presentation config from disk.
 *
 * @param {{ filePath: string }} options Loader options.
 * @returns {Promise<ReturnType<typeof normalizeConfig>>}
 */
export async function loadConfig(options) {
  let text;

  try {
    text = await readFile(options.filePath, 'utf8');
  } catch (error) {
    throw error;
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError('config', `must be valid JSON: ${error.message}`);
  }

  const normalized = normalizeConfig(parsed, { baseDir: path.dirname(options.filePath) });
  await assertOwnedAppFilesExist(normalized);
  return normalized;
}
