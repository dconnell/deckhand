function normalizeWords(text) {
  return [...new Set(String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean))];
}

function getSpokenText(line) {
  if (typeof line === 'string') {
    return line;
  }

  return typeof line?.spokenText === 'string' ? line.spokenText : '';
}

/**
 * Match transcript text to the best forward script line.
 *
 * @param {string} transcriptTail Recent transcript text.
 * @param {Array<string | { spokenText?: string }>} lines Script lines.
 * @param {number} fromIndex Current forward-only line index.
 * @param {{ threshold?: number }} [options] Matcher options.
 * @returns {{ index: number, confidence: number }}
 */
export function matchLineDetailed(transcriptTail, lines, fromIndex, options = {}) {
  const transcriptWords = normalizeWords(transcriptTail);

  if (transcriptWords.length === 0 || !Array.isArray(lines) || lines.length === 0) {
    return { index: Math.max(0, fromIndex), confidence: 0 };
  }

  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.35;
  const startIndex = Math.max(0, Math.min(lines.length - 1, fromIndex));
  let bestIndex = startIndex;
  let bestScore = 0;

  for (let index = startIndex; index < lines.length; index += 1) {
    const spokenText = getSpokenText(lines[index]);
    const lineWords = normalizeWords(spokenText);

    if (lineWords.length === 0) {
      continue;
    }

    const matches = lineWords.filter((word) => transcriptWords.includes(word)).length;
    const precision = matches / lineWords.length;
    const recall = matches / transcriptWords.length;
    const score = Math.max(precision, (precision + recall) / 2);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestScore < threshold) {
    return { index: startIndex, confidence: bestScore };
  }

  return { index: bestIndex, confidence: bestScore };
}

/**
 * Match transcript text to the best forward script line.
 *
 * @param {string} transcriptTail Recent transcript text.
 * @param {Array<string | { spokenText?: string }>} lines Script lines.
 * @param {number} fromIndex Current forward-only line index.
 * @param {{ threshold?: number }} [options] Matcher options.
 * @returns {number}
 */
export function matchLine(transcriptTail, lines, fromIndex, options) {
  return matchLineDetailed(transcriptTail, lines, fromIndex, options).index;
}
