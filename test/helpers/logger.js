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

// Re-export the production no-op logger so tests and factories share one
// implementation and shape.
export { createNoopLogger } from '../../src/logger.js';
