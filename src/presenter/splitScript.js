function normalizeWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function createTextToken(text) {
  return {
    kind: 'text',
    text,
  };
}

function tokenizeInlineText(text) {
  const tokens = [];
  const pattern = /(\*[^*]+\*|\.\.\.|…)/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;

    if (index > cursor) {
      const leading = normalizeWhitespace(text.slice(cursor, index));

      if (leading !== '') {
        tokens.push(createTextToken(leading));
      }
    }

    const value = match[0];
    if (value === '...' || value === '…') {
      tokens.push({ kind: 'pause', text: value });
    } else {
      const emphasis = normalizeWhitespace(value.slice(1, -1));

      if (emphasis !== '') {
        tokens.push({ kind: 'emphasis', text: emphasis });
      }
    }

    cursor = index + value.length;
  }

  if (cursor < text.length) {
    const trailing = normalizeWhitespace(text.slice(cursor));

    if (trailing !== '') {
      tokens.push(createTextToken(trailing));
    }
  }

  return tokens;
}

function joinSpokenTokens(tokens) {
  return normalizeWhitespace(tokens
    .filter((token) => token.kind === 'text' || token.kind === 'emphasis')
    .map((token) => token.text)
    .join(' '));
}

function createSpokenLine(text, paragraphIndex, mode) {
  const tokens = tokenizeInlineText(text);

  return {
    tokens,
    spokenText: joinSpokenTokens(tokens),
    paragraphIndex,
    ...(mode === null ? {} : { mode }),
  };
}

function createMetaLine(kind, text, paragraphIndex, mode) {
  // An empty meta value (e.g. "[cmd: ]") is emitted as a bare token like the
  // gap precedent: protocol.js rejects token text of ''.
  const hasText = typeof text === 'string' && text.trim() !== '';

  return {
    tokens: hasText ? [{ kind, text }] : [{ kind }],
    spokenText: '',
    paragraphIndex,
    ...(mode === null ? {} : { mode }),
  };
}

function splitSegmentIntoSentences(segment) {
  return segment
    .split(/(?<=[.!?])\s+/)
    .map((entry) => normalizeWhitespace(entry))
    .filter((entry) => entry !== '');
}

/**
 * Split a slide script into structured presenter lines.
 *
 * Spoken lines carry render tokens plus a `spokenText` string used by the
 * matcher. Stage notes, pause gaps, and mode labels render but do not consume
 * the follow cursor because their `spokenText` is empty.
 *
 * @param {string | null | undefined} text Slide script text.
 * @returns {Array<{ tokens: Array<{ kind: string, text?: string }>, spokenText: string, paragraphIndex: number, mode?: string }>}
 */
export function splitScript(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [];
  }

  const lines = [];
  let paragraphIndex = 0;
  let currentMode = null;
  let hasSpokenContent = false;

  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();

    if (trimmed === '') {
      paragraphIndex += hasSpokenContent ? 1 : 0;
      hasSpokenContent = false;
      lines.push(createMetaLine('gap', null, paragraphIndex, currentMode));
      continue;
    }

    const modeMatch = /^\[mode:([^\]]+)\]$/i.exec(trimmed);
    if (modeMatch !== null) {
      paragraphIndex += hasSpokenContent ? 1 : 0;
      const nextMode = normalizeWhitespace(modeMatch[1]).toUpperCase();

      // An empty mode name must not clear or blank the active mode.
      if (nextMode !== '') {
        currentMode = nextMode;
      }

      hasSpokenContent = false;
      lines.push(createMetaLine('mode', nextMode, paragraphIndex, currentMode));
      continue;
    }

    const stageMatch = /^\[stage:([^\]]+)\]$/i.exec(trimmed);
    if (stageMatch !== null) {
      lines.push(createMetaLine('stage', normalizeWhitespace(stageMatch[1]), paragraphIndex, currentMode));
      continue;
    }

    // Command text is typed verbatim (flags, paths, double spaces), so only the
    // edges are trimmed; no whitespace collapsing and no sentence splitting.
    const commandMatch = /^\[cmd:([^\]]+)\]$/i.exec(trimmed);
    if (commandMatch !== null) {
      lines.push(createMetaLine('command', commandMatch[1].trim(), paragraphIndex, currentMode));
      continue;
    }

    for (const sentence of splitSegmentIntoSentences(trimmed)) {
      lines.push(createSpokenLine(sentence, paragraphIndex, currentMode));
      hasSpokenContent = true;
    }
  }

  return lines;
}
