import { readFile, rename, writeFile } from 'node:fs/promises';

const STATE_TMP_SUFFIX = '.tmp';

/**
 * Read the last persisted slide id for a presentation.
 *
 * The state file is a recovery aid: on a mid-talk restart the operator should
 * not have to manually navigate the deck back to the current slide. This helper
 * is deliberately fault-tolerant — a missing, unreadable, or malformed file is
 * treated as "no resume point" (`null`) rather than throwing, so a corrupted
 * state file can never block startup.
 *
 * @param {{ statePath: string }} options Location of the state file.
 * @returns {Promise<{ slideId: string, index: unknown, savedAtMs: number | null } | null>}
 *   The persisted slide id plus diagnostics, or `null` when none is available.
 */
export async function loadResumableSlide({ statePath }) {
  let text;

  try {
    text = await readFile(statePath, 'utf8');
  } catch {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (
    parsed === null
    || typeof parsed !== 'object'
    || typeof parsed.slideId !== 'string'
    || parsed.slideId.trim() === ''
  ) {
    return null;
  }

  return {
    slideId: parsed.slideId,
    index: parsed.index ?? null,
    savedAtMs: typeof parsed.savedAtMs === 'number' ? parsed.savedAtMs : null,
  };
}

/**
 * Persist the active slide id for a presentation atomically.
 *
 * Writes to a sibling `.tmp` file and renames it into place so a crash mid-write
 * never leaves a truncated state file that would block the next startup.
 *
 * @param {{ statePath: string, slideId: string, index?: unknown, nowMs?: number }} options Persistence payload.
 * @returns {Promise<void>}
 */
export async function persistSlideId({ statePath, slideId, index, nowMs }) {
  const payload = {
    slideId,
    index: index ?? null,
    savedAtMs: typeof nowMs === 'number' ? nowMs : Date.now(),
  };
  const temporaryPath = `${statePath}${STATE_TMP_SUFFIX}`;

  await writeFile(temporaryPath, JSON.stringify(payload), 'utf8');
  await rename(temporaryPath, statePath);
}
