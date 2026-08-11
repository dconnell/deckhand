const ANSI_CLEAR_LINE_PATTERN = /\u001b\[[0-9;]*K/g;
const TIMESTAMP_PREFIX_PATTERN = /^\[[^\]]+\]\s*/;

function normalizeTranscriptText(value) {
  return String(value ?? '')
    .replace(ANSI_CLEAR_LINE_PATTERN, '')
    .replace(TIMESTAMP_PREFIX_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoiseLine(line) {
  return line === ''
    || line === '[Start speaking]'
    || line.startsWith('whisper_')
    || line.startsWith('main: ')
    || line.startsWith('### Transcription');
}

function isTranscriptionStartLine(line) {
  return /^### Transcription\b.*\bSTART(?:\b|\s|$)/.test(line);
}

function isTranscriptionEndLine(line) {
  return /^### Transcription\b.*\bEND(?:\b|\s|$)/.test(line);
}

function createStepParser(nowFn) {
  let buffer = '';
  let lastEmitted = '';

  function createEvent(text) {
    return {
      kind: 'partial',
      observedAtMs: nowFn(),
      text,
    };
  }

  function emitFromSegments(segments, { includeTrailing = false } = {}) {
    const events = [];
    const limit = includeTrailing ? segments.length : Math.max(0, segments.length - 1);

    for (let index = 0; index < limit; index += 1) {
      const text = normalizeTranscriptText(segments[index]);

      if (isNoiseLine(text) || text === lastEmitted) {
        continue;
      }

      lastEmitted = text;
      events.push(createEvent(text));
    }

    return events;
  }

  return {
    flush() {
      const events = emitFromSegments(buffer.split(/\r|\n/), { includeTrailing: true });
      buffer = '';
      return events;
    },
    push(chunk) {
      buffer += String(chunk ?? '');
      const segments = buffer.split(/\r|\n/);
      const events = emitFromSegments(segments);
      buffer = segments.at(-1) ?? '';
      return events;
    },
  };
}

function createVadParser(nowFn) {
  let buffer = '';
  let currentLines = [];
  let inBlock = false;
  let lastEmitted = '';

  function maybeEmitCurrentBlock() {
    if (!inBlock) {
      return [];
    }

    const text = currentLines
      .map((line) => normalizeTranscriptText(line))
      .filter((line) => !isNoiseLine(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    currentLines = [];
    inBlock = false;

    if (text === '' || text === lastEmitted) {
      return [];
    }

    lastEmitted = text;
    return [{
      kind: 'segment',
      observedAtMs: nowFn(),
      text,
    }];
  }

  return {
    flush() {
      const lines = buffer.split(/\r?\n/);
      buffer = '';
      const events = [];

      for (const rawLine of lines) {
        const line = rawLine.trim();

        if (line === '') {
          continue;
        }

        if (isTranscriptionStartLine(line)) {
          inBlock = true;
          currentLines = [];
          continue;
        }

        if (isTranscriptionEndLine(line)) {
          events.push(...maybeEmitCurrentBlock());
          continue;
        }

        if (inBlock) {
          currentLines.push(line);
        }
      }

      return events;
    },
    push(chunk) {
      buffer += String(chunk ?? '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      const events = [];

      for (const rawLine of lines) {
        const line = rawLine.trim();

        if (line === '') {
          continue;
        }

        if (isTranscriptionStartLine(line)) {
          inBlock = true;
          currentLines = [];
          continue;
        }

        if (isTranscriptionEndLine(line)) {
          events.push(...maybeEmitCurrentBlock());
          continue;
        }

        if (inBlock) {
          currentLines.push(line);
        }
      }

      return events;
    },
  };
}

/**
 * Create an incremental whisper-stream output parser.
 *
 * @param {{ mode?: 'step' | 'vad', nowFn?: () => number }} [options] Parser options.
 * @returns {{ push(chunk: string): Array<{ kind: 'partial' | 'segment', observedAtMs: number, text: string }>, flush(): Array<{ kind: 'partial' | 'segment', observedAtMs: number, text: string }> }}
 */
export function createWhisperOutputParser(options = {}) {
  const nowFn = options.nowFn ?? Date.now;

  return (options.mode ?? 'step') === 'vad'
    ? createVadParser(nowFn)
    : createStepParser(nowFn);
}
