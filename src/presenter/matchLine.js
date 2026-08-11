function normalizeWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function countWordMatches(lineWords, transcriptWords) {
  const remaining = new Map();

  for (const word of transcriptWords) {
    remaining.set(word, (remaining.get(word) ?? 0) + 1);
  }

  let matches = 0;

  for (const word of lineWords) {
    const count = remaining.get(word) ?? 0;

    if (count <= 0) {
      continue;
    }

    matches += 1;

    if (count === 1) {
      remaining.delete(word);
    } else {
      remaining.set(word, count - 1);
    }
  }

  return matches;
}

function countMatchedWords(lineWords, transcriptWords) {
  return countWordMatches(lineWords, transcriptWords);
}

function computeScore(lineWords, transcriptWords) {
  const matches = countWordMatches(lineWords, transcriptWords);

  if (matches === 0) {
    return 0;
  }

  const precision = matches / lineWords.length;
  const recall = matches / transcriptWords.length;

  if (precision + recall === 0) {
    return 0;
  }

  return (2 * precision * recall) / (precision + recall);
}

function computeTailScore(lineWords, transcriptWords) {
  return computeScore(lineWords, transcriptWords.slice(-lineWords.length));
}

function countTrailingPrefixMatches(lineWords, transcriptWords) {
  const maxLength = Math.min(lineWords.length, transcriptWords.length);

  for (let length = maxLength; length > 0; length -= 1) {
    let matched = true;

    for (let index = 0; index < length; index += 1) {
      if (lineWords[index] !== transcriptWords[transcriptWords.length - length + index]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return length;
    }
  }

  return 0;
}

function countTrailingSuffixMatches(lineWords, transcriptWords) {
  const maxLength = Math.min(lineWords.length, transcriptWords.length);
  let matched = 0;

  while (
    matched < maxLength
    && lineWords[lineWords.length - matched - 1] === transcriptWords[transcriptWords.length - matched - 1]
  ) {
    matched += 1;
  }

  return matched;
}

function hasDistinctForwardPrefix(currentLineWords, nextLineWords, prefixLength) {
  if (prefixLength <= 0) {
    return false;
  }

  for (let index = 0; index < prefixLength; index += 1) {
    if (currentLineWords[currentLineWords.length - prefixLength + index] !== nextLineWords[index]) {
      return true;
    }
  }

  return false;
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
 * @returns {{ index: number, confidence: number, handoff?: 'early' }}
 */
export function matchLineDetailed(transcriptTail, lines, fromIndex, options = {}) {
  const transcriptWords = normalizeWords(transcriptTail);

  if (transcriptWords.length === 0 || !Array.isArray(lines) || lines.length === 0) {
    return { index: Math.max(0, fromIndex), confidence: 0 };
  }

  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.35;
  const startIndex = Math.max(0, Math.min(lines.length - 1, fromIndex));
  const endIndex = typeof options.maxIndex === 'number'
    ? Math.max(startIndex, Math.min(lines.length - 1, options.maxIndex))
    : lines.length - 1;
  const scoredLines = new Map();
  let bestIndex = startIndex;
  let bestScore = 0;
  let bestTailScore = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const spokenText = getSpokenText(lines[index]);
    const lineWords = normalizeWords(spokenText);

    if (lineWords.length === 0) {
      continue;
    }

    const score = computeScore(lineWords, transcriptWords);
    const tailScore = computeTailScore(lineWords, transcriptWords);

    scoredLines.set(index, {
      lineWords,
      score,
      tailScore,
    });

    if (score > bestScore || (score === bestScore && tailScore > bestTailScore)) {
      bestScore = score;
      bestTailScore = tailScore;
      bestIndex = index;
    }
  }

  if (bestScore < threshold) {
    return { index: startIndex, confidence: bestScore };
  }

  if (bestIndex === startIndex) {
    const currentLine = scoredLines.get(startIndex) ?? null;
    let nextLine = null;

    for (let index = startIndex + 1; index <= endIndex; index += 1) {
      const candidate = scoredLines.get(index);

      if (candidate !== undefined) {
        nextLine = { index, ...candidate };
        break;
      }
    }

    if (currentLine !== null && nextLine !== null) {
      const requiredPrefixWords = Math.min(
        nextLine.lineWords.length,
        Math.max(2, Math.ceil(nextLine.lineWords.length / 3)),
      );
      const nextPrefixWords = countTrailingPrefixMatches(nextLine.lineWords, transcriptWords);
      const nextPrefixScore = nextPrefixWords > 0
        ? computeScore(nextLine.lineWords, transcriptWords.slice(-nextPrefixWords))
        : 0;
      const currentCoveredWords = countMatchedWords(currentLine.lineWords, transcriptWords);
      const currentCoveredRatio = currentLine.lineWords.length > 0
        ? currentCoveredWords / currentLine.lineWords.length
        : 0;

      // Generalized early advance: when the current line is well-covered and
      // the next line has distinct prefix evidence at the transcript tail,
      // advance immediately instead of waiting for the next line's words to
      // dominate the rolling window. Without this, the highlight lags a full
      // line behind because the matcher keeps scoring the finished line higher.
      if (currentCoveredRatio >= 0.55
        && nextPrefixWords >= requiredPrefixWords
        && (nextLine.tailScore >= Math.max(threshold, 0.45)
          || nextPrefixScore >= Math.max(threshold, 0.45))
        && hasDistinctForwardPrefix(currentLine.lineWords, nextLine.lineWords, nextPrefixWords)) {
        return { index: nextLine.index, confidence: nextLine.tailScore, handoff: 'early' };
      }
    }
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
