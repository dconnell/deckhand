function cleanString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Storage key used by the browser target userscript.
 *
 * @type {string}
 */
export const STORAGE_KEY = 'deckhand-target-identity';

/**
 * Built-in metadata for the browser target boundary.
 *
 * @type {{ name: string, kind: 'target', capabilities: string[] }}
 */
export const browserTarget = Object.freeze({
  name: 'browser-tab',
  kind: 'target',
  capabilities: ['navigate'],
});

/**
 * Parse controller identity parameters from a query string.
 *
 * @param {string} search The query string, with or without the leading `?`.
 * @returns {{ controllerId: string | null, tabId: string | null }}
 */
export function parseIdentityParams(search) {
  const params = new URLSearchParams(String(search).replace(/^\?/, ''));

  return {
    controllerId: cleanString(params.get('controllerId')),
    tabId: cleanString(params.get('tabId')),
  };
}

/**
 * Validate a browser target identity.
 *
 * @param {{ controllerId: string, tabId?: string | null }} identity The identity to validate.
 * @returns {{ controllerId: string, tabId: string | null }}
 */
export function validateTargetIdentity(identity) {
  const controllerId = cleanString(identity?.controllerId);
  const tabId = cleanString(identity?.tabId ?? null);

  if (controllerId === null) {
    throw new TypeError('controllerId required');
  }

  if (controllerId.includes(':') || (tabId !== null && tabId.includes(':'))) {
    throw new TypeError('":" not allowed in controllerId or tabId');
  }

  return {
    controllerId,
    tabId,
  };
}

/**
 * Resolve the effective target identity using URL params over stored settings.
 *
 * @param {{ searchParams?: { controllerId?: string | null, tabId?: string | null }, storedIdentity?: { controllerId?: string | null, tabId?: string | null } | null }} input Resolution inputs.
 * @returns {{ controllerId: string | null, tabId: string | null, shouldPersist: boolean }}
 */
export function resolveTargetIdentity(input) {
  const searchControllerId = cleanString(input?.searchParams?.controllerId);
  const searchTabId = cleanString(input?.searchParams?.tabId);
  const storedControllerId = cleanString(input?.storedIdentity?.controllerId);
  const storedTabId = cleanString(input?.storedIdentity?.tabId);

  return {
    controllerId: searchControllerId ?? storedControllerId,
    tabId: searchTabId ?? storedTabId,
    shouldPersist: searchControllerId !== null || searchTabId !== null,
  };
}

/**
 * Read a persisted browser target identity from storage.
 *
 * @param {{ getItem(key: string): string | null }} storage The storage implementation to read from.
 * @returns {{ controllerId: string, tabId: string | null } | null}
 */
export function readStoredIdentity(storage) {
  const rawValue = storage.getItem(STORAGE_KEY);

  if (rawValue === null) {
    return null;
  }

  try {
    return validateTargetIdentity(JSON.parse(rawValue));
  } catch {
    return null;
  }
}

/**
 * Persist a browser target identity to storage.
 *
 * @param {{ setItem(key: string, value: string): void }} storage The storage implementation to write to.
 * @param {{ controllerId: string, tabId?: string | null }} identity The identity to persist.
 * @returns {{ controllerId: string, tabId: string | null }}
 */
export function writeStoredIdentity(storage, identity) {
  const validated = validateTargetIdentity(identity);
  storage.setItem(STORAGE_KEY, JSON.stringify(validated));
  return validated;
}

/**
 * Build the registration message used by browser target clients.
 *
 * @param {{ controllerId: string, tabId?: string | null }} identity The browser target identity.
 * @returns {{ type: 'register', role: 'target', controllerId: string, tabId?: string, capabilities: string[] }}
 */
export function buildTargetRegistrationMessage(identity) {
  const validated = validateTargetIdentity(identity);
  const message = {
    type: 'register',
    role: 'target',
    controllerId: validated.controllerId,
    capabilities: ['navigate'],
  };

  if (validated.tabId !== null) {
    message.tabId = validated.tabId;
  }

  return message;
}

/**
 * Decide whether a navigation command should change the current page.
 *
 * @param {string} currentHref The current browser URL.
 * @param {string} nextHref The requested navigation URL.
 * @returns {boolean}
 */
export function shouldNavigate(currentHref, nextHref) {
  return String(currentHref) !== String(nextHref);
}
