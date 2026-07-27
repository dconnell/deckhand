/**
 * Split a slide script into presenter lines.
 *
 * @param {string | null | undefined} text Slide script text.
 * @returns {string[]}
 */
export function splitScript(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [];
  }

  return text
    .split('\n')
    .flatMap((segment) => segment
      .trim()
      .split(/(?<=[.!?])\s+/)
      .map((entry) => entry.trim()))
    .filter((entry) => entry !== '');
}
