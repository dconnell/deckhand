function normalizeForComparison(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decide whether the latest transcript text should be published.
 *
 * @param {string} previousText Last published transcript text.
 * @param {string} nextText Newly parsed transcript text.
 * @returns {boolean}
 */
export function shouldPublishTranscript(previousText, nextText) {
  const next = String(nextText ?? '').trim();

  if (next === '') {
    return false;
  }

  return normalizeForComparison(previousText) !== normalizeForComparison(next);
}
