/**
 * Scoped `process.exit` monkey-patch for tests whose production seam is not
 * yet injectable. The patch and its restore travel together, so a throwing
 * test body can never leak the patched exit into other tests.
 *
 * @param {(exitCalls: Array<unknown>) => Promise<void> | void} fn
 *   Test body executed while `process.exit` is patched. Receives the array
 *   every exit call is recorded into.
 * @param {{ onExit?: (code: unknown) => unknown }} [options]
 *   `onExit` replaces the patched implementation. Return a value to emulate
 *   `process.exit`'s (never-returning) call, or throw to abort the caller the
 *   way a stubbed exit must in teardown tests.
 * @returns {Promise<void>} resolves with `fn`'s result once it settles and the
 *   original `process.exit` has been restored
 */
export async function withPatchedExit(fn, { onExit } = {}) {
  if (typeof process.exit !== 'function') {
    throw new Error('process.exit is not a function; nothing to patch');
  }

  const originalExit = process.exit;
  const exitCalls = [];

  process.exit = (code) => {
    exitCalls.push(code);
    if (onExit) {
      return onExit(code);
    }
    return undefined;
  };

  try {
    return await fn(exitCalls);
  } finally {
    process.exit = originalExit;
  }
}
