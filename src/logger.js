function sanitizeContext(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeContext(entry));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, key.toLowerCase().includes('password') ? '[redacted]' : sanitizeContext(entry)]),
    );
  }

  return value;
}

/**
 * The shared logger surface used by Deckhand factories: `error`, `info`, and
 * `warn`, each taking a message plus an optional context record.
 *
 * @typedef {object} Logger
 * @property {(message: string, context?: Record<string, unknown>) => void} error
 * @property {(message: string, context?: Record<string, unknown>) => void} info
 * @property {(message: string, context?: Record<string, unknown>) => void} warn
 */

/**
 * Create a logger with the shared {@link Logger} shape that discards all
 * output. Use as the default for factories whose logger dependency is optional,
 * instead of a fresh local no-op implementation per file.
 *
 * @returns {Logger} No-op logger.
 */
export function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

/**
 * Create a logger with the shared {@link Logger} shape that writes prefixed,
 * context-sanitized lines through the given console-like sink.
 *
 * @param {Console} consoleLike Console-compatible sink.
 * @returns {Logger} Console logger with context sanitization.
 */
export function createLogger(consoleLike) {
  function write(method, message, context) {
    const parts = [`[deckhand] ${message}`];

    if (context !== undefined) {
      parts.push(JSON.stringify(sanitizeContext(context)));
    }

    consoleLike[method](parts.join(' '));
  }

  return {
    error(message, context) {
      write('error', message, context);
    },
    info(message, context) {
      write('info', message, context);
    },
    warn(message, context) {
      write('warn', message, context);
    },
  };
}

export { sanitizeContext };
