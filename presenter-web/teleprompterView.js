const STATUS_HIDE_DELAY_MS = 4000;
const TELEPROMPTER_TOP_BAND_RATIO = 0.12;
const TELEPROMPTER_LOOKAHEAD_LINES = 2;

function hasSpokenText(line) {
  return typeof line?.spokenText === 'string' && line.spokenText.trim() !== '';
}

function listSpokenLineIndices(lines) {
  return lines
    .map((line, index) => (hasSpokenText(line) ? index : null))
    .filter((index) => index !== null);
}

function getSpokenLineOrdinal(lines, activeLineIndex) {
  const spokenIndices = listSpokenLineIndices(lines);

  if (spokenIndices.length === 0) {
    return { ordinal: 0, spokenIndices: [] };
  }

  const ordinal = Math.max(0, spokenIndices.indexOf(activeLineIndex));
  return {
    ordinal,
    spokenIndices,
  };
}

function countSpokenLines(lines) {
  return lines.filter((line) => typeof line?.spokenText === 'string' && line.spokenText.trim() !== '').length;
}

function countSpokenLinesBefore(lines, activeLineIndex) {
  let count = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (index >= activeLineIndex) {
      break;
    }

    if (typeof lines[index]?.spokenText === 'string' && lines[index].spokenText.trim() !== '') {
      count += 1;
    }
  }

  return count;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildUniformLineMetrics(lineCount, lineHeight, lineGap) {
  const safeLineGap = Number.isFinite(lineGap) && lineGap > 0 ? lineGap : 0;
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 0;
  const lineStep = safeLineHeight + safeLineGap;

  return Array.from({ length: Math.max(0, lineCount) }, (_, index) => {
    const top = index * lineStep;
    return {
      top,
      height: safeLineHeight,
      bottom: top + safeLineHeight,
    };
  });
}

function normalizeLineMetric(metric) {
  if (metric === null || typeof metric !== 'object' || !Number.isFinite(metric.top)) {
    return null;
  }

  const top = metric.top;
  const height = Number.isFinite(metric.height)
    ? metric.height
    : Number.isFinite(metric.bottom)
      ? metric.bottom - top
      : NaN;
  const bottom = Number.isFinite(metric.bottom) ? metric.bottom : top + height;

  if (!Number.isFinite(height) || height < 0 || !Number.isFinite(bottom) || bottom < top) {
    return null;
  }

  return { top, height, bottom };
}

function resolveLineMetrics({ lineCount, lineHeight, lineGap, lineMetrics }) {
  if (!Array.isArray(lineMetrics) || lineMetrics.length !== lineCount) {
    return buildUniformLineMetrics(lineCount, lineHeight, lineGap);
  }

  const normalizedLineMetrics = lineMetrics.map((metric) => normalizeLineMetric(metric));

  if (normalizedLineMetrics.some((metric) => metric === null)) {
    return buildUniformLineMetrics(lineCount, lineHeight, lineGap);
  }

  return normalizedLineMetrics;
}

/**
 * Assign visual tiers relative to the active line.
 *
 * Only two tiers remain: lines before the active line are `past` (rendered
 * dimmed); the active line and everything after is `future` (normal text). The
 * active line is intentionally not distinguished, so a slightly-lagged match
 * cannot produce a confidently-wrong "you are here" cue — the scrolled position
 * carries that signal instead, and the gray-out only marks what's been passed.
 *
 * @param {Array<unknown>} lines Presenter lines.
 * @param {number} activeLineIndex Active line index.
 * @returns {Array<'past' | 'future'>}
 */
export function assignLineTiers(lines, activeLineIndex) {
  return lines.map((_, index) => (index < activeLineIndex ? 'past' : 'future'));
}

/**
 * Compute the transform offset that keeps the recent line in a stable top band
 * while preserving upcoming lines whenever the viewport allows it.
 *
 * @param {{ activeLineIndex: number, lineHeight: number, lineGap: number, lineMetrics?: Array<{ top: number, height?: number, bottom?: number }>, viewportHeight: number, lineCount?: number, lines?: Array<{ spokenText?: string }> }} input Layout measurements.
 * @returns {number}
 */
export function computeTeleprompterOffset({ activeLineIndex, lineHeight, lineGap, lineMetrics, lines, viewportHeight, lineCount }) {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0 || !Number.isFinite(lineHeight) || lineHeight <= 0) {
    return 0;
  }

  const resolvedLines = Array.isArray(lines) ? lines : Array.from({ length: Math.max(0, lineCount ?? 0) }, () => ({ spokenText: 'line' }));
  const safeLineCount = resolvedLines.length;

  if (safeLineCount === 0) {
    return 0;
  }

  const safeActiveLineIndex = Math.min(safeLineCount - 1, Math.max(0, Math.floor(activeLineIndex)));
  const resolvedLineMetrics = resolveLineMetrics({
    lineCount: safeLineCount,
    lineHeight,
    lineGap,
    lineMetrics,
  });

  const { ordinal, spokenIndices } = getSpokenLineOrdinal(resolvedLines, safeActiveLineIndex);
  const anchorLineIndex = spokenIndices[Math.max(0, ordinal - 1)] ?? safeActiveLineIndex;
  const anchorMetric = resolvedLineMetrics[anchorLineIndex] ?? resolvedLineMetrics[safeActiveLineIndex];
  const currentMetric = resolvedLineMetrics[safeActiveLineIndex] ?? anchorMetric;
  const desiredOffset = (viewportHeight * TELEPROMPTER_TOP_BAND_RATIO) - anchorMetric.top;
  const minOffset = -currentMetric.top;

  for (let lookahead = TELEPROMPTER_LOOKAHEAD_LINES; lookahead >= 0; lookahead -= 1) {
    const targetLineIndex = spokenIndices[Math.min(spokenIndices.length - 1, ordinal + lookahead)] ?? safeActiveLineIndex;
    const targetMetric = resolvedLineMetrics[targetLineIndex] ?? currentMetric;

    if (targetMetric === undefined) {
      continue;
    }

    const maxOffset = viewportHeight - targetMetric.bottom;

    if (maxOffset >= minOffset) {
      return Math.round(clamp(desiredOffset, minOffset, maxOffset));
    }
  }

  return Math.round(minOffset);
}

export function buildTrackingStatusView({
  hidden = false,
  hovered = false,
  lastStateChangeAtMs = 0,
  nowMs,
  trackingState,
}) {
  const tone = trackingState === 'listening'
    ? 'green'
    : trackingState === 'offScript'
      ? 'yellow'
      : trackingState === 'lost'
        ? 'red'
        : 'muted';

  if (hidden) {
    return { label: 'Hidden', tone: 'muted', visible: true };
  }

  const visible = hovered
    || trackingState !== 'listening'
    || (typeof nowMs === 'number' && (nowMs - lastStateChangeAtMs) < STATUS_HIDE_DELAY_MS);

  return {
    label: trackingState,
    tone,
    visible,
  };
}

export function buildTokenRenderParts(tokens) {
  return tokens.map((token) => ({
    className: `token token-${token.kind}`,
    text: token.text ?? (token.kind === 'pause' ? '...' : ''),
  }));
}

export function buildProgressPercent(lines, activeLineIndex) {
  const spokenLineCount = countSpokenLines(lines);

  if (spokenLineCount <= 1) {
    return 0;
  }

  const spokenBefore = countSpokenLinesBefore(lines, activeLineIndex);
  return Math.max(0, Math.min(1, spokenBefore / (spokenLineCount - 1)));
}

/**
 * Decide whether the next render must jump without animating. The teleprompter
 * snaps (no transition) whenever the visible slide changes, so a previously deep
 * scroll never animates into the new top band, and whenever a slide appears
 * after being hidden or absent. Ordinary line tracking on the same slide still
 * animates.
 *
 * @param {{ prevSeq: number | null, nextSeq: number | null, prevVisible: boolean, nextVisible: boolean }} input
 * @returns {boolean}
 */
export function shouldRenderImmediately({ prevSeq, nextSeq, prevVisible, nextVisible }) {
  if (!nextVisible) {
    return false;
  }

  if (!prevVisible) {
    return true;
  }

  return prevSeq !== nextSeq;
}

export function buildTeleprompterFrame(presenterState, {
  hovered = false,
  lastStateChangeAtMs = 0,
  lineHeight,
  lineGap,
  lineMetrics,
  nowMs,
  viewportHeight,
}) {
  if (presenterState === null || presenterState.current.hidden) {
    return {
      hidden: true,
      offsetPx: 0,
      progressPercent: 0,
      status: buildTrackingStatusView({
        hidden: presenterState?.current.hidden === true,
        hovered,
        lastStateChangeAtMs,
        nowMs,
        trackingState: presenterState?.teleprompter?.trackingState ?? 'idle',
      }),
      tiers: [],
    };
  }

  const activeLineIndex = presenterState.teleprompter.activeLineIndex;

  return {
    hidden: false,
    offsetPx: computeTeleprompterOffset({
      activeLineIndex,
      lineCount: presenterState.current.lines.length,
      lineHeight,
      lineGap,
      lineMetrics,
      lines: presenterState.current.lines,
      viewportHeight,
    }),
    progressPercent: buildProgressPercent(presenterState.current.lines, activeLineIndex),
    status: buildTrackingStatusView({
      hidden: false,
      hovered,
      lastStateChangeAtMs,
      nowMs,
      trackingState: presenterState.teleprompter.trackingState,
    }),
    tiers: assignLineTiers(presenterState.current.lines, activeLineIndex),
  };
}

export function reconcileLineNodes({ nodes, lines, createNode, appendNode, removeNode, renderNode }) {
  const nextNodes = [...nodes];

  while (nextNodes.length > lines.length) {
    removeNode(nextNodes.pop());
  }

  for (let index = nextNodes.length; index < lines.length; index += 1) {
    const node = createNode();
    appendNode(node);
    nextNodes.push(node);
  }

  for (let index = 0; index < lines.length; index += 1) {
    renderNode(nextNodes[index], lines[index], index);
  }

  return nextNodes;
}

export function buildProgramPreviewUrl(path, revision) {
  if (typeof path !== 'string' || path.trim() === '') {
    return null;
  }

  const normalizedPath = path.trim();
  return Number.isInteger(revision)
    ? `${normalizedPath}?rev=${revision}`
    : normalizedPath;
}

// One rendered teleprompter line step is 36px min-height + 8px margin, so the
// wheel threshold mirrors it: crossing it should feel like one ArrowDown press.
const WHEEL_NUDGE_THRESHOLD_PX = 44;
// Trackpad momentum tails keep delivering small deltas long after the gesture;
// anything arriving after this gap is a new gesture, so stale remainder must
// not turn it into an unwanted extra nudge.
const WHEEL_IDLE_RESET_MS = 250;

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Normalize a vertical wheel delta to pixels for the nudge accumulator.
 *
 * Browsers on macOS Chrome send pixel mode, but line/page modes exist in the
 * wild; without scaling them a line-mode event would be misread as a fraction
 * of a line. The API is intentionally single-axis: horizontal deltaX never
 * reaches this helper and never drives a nudge.
 *
 * @param {{ deltaY: number, deltaMode?: number, viewportHeightPx?: number }} event Wheel event fields.
 * @returns {number} Delta in pixels (0 for non-finite input).
 */
export function normalizeWheelDelta({ deltaY, deltaMode = DOM_DELTA_PIXEL, viewportHeightPx = 0 }) {
  if (!Number.isFinite(deltaY)) {
    return 0;
  }

  if (deltaMode === DOM_DELTA_LINE) {
    return deltaY * WHEEL_NUDGE_THRESHOLD_PX;
  }

  if (deltaMode === DOM_DELTA_PAGE) {
    const viewportHeightPxSafe = Number.isFinite(viewportHeightPx) ? viewportHeightPx : 0;
    return deltaY * viewportHeightPxSafe;
  }

  return deltaY;
}

/**
 * Accumulate wheel deltas and translate them into teleprompter nudge counts.
 *
 * Raw trackpad gestures fire dozens of events per flick, so deltas are summed
 * and only every threshold crossing becomes a nudge, with the remainder
 * carried over — otherwise one gesture would advance several lines. The
 * remainder is dropped when events stop arriving for the idle window, so a
 * momentum tail cannot trigger a late nudge. Time is injected (`nowMs`) so
 * reset semantics are testable without timers.
 *
 * @param {{ thresholdPx?: number, idleResetMs?: number }} [options] Overrides for tests.
 * @returns {{ push(input: { deltaY: number, nowMs: number }): number, reset(): void }}
 *   `push` returns the signed number of line-steps crossed (positive = scroll
 *   down = nudge forward, 0 = nothing to send); `reset` clears any pending
 *   remainder.
 */
export function createWheelNudgeAccumulator({ thresholdPx = WHEEL_NUDGE_THRESHOLD_PX, idleResetMs = WHEEL_IDLE_RESET_MS } = {}) {
  let remainderPx = 0;
  let lastEventAtMs = null;

  return {
    push({ deltaY, nowMs }) {
      if (!Number.isFinite(deltaY) || !Number.isFinite(nowMs)) {
        return 0;
      }

      if (lastEventAtMs !== null && nowMs - lastEventAtMs >= idleResetMs) {
        remainderPx = 0;
      }
      lastEventAtMs = nowMs;

      remainderPx += deltaY;
      const nudges = Math.trunc(remainderPx / thresholdPx);
      remainderPx -= nudges * thresholdPx;
      return nudges;
    },
    reset() {
      remainderPx = 0;
      lastEventAtMs = null;
    },
  };
}
