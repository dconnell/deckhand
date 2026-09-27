/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Replaces the repeated `error instanceof Error ? error.message : String(error)`
 * pattern at `catch` sites that only need text for logs or protocol payloads.
 *
 * @param {unknown} error The thrown value to describe.
 * @returns {string} `error.message` for `Error` instances, otherwise `String(error)`.
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
