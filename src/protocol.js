function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeBoolean(value, fieldName) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${fieldName} must be a boolean`);
  }

  return value;
}

function normalizePositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }

  return value;
}

function normalizeInteger(value, fieldName) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${fieldName} must be an integer`);
  }

  return value;
}

function normalizeCapabilities(value) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TypeError('capabilities must be an array of non-empty strings');
  }

  return [...new Set(value.map((entry) => entry.trim()))];
}

const OBSERVER_SUBSCRIPTIONS = new Set(['presentationState', 'presenterState', 'transcript']);

function normalizeSubscriptions(value) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TypeError('subscriptions must be an array of non-empty strings');
  }

  const unique = [...new Set(value.map((entry) => entry.trim()))];

  if (unique.some((entry) => !OBSERVER_SUBSCRIPTIONS.has(entry))) {
    throw new TypeError(`subscriptions must be limited to: ${[...OBSERVER_SUBSCRIPTIONS].join(', ')}`);
  }

  return unique;
}

function normalizeWindowBinding(binding, fieldName) {
  if (!isPlainObject(binding)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  const normalized = {
    app: assertNonEmptyString(binding.app, `${fieldName}.app`),
  };

  if (binding.titleIncludes !== undefined) {
    normalized.titleIncludes = assertNonEmptyString(binding.titleIncludes, `${fieldName}.titleIncludes`);
  }

  if (binding.pid !== undefined) {
    normalized.pid = normalizePositiveInteger(binding.pid, `${fieldName}.pid`);
  }

  if (binding.macWindowId !== undefined) {
    normalized.macWindowId = normalizePositiveInteger(binding.macWindowId, `${fieldName}.macWindowId`);
  }

  if (binding.strict !== undefined) {
    normalized.strict = normalizeBoolean(binding.strict, `${fieldName}.strict`);
  }

  return normalized;
}

/**
 * Validate a frame rect ({ x, y, w, h } with finite numbers) reported by the
 * presenter, e.g. inside a `windowSettled` frame mismatch.
 *
 * @param {unknown} rect The rect to validate.
 * @param {string} fieldName Field name used in error messages.
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
function normalizeFrameRect(rect, fieldName) {
  if (!isPlainObject(rect)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  for (const key of ['x', 'y', 'w', 'h']) {
    if (typeof rect[key] !== 'number' || !Number.isFinite(rect[key])) {
      throw new TypeError(`${fieldName}.${key} must be a finite number`);
    }
  }

  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

/**
 * Validate the optional `frameMismatches` array carried by a `windowSettled`
 * message: one entry per source window that did not reach its configured rect.
 *
 * @param {unknown} value The frameMismatches value to validate.
 * @returns {Array<{ source: string, requested: { x: number, y: number, w: number, h: number }, observed: { x: number, y: number, w: number, h: number } }>}
 */
function normalizeFrameMismatches(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('frameMismatches must be an array');
  }

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new TypeError(`frameMismatches[${index}] must be an object`);
    }

    return {
      source: assertNonEmptyString(entry.source, `frameMismatches[${index}].source`),
      requested: normalizeFrameRect(entry.requested, `frameMismatches[${index}].requested`),
      observed: normalizeFrameRect(entry.observed, `frameMismatches[${index}].observed`),
    };
  });
}

function normalizeWindowBindingsMessage(message) {
  if (!isPlainObject(message.bindings)) {
    throw new TypeError('bindings must be an object');
  }

  const bindings = Object.fromEntries(
    Object.entries(message.bindings).map(([source, binding]) => [
      assertNonEmptyString(source, 'bindings source'),
      normalizeWindowBinding(binding, `bindings.${source}`),
    ]),
  );

  let cleared = [];

  if (message.cleared !== undefined) {
    if (!Array.isArray(message.cleared)) {
      throw new TypeError('cleared must be an array of non-empty strings');
    }

    cleared = [...new Set(message.cleared.map((source) => assertNonEmptyString(source, 'cleared source')))];
  }

  return {
    type: 'windowBindings',
    bindings,
    cleared,
  };
}

function assertRole(value) {
  if (value !== 'driver' && value !== 'observer') {
    throw new TypeError('role must be either "driver" or "observer"');
  }

  return value;
}

function assertAdapterContract(adapter, expectedKind) {
  if (!isPlainObject(adapter)) {
    throw new TypeError('Adapter descriptor must be an object');
  }

  assertNonEmptyString(adapter.name, 'name');

  if (adapter.kind !== expectedKind) {
    throw new TypeError(`Adapter kind must be "${expectedKind}"`);
  }

  if (!Object.prototype.hasOwnProperty.call(adapter, 'capabilities')) {
    throw new TypeError('capabilities must be an array of non-empty strings');
  }

  normalizeCapabilities(adapter.capabilities);
}

/**
 * Assert that a driver adapter descriptor matches the shared contract.
 *
 * @param {unknown} adapter The adapter descriptor to validate.
 * @returns {void}
 */
export function assertDriverAdapterContract(adapter) {
  assertAdapterContract(adapter, 'driver');
}

/**
 * Build the protocol `registered` message sent by the hub.
 *
 * @param {{ role: 'driver' | 'observer', sessionId: string, subscriptions?: string[] }} details Message details.
 * @returns {{ type: 'registered', role: 'driver' | 'observer', sessionId: string, subscriptions?: string[] }}
 */
export function createRegisteredMessage(details) {
  const role = assertRole(details.role);
  const message = {
    type: 'registered',
    role,
    sessionId: assertNonEmptyString(details.sessionId, 'sessionId'),
  };

  if (role === 'observer') {
    message.subscriptions = normalizeSubscriptions(details.subscriptions);
  }

  return message;
}

/**
 * Build the protocol `command` envelope.
 *
 * @param {Record<string, unknown>} command A normalized command payload.
 * @returns {{ type: 'command', command: Record<string, unknown> }}
 */
export function createCommandMessage(command) {
  if (!isPlainObject(command)) {
    throw new TypeError('command must be an object');
  }

  return {
    type: 'command',
    command,
  };
}

/**
 * Build the protocol `presentationState` message.
 *
 * @param {Record<string, unknown>} state The resolved presentation state.
 * @returns {{ type: 'presentationState', [key: string]: unknown }}
 */
export function createPresentationStateMessage(state) {
  if (!isPlainObject(state) || state.type !== 'presentationState') {
    throw new TypeError('presentation state must be a resolved presentationState payload');
  }

  const payload = {
    type: 'presentationState',
    seq: state.seq,
    slideId: assertNonEmptyString(state.slideId, 'slideId'),
    layoutId: assertNonEmptyString(state.layoutId, 'layoutId'),
    audienceScene: assertNonEmptyString(state.audienceScene, 'audienceScene'),
    slots: Array.isArray(state.slots) ? state.slots : [],
    focus: state.focus ?? null,
    script: state.script ?? null,
  };

  if (state.windowBindings !== undefined) {
    payload.windowBindings = state.windowBindings;
  }

  if (state.managedWindowBindings !== undefined) {
    payload.managedWindowBindings = state.managedWindowBindings;
  }

  if (state.overlays !== undefined) {
    payload.overlays = state.overlays;
  }

  return payload;
}

function normalizePresenterLine(line, fieldName) {
  if (!isPlainObject(line)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  if (!Array.isArray(line.tokens)) {
    throw new TypeError(`${fieldName}.tokens must be an array`);
  }

  return {
    tokens: line.tokens.map((token, index) => {
      if (!isPlainObject(token)) {
        throw new TypeError(`${fieldName}.tokens[${index}] must be an object`);
      }

      const normalized = {
        kind: assertNonEmptyString(token.kind, `${fieldName}.tokens[${index}].kind`),
      };

      if (token.text !== undefined) {
        normalized.text = assertNonEmptyString(token.text, `${fieldName}.tokens[${index}].text`);
      }

      return normalized;
    }),
    spokenText: typeof line.spokenText === 'string' ? line.spokenText : '',
    paragraphIndex: normalizeInteger(line.paragraphIndex ?? 0, `${fieldName}.paragraphIndex`),
    ...(line.mode === undefined ? {} : { mode: assertNonEmptyString(line.mode, `${fieldName}.mode`) }),
  };
}

function normalizePresenterTranscriptItem(item, fieldName) {
  if (!isPlainObject(item)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  return {
    source: assertNonEmptyString(item.source, `${fieldName}.source`),
    text: assertNonEmptyString(item.text, `${fieldName}.text`),
    capturedAtMs: normalizeInteger(item.capturedAtMs, `${fieldName}.capturedAtMs`),
  };
}

/**
 * Build the protocol `presenterState` message.
 *
 * @param {Record<string, unknown>} state The resolved presenter state.
 * @returns {{ type: 'presenterState', [key: string]: unknown }}
 */
export function createPresenterStateMessage(state) {
  if (!isPlainObject(state) || state.type !== 'presenterState') {
    throw new TypeError('presenter state must be a resolved presenterState payload');
  }

  if (!isPlainObject(state.current)) {
    throw new TypeError('presenter state current must be an object');
  }

  if (!isPlainObject(state.teleprompter)) {
    throw new TypeError('presenter state teleprompter must be an object');
  }

  if (!isPlainObject(state.timer)) {
    throw new TypeError('presenter state timer must be an object');
  }

  if (!isPlainObject(state.obs)) {
    throw new TypeError('presenter state obs must be an object');
  }

  if (!isPlainObject(state.stream)) {
    throw new TypeError('presenter state stream must be an object');
  }

  return {
    type: 'presenterState',
    seq: normalizePositiveInteger(state.seq, 'seq'),
    presentationSeq: normalizeInteger(state.presentationSeq ?? 0, 'presentationSeq'),
    current: {
      slideId: typeof state.current.slideId === 'string' ? state.current.slideId : null,
      layoutId: typeof state.current.layoutId === 'string' ? state.current.layoutId : null,
      focus: typeof state.current.focus === 'string' ? state.current.focus : null,
      hidden: normalizeBoolean(state.current.hidden ?? false, 'current.hidden'),
      lines: Array.isArray(state.current.lines)
        ? state.current.lines.map((line, index) => normalizePresenterLine(line, `current.lines[${index}]`))
        : [],
    },
    next: state.next === null || state.next === undefined
      ? null
      : {
          slideId: assertNonEmptyString(state.next.slideId, 'next.slideId'),
          title: typeof state.next.title === 'string' ? state.next.title : null,
          heading: typeof state.next.heading === 'string' ? state.next.heading : null,
          index: {
            h: normalizeInteger(state.next.index?.h ?? 0, 'next.index.h'),
            v: normalizeInteger(state.next.index?.v ?? 0, 'next.index.v'),
          },
        },
    teleprompter: {
      followEnabled: normalizeBoolean(state.teleprompter.followEnabled, 'teleprompter.followEnabled'),
      activeLineIndex: normalizeInteger(state.teleprompter.activeLineIndex ?? 0, 'teleprompter.activeLineIndex'),
      trackingState: assertNonEmptyString(state.teleprompter.trackingState, 'teleprompter.trackingState'),
      recentTranscript: Array.isArray(state.teleprompter.recentTranscript)
        ? state.teleprompter.recentTranscript.map((item, index) => normalizePresenterTranscriptItem(item, `teleprompter.recentTranscript[${index}]`))
        : [],
    },
    timer: {
      running: normalizeBoolean(state.timer.running ?? false, 'timer.running'),
      elapsedMs: normalizeInteger(state.timer.elapsedMs ?? 0, 'timer.elapsedMs'),
      remainingMs: state.timer.remainingMs === null || state.timer.remainingMs === undefined
        ? null
        : normalizeInteger(state.timer.remainingMs, 'timer.remainingMs'),
      targetDurationMs: state.timer.targetDurationMs === null || state.timer.targetDurationMs === undefined
        ? null
        : normalizeInteger(state.timer.targetDurationMs, 'timer.targetDurationMs'),
    },
    obs: {
      preview: state.obs.preview === undefined || state.obs.preview === null
        ? null
        : {
            available: normalizeBoolean(state.obs.preview.available ?? false, 'obs.preview.available'),
            path: assertNonEmptyString(state.obs.preview.path, 'obs.preview.path'),
            revision: normalizeInteger(state.obs.preview.revision ?? 0, 'obs.preview.revision'),
            capturedAtMs: state.obs.preview.capturedAtMs === null || state.obs.preview.capturedAtMs === undefined
              ? null
              : normalizeInteger(state.obs.preview.capturedAtMs, 'obs.preview.capturedAtMs'),
            stale: normalizeBoolean(state.obs.preview.stale ?? true, 'obs.preview.stale'),
          },
    },
    stream: {
      active: normalizeBoolean(state.stream.active ?? false, 'stream.active'),
      reconnecting: normalizeBoolean(state.stream.reconnecting ?? false, 'stream.reconnecting'),
      bitrateKbps: state.stream.bitrateKbps === null || state.stream.bitrateKbps === undefined
        ? null
        : normalizeInteger(state.stream.bitrateKbps, 'stream.bitrateKbps'),
      droppedFrames: normalizeInteger(state.stream.droppedFrames ?? 0, 'stream.droppedFrames'),
      congestion: state.stream.congestion === null || state.stream.congestion === undefined
        ? null
        : normalizeInteger(state.stream.congestion, 'stream.congestion'),
      lastUpdateMs: state.stream.lastUpdateMs === null || state.stream.lastUpdateMs === undefined
        ? null
        : normalizeInteger(state.stream.lastUpdateMs, 'stream.lastUpdateMs'),
      warning: typeof state.stream.warning === 'string' ? state.stream.warning : null,
    },
    updatedAtMs: normalizeInteger(state.updatedAtMs ?? 0, 'updatedAtMs'),
  };
}

/**
 * Build the protocol `transcript` message.
 *
 * @param {{ source: string, text: string, capturedAtMs: number }} transcript Transcript details.
 * @returns {{ type: 'transcript', source: string, text: string, capturedAtMs: number }}
 */
export function createTranscriptMessage(transcript) {
  return {
    type: 'transcript',
    source: assertNonEmptyString(transcript.source, 'source'),
    text: assertNonEmptyString(transcript.text, 'text'),
    capturedAtMs: Number.isInteger(transcript.capturedAtMs) ? transcript.capturedAtMs : Number(transcript.capturedAtMs),
  };
}

function normalizePresenterCommand(message) {
  const normalized = {
    type: 'presenterCommand',
    op: assertNonEmptyString(message.op, 'op'),
    source: assertNonEmptyString(message.source, 'source'),
  };

  if (message.delta !== undefined) {
    normalized.delta = normalizeInteger(message.delta, 'delta');
  }

  if (message.lineIndex !== undefined) {
    normalized.lineIndex = normalizeInteger(message.lineIndex, 'lineIndex');
  }

  if (message.sourceId !== undefined) {
    normalized.sourceId = assertNonEmptyString(message.sourceId, 'sourceId');
  }

  return normalized;
}

function normalizeSlideManifest(message) {
  if (!Array.isArray(message.slides)) {
    throw new TypeError('slides must be an array');
  }

  return {
    type: 'slideManifest',
    slides: message.slides.map((slide, index) => {
      if (!isPlainObject(slide)) {
        throw new TypeError(`slides[${index}] must be an object`);
      }

      const normalized = {
        id: assertNonEmptyString(slide.id, `slides[${index}].id`),
        index: {
          h: normalizeInteger(slide.index?.h ?? 0, `slides[${index}].index.h`),
          v: normalizeInteger(slide.index?.v ?? 0, `slides[${index}].index.v`),
        },
      };

      if (slide.title !== undefined) {
        normalized.title = assertNonEmptyString(slide.title, `slides[${index}].title`);
      }

      if (slide.heading !== undefined) {
        normalized.heading = assertNonEmptyString(slide.heading, `slides[${index}].heading`);
      }

      return normalized;
    }),
  };
}

/**
 * Build the protocol `error` message.
 *
 * @param {string} code Protocol error code.
 * @param {string} message Human-readable error details.
 * @param {string | undefined} requestId Optional request identifier.
 * @returns {{ type: 'error', code: string, message: string, requestId?: string }}
 */
export function createErrorMessage(code, message, requestId) {
  const payload = {
    type: 'error',
    code: assertNonEmptyString(code, 'code'),
    message: assertNonEmptyString(message, 'message'),
  };

  if (typeof requestId === 'string' && requestId.trim() !== '') {
    payload.requestId = requestId.trim();
  }

  return payload;
}

/**
 * Validate and normalize a client-to-hub protocol message.
 *
 * @param {unknown} message The inbound client message.
 * @returns {Record<string, unknown>} The normalized message.
 */
export function validateClientMessage(message) {
  if (!isPlainObject(message)) {
    throw new TypeError('Client message must be an object');
  }

  const type = assertNonEmptyString(message.type, 'type');

  if (type === 'register') {
    const role = assertRole(message.role);
    const capabilities = normalizeCapabilities(message.capabilities);

    if (role === 'driver') {
      const normalized = {
        type,
        role,
        capabilities,
      };

      if (message.clientId !== undefined) {
        normalized.clientId = assertNonEmptyString(message.clientId, 'clientId');
      }

      return normalized;
    }

    if (role === 'observer') {
      return {
        type,
        role,
        subscriptions: normalizeSubscriptions(message.subscriptions),
        capabilities,
      };
    }

    throw new TypeError('role must be either "driver" or "observer"');
  }

  if (type === 'positionChanged') {
    if (!isPlainObject(message.position)) {
      throw new TypeError('position must be an object');
    }

    const normalized = {
      type,
      position: {
        id: assertNonEmptyString(message.position.id, 'position.id'),
      },
    };

    if (message.position.index !== undefined) {
      if (!isPlainObject(message.position.index)) {
        throw new TypeError('position.index must be an object');
      }

      normalized.position.index = message.position.index;
    }

    if (message.position.meta !== undefined) {
      if (!isPlainObject(message.position.meta)) {
        throw new TypeError('position.meta must be an object');
      }

      normalized.position.meta = message.position.meta;
    }

    return normalized;
  }

  if (type === 'transcript') {
    return createTranscriptMessage({
      source: message.source,
      text: message.text,
      capturedAtMs: message.capturedAtMs,
    });
  }

  if (type === 'driverCommand') {
    if (!isPlainObject(message.command)) {
      throw new TypeError('command must be an object');
    }

    assertNonEmptyString(message.command.type, 'command.type');

    return {
      type,
      command: message.command,
    };
  }

  if (type === 'presenterCommand') {
    return normalizePresenterCommand(message);
  }

  if (type === 'slideManifest') {
    return normalizeSlideManifest(message);
  }

  if (type === 'windowBindings') {
    return normalizeWindowBindingsMessage(message);
  }

  if (type === 'windowSettled') {
    // frameMismatches is optional so older presenter-web observers without it
    // stay backward compatible.
    const normalized = {
      type,
      seq: normalizePositiveInteger(message.seq, 'seq'),
    };

    if (message.frameMismatches !== undefined) {
      normalized.frameMismatches = normalizeFrameMismatches(message.frameMismatches);
    }

    return normalized;
  }

  if (type === 'positionSettled') {
    return {
      type,
      eventId: normalizePositiveInteger(message.eventId, 'eventId'),
    };
  }

  throw new TypeError(`Unsupported message type: ${type}`);
}
