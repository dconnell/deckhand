/**
 * Check whether a value is a plain-ish object: non-null, non-array object.
 *
 * Deliberately permissive (a `Date` or class instance passes) to match the
 * semantics of the local copies this helper replaces; call sites that need to
 * reject exotic objects must layer their own checks on top.
 *
 * @param {unknown} value The value to check.
 * @returns {boolean} True when `value` is a non-null, non-array object.
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
