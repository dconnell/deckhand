/**
 * Comparable-index math for driver-reported slide positions.
 *
 * Pure functions with no coordinator state, extracted so the transition and
 * settle owners can share one definition of "which direction is the deck
 * moving" without reaching back into the coordinator.
 */

/**
 * Extract a comparable `{ h, v }` index from a driver position payload.
 *
 * Returns `null` when no usable horizontal index is present (e.g. the first
 * reported position, or a payload that omits index data), which the direction
 * logic treats as "no previous frame to compare against".
 *
 * @param {{ index?: { h?: unknown, v?: unknown } } | null} position The driver position payload.
 * @returns {{ h: number, v: number } | null}
 */
export function extractSlideIndex(position) {
  const index = position?.index;

  if (index === null || typeof index !== 'object') {
    return null;
  }

  const h = Number.isInteger(index.h) ? index.h : null;

  if (h === null) {
    return null;
  }

  return { h, v: Number.isInteger(index.v) ? index.v : 0 };
}

/**
 * Compute the perceived slide direction from the previous vs. current index.
 *
 * `next` advances, `prev` retreats. Same-index jumps (or the first reported
 * position) yield `'none'`, which the reveal step treats as a neutral
 * transition. The comparison is horizontal-first, then vertical within the same
 * horizontal index, matching reveal.js deck ordering.
 *
 * @param {{ h: number, v: number } | null} previous The prior slide index.
 * @param {{ h: number, v: number } | null} current The new slide index.
 * @returns {'forward' | 'backward' | 'none'}
 */
export function computeSlideDirection(previous, current) {
  if (previous === null || current === null) {
    return 'none';
  }

  if (current.h > previous.h) {
    return 'forward';
  }

  if (current.h < previous.h) {
    return 'backward';
  }

  if (current.v > previous.v) {
    return 'forward';
  }

  if (current.v < previous.v) {
    return 'backward';
  }

  return 'none';
}
