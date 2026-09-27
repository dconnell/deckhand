function hasSpokenText(line) {
  return typeof line?.spokenText === 'string' && line.spokenText.trim() !== '';
}

function listSpokenLineIndices(lines) {
  return lines
    .map((line, index) => (hasSpokenText(line) ? index : null))
    .filter((index) => index !== null);
}

export function findFirstSpokenLine(lines) {
  return listSpokenLineIndices(lines)[0] ?? 0;
}

export function clampToSpokenLine(lines, index) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return 0;
  }

  if (hasSpokenText(lines[index])) {
    return index;
  }

  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (hasSpokenText(lines[cursor])) {
      return cursor;
    }
  }

  for (let cursor = Math.max(0, index + 1); cursor < lines.length; cursor += 1) {
    if (hasSpokenText(lines[cursor])) {
      return cursor;
    }
  }

  return 0;
}

export function moveBySpokenLines(lines, fromIndex, delta) {
  const spokenLineIndices = listSpokenLineIndices(lines);

  if (spokenLineIndices.length === 0) {
    return 0;
  }

  const currentIndex = clampToSpokenLine(lines, fromIndex);
  const currentSpokenIndex = Math.max(0, spokenLineIndices.indexOf(currentIndex));
  const targetSpokenIndex = Math.min(
    spokenLineIndices.length - 1,
    Math.max(0, currentSpokenIndex + delta),
  );

  return spokenLineIndices[targetSpokenIndex];
}

/**
 * Jump between paragraph groups of spoken lines.
 *
 * @param {Array<{ spokenText?: string, paragraphIndex?: number }>} lines Structured presenter lines.
 * @param {number} fromIndex Current active line index.
 * @param {number} deltaParagraphs Number of paragraph groups to move.
 * @returns {number}
 */
export function findParagraphJumpTarget(lines, fromIndex, deltaParagraphs) {
  const spokenLineIndices = listSpokenLineIndices(lines);

  if (spokenLineIndices.length === 0) {
    return 0;
  }

  const paragraphLeadIndices = [];
  let previousParagraphIndex = null;

  for (const spokenIndex of spokenLineIndices) {
    const paragraphIndex = lines[spokenIndex]?.paragraphIndex ?? 0;

    if (paragraphIndex !== previousParagraphIndex) {
      paragraphLeadIndices.push(spokenIndex);
      previousParagraphIndex = paragraphIndex;
    }
  }

  const currentIndex = clampToSpokenLine(lines, fromIndex);
  const currentParagraphIndex = lines[currentIndex]?.paragraphIndex ?? 0;
  const currentParagraphOrdinal = Math.max(0, paragraphLeadIndices.findIndex((index) => {
    return (lines[index]?.paragraphIndex ?? 0) === currentParagraphIndex;
  }));
  const targetParagraphOrdinal = Math.min(
    paragraphLeadIndices.length - 1,
    Math.max(0, currentParagraphOrdinal + deltaParagraphs),
  );

  return paragraphLeadIndices[targetParagraphOrdinal];
}
