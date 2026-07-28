function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
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

const OBSERVER_SUBSCRIPTIONS = new Set(['presentationState', 'transcript']);

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

  return payload;
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

  throw new TypeError(`Unsupported message type: ${type}`);
}
