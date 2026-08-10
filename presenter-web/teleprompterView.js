const STATUS_HIDE_DELAY_MS = 4000;

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

export function assignLineTiers(lines, activeLineIndex) {
  return lines.map((_, index) => {
    if (index < activeLineIndex) {
      return 'past';
    }

    if (index === activeLineIndex) {
      return 'current';
    }

    if (index <= activeLineIndex + 1) {
      return 'near';
    }

    return 'future';
  });
}

export function computeTeleprompterOffset({ activeLineTop, activeLineHeight, viewportHeight, anchorRatio }) {
  const activeCenter = activeLineTop + (activeLineHeight / 2);
  const anchorCenter = viewportHeight * anchorRatio;
  return Math.round(anchorCenter - activeCenter);
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

export function buildTeleprompterFrame(presenterState, {
  hovered = false,
  lastStateChangeAtMs = 0,
  lineHeight,
  lineGap,
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

  const activeLineTop = presenterState.teleprompter.activeLineIndex * (lineHeight + lineGap);

  return {
    hidden: false,
    offsetPx: computeTeleprompterOffset({
      activeLineTop,
      activeLineHeight: lineHeight,
      viewportHeight,
      anchorRatio: 0.3,
    }),
    progressPercent: buildProgressPercent(presenterState.current.lines, presenterState.teleprompter.activeLineIndex),
    status: buildTrackingStatusView({
      hidden: false,
      hovered,
      lastStateChangeAtMs,
      nowMs,
      trackingState: presenterState.teleprompter.trackingState,
    }),
    tiers: assignLineTiers(presenterState.current.lines, presenterState.teleprompter.activeLineIndex),
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
