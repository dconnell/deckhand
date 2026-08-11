function normalizeCaptureId(captureId) {
  if (typeof captureId === 'number' && Number.isInteger(captureId)) {
    return String(captureId);
  }

  const value = String(captureId ?? '').trim();
  const match = /^:?(-?\d+)$/.exec(value);

  if (match === null) {
    throw new TypeError('whisper-stream captureId must be an integer device id or :<id>');
  }

  return match[1];
}

function normalizeSeconds(value, fieldName) {
  const milliseconds = Math.round(Number(value) * 1000);

  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new TypeError(`${fieldName} must be a positive number`);
  }

  return milliseconds;
}

function normalizePositiveMilliseconds(value, fieldName) {
  const milliseconds = Math.round(Number(value));

  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new TypeError(`${fieldName} must be a positive number`);
  }

  return milliseconds;
}

function normalizeNonNegativeMilliseconds(value, fieldName) {
  const milliseconds = Math.round(Number(value));

  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError(`${fieldName} must be a non-negative number`);
  }

  return milliseconds;
}

function normalizeInteger(value, fieldName) {
  const normalized = Math.round(Number(value));

  if (!Number.isFinite(normalized)) {
    throw new TypeError(`${fieldName} must be a number`);
  }

  return normalized;
}

/**
 * Build whisper-stream CLI args for a persistent microphone capture session.
 *
 * @param {{ audioCtx?: number, beamSize?: number, captureId?: number | string, chunkSeconds?: number, flashAttn?: boolean, freqThreshold?: number, keepContext?: boolean, keepMs?: number, language?: string, lengthMs?: number, mode?: 'step' | 'vad', model: string, noFallback?: boolean, stepMs?: number, threads?: number, useGpu?: boolean, vadThreshold?: number }} options Whisper options.
 * @returns {string[]}
 */
export function buildWhisperArgs(options) {
  const mode = options.mode ?? 'step';
  const args = [
    '-m', options.model,
  ];

  if (options.captureId !== undefined) {
    args.push('--capture', normalizeCaptureId(options.captureId));
  }

  if (mode === 'vad') {
    const lengthMs = options.lengthMs !== undefined
      ? normalizePositiveMilliseconds(options.lengthMs, 'lengthMs')
      : normalizeSeconds(options.chunkSeconds ?? 30, 'chunkSeconds');
    args.push('--step', '0');
    args.push('--length', String(lengthMs));

    if (options.vadThreshold !== undefined) {
      args.push('-vth', String(options.vadThreshold));
    }

    if (options.freqThreshold !== undefined) {
      args.push('-fth', String(options.freqThreshold));
    }
  } else {
    const stepMs = options.stepMs !== undefined
      ? normalizePositiveMilliseconds(options.stepMs, 'stepMs')
      : normalizeSeconds(options.chunkSeconds, 'chunkSeconds');
    const lengthMs = options.lengthMs !== undefined
      ? normalizePositiveMilliseconds(options.lengthMs, 'lengthMs')
      : stepMs;

    args.push('--step', String(stepMs));
    args.push('--length', String(lengthMs));

    if (options.keepMs !== undefined) {
      args.push('--keep', String(normalizeNonNegativeMilliseconds(options.keepMs, 'keepMs')));
    }
  }

  if (typeof options.language === 'string' && options.language.trim() !== '') {
    args.push('-l', options.language.trim());
  }

  if (options.threads !== undefined) {
    args.push('-t', String(options.threads));
  }

  if (options.audioCtx !== undefined) {
    args.push('--audio-ctx', String(normalizeInteger(options.audioCtx, 'audioCtx')));
  }

  if (options.beamSize !== undefined) {
    args.push('--beam-size', String(normalizeInteger(options.beamSize, 'beamSize')));
  }

  if (options.keepContext === true) {
    args.push('--keep-context');
  }

  if (options.noFallback === true) {
    args.push('--no-fallback');
  }

  if (options.useGpu === false) {
    args.push('--no-gpu');
  }

  if (options.flashAttn === true) {
    args.push('--flash-attn');
  }

  if (options.flashAttn === false) {
    args.push('--no-flash-attn');
  }

  return args;
}
