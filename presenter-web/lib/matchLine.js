function normalizeWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Match transcript text to the best forward script line.
 *
 * @param {string} transcriptTail Recent transcript text.
 * @param {string[]} lines Script lines.
 * @param {number} fromIndex Current forward-only line index.
 * @returns {number}
 */
export function matchLine(transcriptTail, lines, fromIndex) {
  const transcriptWords = normalizeWords(transcriptTail);

  if (transcriptWords.length === 0) {
    return fromIndex;
  }

  let bestIndex = fromIndex;
  let bestScore = 0;

  for (let index = fromIndex; index < lines.length; index += 1) {
    const lineWords = normalizeWords(lines[index]);

    if (lineWords.length === 0) {
      continue;
    }

    const matches = lineWords.filter((word) => transcriptWords.includes(word)).length;
    const score = matches / lineWords.length;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestScore >= 0.35 ? bestIndex : fromIndex;
}
