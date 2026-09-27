/**
 * Normalize an environment- or input-provided port value into a valid port
 * number so callers never listen on a coerced `NaN` or out-of-range value.
 *
 * `undefined` and empty or whitespace-only strings mean "not provided" and
 * return `options.fallback`. Port `0` is valid and asks the OS for a free
 * port; pass `min: 1` when the caller pins a fixed port that must never
 * request one.
 *
 * @param {unknown} value Raw port value, e.g. `process.env.PORT`.
 * @param {{ fallback?: number, label?: string, min?: number }} [options] `fallback` returned when the value is not provided; `label` names the value in error messages (default `"port"`); `min` sets the inclusive lower bound (default `0`).
 * @returns {number} An integer between `min` and 65535.
 * @throws {Error} When the value is present but not a whole number between `min` and 65535, or when it is absent and no fallback is given.
 */
export function normalizePort(value, options = {}) {
  const { fallback, label = 'port', min = 0 } = options;

  if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
    if (fallback === undefined) {
      throw new Error(`${label} is required`);
    }

    return fallback;
  }

  let parsed;

  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    parsed = Number(value.trim());
  } else {
    parsed = Number.NaN;
  }

  if (!Number.isInteger(parsed) || parsed < min || parsed > 65535) {
    throw new Error(`${label} must be an integer between ${min} and 65535, received ${formatValue(value)}`);
  }

  return parsed;
}

/**
 * Format an invalid port value for an error message.
 *
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
