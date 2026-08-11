function normalizeWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Minimum TF-IDF weighted score for the next-line prefix/tail evidence that
// authorizes an early handoff. See matchLineDetailed for the full rationale.
const EARLY_HANDOFF_PREFIX_FLOOR = 0.3;

function sumLineWeights(lineWords, weightOf) {
  let total = 0;

  for (const word of lineWords) {
    total += weightOf(word);
  }

  return total;
}

function sumMatchedWeights(lineWords, transcriptWords, weightOf) {
  const remaining = new Map();

  for (const word of transcriptWords) {
    remaining.set(word, (remaining.get(word) ?? 0) + 1);
  }

  let matched = 0;

  for (const word of lineWords) {
    const count = remaining.get(word) ?? 0;

    if (count <= 0) {
      continue;
    }

    matched += weightOf(word);

    if (count === 1) {
      remaining.delete(word);
    } else {
      remaining.set(word, count - 1);
    }
  }

  return matched;
}

// TF-IDF style distinctive-word weighting: each line word contributes
// `1 / documentFrequency`, where documentFrequency is the number of slide lines
// the word appears in. Distinctive words anchor the match; ubiquitous filler
// (e.g. "the", "and") gets discounted so it cannot inflate old-line scores and
// lag the highlight. Score is weighted precision: matched weight over total
// line weight. Recall is intentionally dropped because a short, fully-present
// line is a strong anchor even when the rolling window holds extra words.
function computeScore(lineWords, transcriptWords, weightOf) {
  const totalWeight = sumLineWeights(lineWords, weightOf);

  if (totalWeight === 0) {
    return 0;
  }

  return sumMatchedWeights(lineWords, transcriptWords, weightOf) / totalWeight;
}

function computeTailScore(lineWords, transcriptWords, weightOf) {
  return computeScore(lineWords, transcriptWords.slice(-lineWords.length), weightOf);
}

function computeDocumentFrequency(lines) {
  const documentFrequency = new Map();

  for (const line of lines) {
    const words = normalizeWords(getSpokenText(line));
    const seen = new Set();

    for (const word of words) {
      if (seen.has(word)) {
        continue;
      }

      seen.add(word);
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }

  return documentFrequency;
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
  const documentFrequency = computeDocumentFrequency(lines);
  const weightOf = (word) => 1 / (documentFrequency.get(word) ?? 1);
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

    const score = computeScore(lineWords, transcriptWords, weightOf);
    const tailScore = computeTailScore(lineWords, transcriptWords, weightOf);

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
        ? computeScore(nextLine.lineWords, transcriptWords.slice(-nextPrefixWords), weightOf)
        : 0;
      const currentCoveredRatio = currentLine.score;

      // Generalized early advance: when the current line is well-covered and
      // the next line has distinct prefix evidence at the transcript tail,
      // advance immediately instead of waiting for the next line's words to
      // dominate the rolling window. Without this, the highlight lags a full
      // line behind because the matcher keeps scoring the finished line higher.
      //
      // The prefix score floor is decoupled from the main match threshold and
      // kept low: under TF-IDF weighted precision, hearing just the required
      // prefix (ceil(n/3) words) of an n-word line covers ~1/3 of its weight, so
      // a floor near 0.3 confirms the prefix is genuine without demanding the
      // near-full coverage that would defeat the purpose of an early handoff.
      // Spurious advances are still blocked by the prefix-count gate above and
      // the distinct-forward-prefix check below.
      if (currentCoveredRatio >= 0.55
        && nextPrefixWords >= requiredPrefixWords
        && (nextLine.tailScore >= EARLY_HANDOFF_PREFIX_FLOOR
          || nextPrefixScore >= EARLY_HANDOFF_PREFIX_FLOOR)
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
