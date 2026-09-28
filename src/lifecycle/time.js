/**
 * Resolve after `ms` milliseconds.
 *
 * @param {number} ms Milliseconds to wait.
 * @returns {Promise<void>} Resolves once the delay has elapsed.
 */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Reject with `timeoutMessage` unless `promise` settles within `timeoutMs`.
 * The pending timer is cleared as soon as the race settles, so short-lived
 * waits do not leak timers.
 *
 * If the timeout wins, a later rejection of `promise` is left unhandled; callers
 * racing fallible stop/close promises must suppress it themselves
 * (e.g. `promise.catch(() => {})`).
 *
 * @template T
 * @param {Promise<T>} promise The promise to race against the timeout.
 * @param {number} timeoutMs Milliseconds to wait before rejecting.
 * @param {string} timeoutMessage Message used for the timeout rejection.
 * @returns {Promise<T>} Settles with `promise`, or rejects once the timeout fires.
 */
export function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timer = null;

  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}
