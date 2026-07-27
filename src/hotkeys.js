import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MODIFIER_ALIASES = {
  Cmd: 'Meta',
  Command: 'Meta',
  Opt: 'Alt',
  Option: 'Alt',
};

const MODIFIER_EVENT_FIELDS = {
  Shift: 'shiftKey',
  Ctrl: 'ctrlKey',
  Alt: 'altKey',
  Meta: 'metaKey',
};

const MODIFIER_KEY_NAMES = {
  Shift: ['Shift', 'ShiftRight'],
  Ctrl: ['Ctrl', 'CtrlRight'],
  Alt: ['Alt', 'AltRight'],
  Meta: ['Meta', 'MetaRight'],
};

// undefined = not attempted, null = load failed, object = loaded
let cachedBindings;

function getDefaultBindings() {
  if (cachedBindings !== undefined) {
    return cachedBindings;
  }

  try {
    cachedBindings = require('uiohook-napi');
  } catch {
    cachedBindings = null;
  }

  return cachedBindings;
}

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

function normalizeModifierName(name) {
  const normalized = MODIFIER_ALIASES[name] ?? name;

  if (!Object.prototype.hasOwnProperty.call(MODIFIER_EVENT_FIELDS, normalized)) {
    throw new Error(`Unknown modifier: ${name}`);
  }

  return normalized;
}

/**
 * Parse a hotkey spec string into modifiers and a key name.
 *
 * Supports single keys (`"F13"`) and combinations (`"Shift+ArrowRight"`,
 * `"Ctrl+Shift+N"`). `Cmd`/`Command` are aliases for `Meta`; `Opt`/`Option`
 * are aliases for `Alt`.
 *
 * @param {string} spec The hotkey spec.
 * @returns {{ modifiers: string[], key: string }}
 */
export function parseHotkeySpec(spec) {
  const trimmed = typeof spec === 'string' ? spec.trim() : '';

  if (trimmed === '') {
    throw new Error('Hotkey spec must be a non-empty string');
  }

  const parts = trimmed.split('+').map((part) => part.trim());
  const key = parts[parts.length - 1];

  if (key === '') {
    throw new Error('Hotkey spec must end with a key name');
  }

  const modifiers = parts.slice(0, -1).map(normalizeModifierName);

  return { modifiers, key };
}

/**
 * Resolve a configured key name into a native `uiohook-napi` key code.
 *
 * @param {string} keyName The configured key name.
 * @param {Record<string, number>} keyMap The native key-code map.
 * @returns {number}
 */
export function resolveHotkeyCode(keyName, keyMap) {
  const normalizedName = typeof keyName === 'string' ? keyName.trim() : '';
  const resolved = keyMap[normalizedName];

  if (!Number.isInteger(resolved)) {
    throw new Error(`Unknown hotkey: ${normalizedName}`);
  }

  return resolved;
}

function modifiersMatch(event, requiredModifiers) {
  return requiredModifiers.every((mod) => event[MODIFIER_EVENT_FIELDS[mod]] === true);
}

function resolveModifierCodes(keyMap) {
  return Object.fromEntries(
    Object.entries(MODIFIER_KEY_NAMES).map(([modifierName, keyNames]) => [
      modifierName,
      keyNames
        .map((keyName) => keyMap[keyName])
        .filter((value) => Number.isInteger(value)),
    ]),
  );
}

function modifiersMatchWithFallback(event, requiredModifiers, activeKeyCodes, modifierCodes) {
  return requiredModifiers.every((modifierName) => {
    if (event[MODIFIER_EVENT_FIELDS[modifierName]] === true) {
      return true;
    }

    return modifierCodes[modifierName].some((keyCode) => activeKeyCodes.has(keyCode));
  });
}

/**
 * Create the global hotkey adapter boundary.
 *
 * Supports single-key hotkeys (`"F13"`) and modifier combinations
 * (`"Shift+ArrowRight"`).
 *
 * Degrades to a no-op adapter when the native `uiohook-napi` backend cannot
 * load (e.g. headless containers, missing X11 libraries, no display server).
 * The coordinator stays usable; the driver app's own navigation is the fallback.
 *
 * @param {{ next: string, prev: string, hook?: { on(eventName: string, handler: (event: Record<string, unknown>) => void): void, off?(eventName: string, handler: (event: Record<string, unknown>) => void): void, removeListener?(eventName: string, handler: (event: Record<string, unknown>) => void): void, start(): void, stop(): void }, keyMap?: Record<string, number>, nativeBindings?: { uIOhook: unknown, UiohookKey: Record<string, number> } | null, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Adapter options. `nativeBindings: null` forces the degraded path (used for tests and headless environments).
 * @returns {{ on(eventName: 'action', handler: (action: { type: 'next' | 'prev' }) => void): void, start(): Promise<void>, stop(): Promise<void> }}
 */
export function createHotkeyAdapter(options) {
  const logger = options.logger ?? createNoopLogger();
  const emitter = new EventEmitter();

  function resolveNative() {
    if (options.hook !== undefined && options.keyMap !== undefined) {
      return { hook: options.hook, keyMap: options.keyMap };
    }

    const bindings = options.nativeBindings !== undefined ? options.nativeBindings : getDefaultBindings();

    if (bindings === null) {
      return null;
    }

    return { hook: bindings.uIOhook, keyMap: bindings.UiohookKey };
  }

  const native = resolveNative();

  if (native === null) {
    logger.warn('Native hotkey backend unavailable; starting without global hotkeys', {
      reason: "uiohook-napi failed to load (missing system libraries or no display server). Use the driver app's own navigation in this environment.",
    });

    return {
      on(eventName, listener) {
        emitter.on(eventName, listener);
      },

      async start() {},

      async stop() {},
    };
  }

  const { hook, keyMap } = native;
  const nextSpec = parseHotkeySpec(options.next);
  const prevSpec = parseHotkeySpec(options.prev);
  const nextCode = resolveHotkeyCode(nextSpec.key, keyMap);
  const prevCode = resolveHotkeyCode(prevSpec.key, keyMap);
  const modifierCodes = resolveModifierCodes(keyMap);
  const activeKeyCodes = new Set();
  let started = false;
  let keydownHandler = null;
  let keyupHandler = null;

  return {
    on(eventName, listener) {
      emitter.on(eventName, listener);
    },

    async start() {
      if (started) {
        return;
      }

      keydownHandler = (event) => {
        activeKeyCodes.add(event.keycode);

        if (event.keycode === nextCode && modifiersMatchWithFallback(event, nextSpec.modifiers, activeKeyCodes, modifierCodes)) {
          emitter.emit('action', { type: 'next' });
        }

        if (event.keycode === prevCode && modifiersMatchWithFallback(event, prevSpec.modifiers, activeKeyCodes, modifierCodes)) {
          emitter.emit('action', { type: 'prev' });
        }
      };

      keyupHandler = (event) => {
        activeKeyCodes.delete(event.keycode);
      };

      hook.on('keydown', keydownHandler);
      if (typeof hook.on === 'function') {
        hook.on('keyup', keyupHandler);
      }
      hook.start();
      started = true;
      logger.info('Hotkeys listening', { next: options.next, prev: options.prev });
    },

    async stop() {
      if (!started) {
        return;
      }

      if (typeof hook.off === 'function' && keydownHandler !== null) {
        hook.off('keydown', keydownHandler);
        if (keyupHandler !== null) {
          hook.off('keyup', keyupHandler);
        }
      } else if (typeof hook.removeListener === 'function' && keydownHandler !== null) {
        hook.removeListener('keydown', keydownHandler);
        if (keyupHandler !== null) {
          hook.removeListener('keyup', keyupHandler);
        }
      }

      hook.stop();
      activeKeyCodes.clear();
      keydownHandler = null;
      keyupHandler = null;
      started = false;
      logger.info('Hotkeys stopped');
    },
  };
}
