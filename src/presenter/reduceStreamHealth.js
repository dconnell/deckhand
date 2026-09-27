import { isPlainObject } from '../lib/guards.js';

const WARNING_VALUES = new Set([
  'disconnected',
  'reconnecting',
  'droppedFrames',
  'bitrateCollapse',
]);

const ACTIVE_KEYS = ['outputActive', 'active'];
const RECONNECTING_KEYS = ['outputReconnecting', 'reconnecting'];
const BITRATE_KEYS = ['bitrateKbps', 'outputBitrateKbps', 'kbitsPerSec'];
const BYTES_KEYS = ['outputBytes', 'bytes'];
const DURATION_KEYS = ['outputDuration', 'durationMs'];
const DROPPED_FRAMES_KEYS = ['outputSkippedFrames', 'droppedFrames', 'numDroppedFrames'];
const TOTAL_FRAMES_KEYS = ['outputTotalFrames', 'totalFrames', 'numTotalFrames'];
const CONGESTION_KEYS = ['outputCongestion', 'congestion'];
const LAST_UPDATE_KEYS = ['lastUpdateMs', 'updatedAtMs'];

const DROPPED_FRAMES_MIN_DELTA = 10;
const DROPPED_FRAMES_MIN_RATIO = 0.03;
const BITRATE_COLLAPSE_MAX_RATIO = 0.25;
const BITRATE_COLLAPSE_MAX_KBPS = 500;

function readBoolean(value, keys) {
  if (!isPlainObject(value)) {
    return null;
  }

  for (const key of keys) {
    if (typeof value[key] === 'boolean') {
      return value[key];
    }
  }

  return null;
}

function readNumber(value, keys) {
  if (!isPlainObject(value)) {
    return null;
  }

  for (const key of keys) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) {
      return value[key];
    }
  }

  return null;
}

function normalizeInteger(value, fallback = null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizeCongestion(value, fallback = null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  const percent = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function hasRecognizedField(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  return [
    ...ACTIVE_KEYS,
    ...RECONNECTING_KEYS,
    ...BITRATE_KEYS,
    ...BYTES_KEYS,
    ...DURATION_KEYS,
    ...DROPPED_FRAMES_KEYS,
    ...TOTAL_FRAMES_KEYS,
    ...CONGESTION_KEYS,
    ...LAST_UPDATE_KEYS,
  ].some((key) => value[key] !== undefined);
}

function createBaseSummary(previousSummary) {
  return {
    active: readBoolean(previousSummary, ACTIVE_KEYS) ?? false,
    reconnecting: readBoolean(previousSummary, RECONNECTING_KEYS) ?? false,
    bitrateKbps: normalizeInteger(readNumber(previousSummary, BITRATE_KEYS)),
    droppedFrames: normalizeInteger(readNumber(previousSummary, DROPPED_FRAMES_KEYS), 0),
    congestion: normalizeCongestion(readNumber(previousSummary, CONGESTION_KEYS)),
    lastUpdateMs: normalizeInteger(readNumber(previousSummary, LAST_UPDATE_KEYS)),
    warning: WARNING_VALUES.has(previousSummary?.warning) ? previousSummary.warning : null,
  };
}

function computeCounterBitrateKbps(currentStatus, previousStatus = null) {
  const currentBytes = readNumber(currentStatus, BYTES_KEYS);
  const currentDuration = readNumber(currentStatus, DURATION_KEYS);

  if (currentBytes === null || currentDuration === null || currentDuration <= 0) {
    return null;
  }

  if (isPlainObject(previousStatus)) {
    const previousBytes = readNumber(previousStatus, BYTES_KEYS);
    const previousDuration = readNumber(previousStatus, DURATION_KEYS);

    if (previousBytes !== null
      && previousDuration !== null
      && currentBytes >= previousBytes
      && currentDuration > previousDuration) {
      return normalizeInteger(((currentBytes - previousBytes) * 8) / (currentDuration - previousDuration));
    }
  }

  return normalizeInteger((currentBytes * 8) / currentDuration);
}

function computeBitrateKbps(currentStatus, previousStatus, previousSummary) {
  const candidates = [];
  const directBitrate = normalizeInteger(readNumber(currentStatus, BITRATE_KEYS));
  const intervalBitrate = computeCounterBitrateKbps(currentStatus, previousStatus);
  const lifetimeBitrate = computeCounterBitrateKbps(currentStatus);

  if (directBitrate !== null) {
    candidates.push(directBitrate);
  }

  if (intervalBitrate !== null) {
    candidates.push(intervalBitrate);
  }

  if (lifetimeBitrate !== null) {
    candidates.push(lifetimeBitrate);
  }

  if (candidates.length === 0) {
    return previousSummary.bitrateKbps;
  }

  return Math.min(...candidates);
}

function shouldWarnDroppedFrames(currentStatus, previousStatus) {
  if (!isPlainObject(previousStatus)) {
    return false;
  }

  const currentDroppedFrames = readNumber(currentStatus, DROPPED_FRAMES_KEYS);
  const currentTotalFrames = readNumber(currentStatus, TOTAL_FRAMES_KEYS);
  const previousDroppedFrames = readNumber(previousStatus, DROPPED_FRAMES_KEYS);
  const previousTotalFrames = readNumber(previousStatus, TOTAL_FRAMES_KEYS);

  if (currentDroppedFrames === null
    || currentTotalFrames === null
    || previousDroppedFrames === null
    || previousTotalFrames === null) {
    return false;
  }

  const droppedFrameDelta = currentDroppedFrames - previousDroppedFrames;
  const totalFrameDelta = currentTotalFrames - previousTotalFrames;

  if (droppedFrameDelta < DROPPED_FRAMES_MIN_DELTA || totalFrameDelta <= 0) {
    return false;
  }

  return (droppedFrameDelta / totalFrameDelta) >= DROPPED_FRAMES_MIN_RATIO;
}

function shouldWarnBitrateCollapse(currentBitrateKbps, previousStatus, previousSummary) {
  if (currentBitrateKbps === null) {
    return false;
  }

  const baselineBitrateKbps = previousSummary.bitrateKbps ?? computeCounterBitrateKbps(previousStatus);

  if (baselineBitrateKbps === null || baselineBitrateKbps <= 0) {
    return false;
  }

  return currentBitrateKbps <= BITRATE_COLLAPSE_MAX_KBPS
    && currentBitrateKbps <= Math.floor(baselineBitrateKbps * BITRATE_COLLAPSE_MAX_RATIO);
}

/**
 * Reduce raw OBS stream telemetry into a small presenter-facing summary.
 *
 * The helper accepts OBS v5 `GetStreamStatus` fields and a few normalized aliases
 * so callers can pass raw samples or partially normalized equivalents. Sparse
 * samples carry forward prior values instead of fabricating non-conservative
 * warnings.
 *
 * @param {Record<string, unknown> | null | undefined} status Raw OBS status sample.
 * @param {{ previousStatus?: Record<string, unknown> | null, previousSummary?: { active?: boolean, reconnecting?: boolean, bitrateKbps?: number | null, droppedFrames?: number, congestion?: number | null, lastUpdateMs?: number | null, warning?: string | null } | null, nowMs?: number }} [options] Previous samples used for interval calculations.
 * @returns {{ active: boolean, reconnecting: boolean, bitrateKbps: number | null, droppedFrames: number, congestion: number | null, lastUpdateMs: number | null, warning: 'disconnected' | 'reconnecting' | 'droppedFrames' | 'bitrateCollapse' | null }}
 */
export function reduceStreamHealth(status, options = {}) {
  const previousSummary = createBaseSummary(options.previousSummary ?? null);

  if (!hasRecognizedField(status)) {
    return { ...previousSummary };
  }

  const explicitActive = readBoolean(status, ACTIVE_KEYS);
  const explicitReconnecting = readBoolean(status, RECONNECTING_KEYS);
  const active = explicitActive ?? previousSummary.active;
  const reconnecting = explicitReconnecting ?? (explicitActive === false ? false : previousSummary.reconnecting);
  const lastUpdateMs = normalizeInteger(readNumber(status, LAST_UPDATE_KEYS))
    ?? normalizeInteger(options.nowMs)
    ?? previousSummary.lastUpdateMs;

  if (active === false && reconnecting === false) {
    return {
      active: false,
      reconnecting: false,
      bitrateKbps: null,
      droppedFrames: normalizeInteger(readNumber(status, DROPPED_FRAMES_KEYS), 0),
      congestion: null,
      lastUpdateMs,
      warning: 'disconnected',
    };
  }

  const bitrateKbps = computeBitrateKbps(status, options.previousStatus ?? null, previousSummary);
  const droppedFrames = normalizeInteger(readNumber(status, DROPPED_FRAMES_KEYS), previousSummary.droppedFrames);
  const congestion = normalizeCongestion(readNumber(status, CONGESTION_KEYS), previousSummary.congestion);

  let warning = null;
  if (reconnecting) {
    warning = 'reconnecting';
  } else if (shouldWarnDroppedFrames(status, options.previousStatus ?? null)) {
    warning = 'droppedFrames';
  } else if (shouldWarnBitrateCollapse(bitrateKbps, options.previousStatus ?? null, previousSummary)) {
    warning = 'bitrateCollapse';
  }

  return {
    active,
    reconnecting,
    bitrateKbps,
    droppedFrames,
    congestion,
    lastUpdateMs,
    warning,
  };
}
