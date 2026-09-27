/**
 * Resolve after `ms` milliseconds.
 *
 * Only for tests that directly verify timeout behavior; ordinary tests should
 * wait on an observable effect instead of a wall-clock sleep.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `check` (sync or async) until it returns a truthy value or the timeout
 * elapses. `description` should name the observable effect being waited for so
 * timeouts explain what went wrong.
 * @param {() => unknown | Promise<unknown>} check
 * @param {{ timeoutMs?: number, intervalMs?: number, description?: string }} [options]
 * @returns {Promise<void>} resolves once `check` returns truthy
 * @throws {Error} when the deadline passes before `check` returns truthy
 */
export async function waitForCondition(check, {
  timeoutMs = 2000,
  intervalMs = 10,
  description = 'condition',
} = {}) {
  if (typeof check !== 'function') {
    throw new TypeError('waitForCondition expects a check function');
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

/**
 * Poll `messages` with `predicate` until it returns true or the timeout
 * elapses. The timeout error includes the received messages so failures show
 * what actually arrived.
 * @param {Array<unknown>} messages array observed in place (e.g. a stub's call log)
 * @param {(messages: Array<unknown>) => boolean} predicate
 * @param {string} description what is being waited for
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<void>} resolves once `predicate(messages)` returns true
 * @throws {Error} when the deadline passes before the predicate holds
 */
export async function waitForMessages(messages, predicate, description, {
  timeoutMs = 2000,
  intervalMs = 10,
} = {}) {
  if (!Array.isArray(messages)) {
    throw new TypeError('waitForMessages expects an array to observe');
  }
  if (typeof predicate !== 'function') {
    throw new TypeError('waitForMessages expects a predicate function');
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate(messages)) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}; received: ${JSON.stringify(messages)}`);
}
