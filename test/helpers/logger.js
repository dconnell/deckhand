/**
 * Logger that records every entry so tests can assert on what production code
 * logged. Entry arrays (`infos`, `warns`, `errors`) are exposed directly.
 *
 * @returns {{ infos: Array<{ message: unknown, context: unknown }>, warns: Array<{ message: unknown, context: unknown }>, errors: Array<{ message: unknown, context: unknown }>, info: (message: unknown, context?: unknown) => void, warn: (message: unknown, context?: unknown) => void, error: (message: unknown, context?: unknown) => void }} Capturing logger.
 */
export function createCaptureLogger() {
  const infos = [];
  const warns = [];
  const errors = [];

  return {
    infos,
    warns,
    errors,
    info(message, context) {
      infos.push({ message, context });
    },
    warn(message, context) {
      warns.push({ message, context });
    },
    error(message, context) {
      errors.push({ message, context });
    },
  };
}

/**
 * Logger that discards all output, for tests that must satisfy a logger
 * dependency without asserting on it.
 *
 * @returns {{ info: () => void, warn: () => void, error: () => void }} No-op logger.
 */
export function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
