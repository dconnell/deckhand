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
