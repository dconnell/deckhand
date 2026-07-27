import { readFile } from 'node:fs/promises';
import path from 'node:path';

const BUILTIN_DRIVER_TYPES = ['revealjs'];
const VALID_SLOT_POSITIONS = new Set(['full', 'left', 'right']);

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

function normalizeAbsolutePath(value, pathName) {
  const resolved = assertNonEmptyString(value, pathName);

  if (!path.isAbsolute(resolved)) {
    throw new ConfigError(pathName, 'must be an absolute path');
  }

  return resolved;
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
  const url = assertNonEmptyString(value, pathName);

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

function normalizeObs(obs) {
  const value = assertPlainObject(obs, 'obs');

  return {
    url: normalizeObsUrl(value.url, 'obs.url'),
    password: typeof value.password === 'string' ? value.password : '',
  };
}

function normalizeHub(hub) {
  const value = assertPlainObject(hub, 'hub');

  return {
    host: typeof value.host === 'string' && value.host.trim() !== '' ? value.host.trim() : '127.0.0.1',
    port: normalizePort(value.port, 'hub.port'),
  };
}

function normalizeHotkeys(hotkeys) {
  const value = assertPlainObject(hotkeys, 'hotkeys');

  return {
    next: assertNonEmptyString(value.next, 'hotkeys.next'),
    prev: assertNonEmptyString(value.prev, 'hotkeys.prev'),
  };
}

function normalizeLayoutSlot(layoutId, slot, index) {
  const pathName = `layouts.${layoutId}.slots[${index}]`;
  const value = assertPlainObject(slot, pathName);
  const source = assertNonEmptyString(value.source, `${pathName}.source`);
  const position = assertNonEmptyString(value.position, `${pathName}.position`);

  if (!VALID_SLOT_POSITIONS.has(position)) {
    throw new ConfigError(`${pathName}.position`, 'must be one of: full, left, right');
  }

  return {
    source,
    position,
  };
}

function normalizeLayout(layoutId, layout) {
  const pathName = `layouts.${layoutId}`;
  const value = assertPlainObject(layout, pathName);
  const audienceScene = assertNonEmptyString(value.audienceScene, `${pathName}.audienceScene`);
  const slots = value.slots;

  if (!Array.isArray(slots)) {
    throw new ConfigError(`${pathName}.slots`, 'must be an array');
  }

  if (slots.length === 0) {
    throw new ConfigError(`${pathName}.slots`, 'must contain at least one slot');
  }

  const normalizedSlots = slots.map((slot, index) => normalizeLayoutSlot(layoutId, slot, index));
  const seenSources = new Set();
  const sources = [];

  for (let index = 0; index < normalizedSlots.length; index += 1) {
    const slotInfo = normalizedSlots[index];

    if (seenSources.has(slotInfo.source)) {
      throw new ConfigError(`layouts.${layoutId}.slots[${index}].source`, 'must be unique within a layout');
    }

    seenSources.add(slotInfo.source);
    sources.push(slotInfo.source);
  }

  return {
    id: layoutId,
    audienceScene,
    slots: normalizedSlots,
    sources,
  };
}

function normalizeLayouts(layouts) {
  const value = assertPlainObject(layouts, 'layouts');
  const entries = Object.entries(value);

  if (entries.length === 0) {
    throw new ConfigError('layouts', 'must define at least one layout');
  }

  return Object.fromEntries(entries.map(([layoutId, layout]) => [layoutId, normalizeLayout(layoutId, layout)]));
}

function normalizeNavigateEntry(entry, pathName) {
  const value = assertPlainObject(entry, pathName);

  try {
    return {
      type: 'navigate',
      target: parseTargetSelector(value.target),
      url: normalizeNavigateUrl(value.url, `${pathName}.url`),
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigError(`${pathName}.target`, 'must be a valid target selector');
  }
}

function normalizeSlideEntry(slideId, entry, layouts) {
  const pathName = `slides.${slideId}`;
  const value = assertPlainObject(entry, pathName);
  const layoutId = assertNonEmptyString(value.layout, `${pathName}.layout`);

  if (!Object.prototype.hasOwnProperty.call(layouts, layoutId)) {
    throw new ConfigError(`${pathName}.layout`, 'must reference a known layout');
  }

  const navigate = value.navigate === undefined ? [] : value.navigate;

  if (!Array.isArray(navigate)) {
    throw new ConfigError(`${pathName}.navigate`, 'must be an array');
  }

  let focus = null;
  if (value.focus !== undefined) {
    focus = assertNonEmptyString(value.focus, `${pathName}.focus`);

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
    commands: navigate.map((item, index) => normalizeNavigateEntry(item, `${pathName}.navigate[${index}]`)),
  };
}

function normalizeSlides(slides, layouts) {
  const value = assertPlainObject(slides, 'slides');

  return Object.fromEntries(
    Object.entries(value).map(([slideId, entry]) => [slideId, normalizeSlideEntry(slideId, entry, layouts)]),
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

function normalizePresenterStt(stt) {
  if (stt === undefined) {
    return null;
  }

  const value = assertPlainObject(stt, 'presenter.stt');
  const normalized = {
    whisperBin: normalizeAbsolutePath(value.whisperBin, 'presenter.stt.whisperBin'),
    model: normalizeAbsolutePath(value.model, 'presenter.stt.model'),
    chunkSeconds: normalizePositiveNumber(value.chunkSeconds, 'presenter.stt.chunkSeconds'),
  };

  if (value.language !== undefined) {
    normalized.language = assertNonEmptyString(value.language, 'presenter.stt.language');
  }

  return normalized;
}

function normalizePresenterTeleprompter(teleprompter) {
  if (teleprompter === undefined) {
    return { followEnabledByDefault: true };
  }

  const value = assertPlainObject(teleprompter, 'presenter.teleprompter');

  return {
    followEnabledByDefault: value.followEnabledByDefault === undefined
      ? true
      : assertBoolean(value.followEnabledByDefault, 'presenter.teleprompter.followEnabledByDefault'),
  };
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

function normalizePresenter(presenter, layouts) {
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
    if (!Object.prototype.hasOwnProperty.call(windows, source)) {
      throw new ConfigError(`presenter.windows.${source}`, 'must be configured for every layout source');
    }
  }

  return {
    platform: platformName,
    stage,
    windows,
    stt: normalizePresenterStt(value.stt),
    teleprompter: normalizePresenterTeleprompter(value.teleprompter),
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
 * Parse a target selector into controller and tab identifiers.
 *
 * @param {string} selector The target selector string.
 * @returns {{ controllerId: string, tabId: string | null }}
 */
export function parseTargetSelector(selector) {
  if (typeof selector !== 'string' || selector.trim() === '') {
    throw new Error('Target selector must be a non-empty string');
  }

  const parts = selector.trim().split(':');

  if (parts.length > 2 || parts.some((part) => part.trim() === '')) {
    throw new Error('Target selector must be a valid target selector');
  }

  return {
    controllerId: parts[0],
    tabId: parts[1] ?? null,
  };
}

/**
 * Normalize a raw config object into the coordinator's internal model.
 *
 * @param {unknown} rawConfig The parsed config JSON.
 * @returns {{ driver: { type: string }, obs: { url: string, password: string }, hub: { host: string, port: number }, hotkeys: { next: string, prev: string }, layouts: Record<string, { id: string, audienceScene: string, slots: Array<{ source: string, position: 'full' | 'left' | 'right' }>, sources: string[] }>, slides: Record<string, { layoutId: string, focus: string | null, script: string | null, commands: Array<{ type: 'navigate', target: { controllerId: string, tabId: string | null }, url: string }> }>, presenter: null | { platform: 'macos', stage: { x: number, y: number, width: number, height: number }, windows: Record<string, { app: string, titleIncludes?: string }>, stt: null | { whisperBin: string, model: string, chunkSeconds: number, language?: string }, teleprompter: { followEnabledByDefault: boolean }, http: { host: string, port: number } } }}
 */
export function normalizeConfig(rawConfig) {
  const root = assertPlainObject(rawConfig, 'config');
  const layouts = normalizeLayouts(root.layouts);
  const slides = normalizeSlides(root.slides, layouts);

  return {
    driver: normalizeDriver(root.driver),
    obs: normalizeObs(root.obs),
    hub: normalizeHub(root.hub),
    hotkeys: normalizeHotkeys(root.hotkeys),
    layouts,
    slides,
    presenter: normalizePresenter(root.presenter, layouts),
  };
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

  return normalizeConfig(parsed);
}
