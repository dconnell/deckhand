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

  return String(previousText ?? '').trim() !== next;
}
