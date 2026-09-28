import { createPredictor } from './createPredictor.js';
import { PROGRAM_PREVIEW_PATH } from './constants.js';
import { matchLineDetailed } from './matchLine.js';
import {
  clampToSpokenLine,
  findFirstSpokenLine,
  findParagraphJumpTarget,
  moveBySpokenLines,
} from './navigation.js';
import { splitScript } from './splitScript.js';

const DEFAULT_RECENT_TRANSCRIPT_LIMIT = 10;
// Shrink the matcher input to the latest transcript event so stale words from
// earlier chunks cannot contaminate scoring. The recent-transcript limit above
// is intentionally larger: off-script recovery still wants the fuller history.
const DEFAULT_TRANSCRIPT_MATCH_ITEM_WINDOW = 1;
const DEFAULT_TRANSCRIPT_MATCH_WORD_WINDOW = 20;
// When the speaker is off-script or lost, widen the matcher: accept a lower
// confidence and look further ahead so a distinctive line snaps follow back.
const OFF_SCRIPT_RECOVERY_THRESHOLD = 0.25;
const OFF_SCRIPT_RECOVERY_FAR_MULTIPLIER = 3;
const DEFAULT_TRACKING = {
  farJumpLines: 8,
  lostMs: 8000,
  minConfidence: 0.35,
  offScriptMs: 3000,
};

function createInitialPreviewState() {
  return {
    available: false,
    path: PROGRAM_PREVIEW_PATH,
    revision: 0,
    capturedAtMs: null,
    stale: true,
  };
}

function createInitialStreamState() {
  return {
    active: false,
    reconnecting: false,
    bitrateKbps: null,
    droppedFrames: 0,
    congestion: null,
    lastUpdateMs: null,
    warning: 'disconnected',
  };
}

function createInitialTimerState() {
  return {
    running: false,
    elapsedMs: 0,
    remainingMs: null,
    targetDurationMs: null,
  };
}

function createInitialTeleprompterState(followEnabledByDefault) {
  return {
    followEnabled: followEnabledByDefault,
    activeLineIndex: 0,
    trackingState: 'idle',
    recentTranscript: [],
  };
}

function createInitialCurrentState() {
  return {
    slideId: null,
    layoutId: null,
    focus: null,
    hidden: false,
    lines: [],
    script: null,
  };
}

// The preview/stream slices are flat scalar records by construction. If a
// nested value is ever introduced, `Object.is` reports it as changed and the
// update commits — failing open toward publishing, never silently dropping one.
function isSameFlatState(a, b) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  return aKeys.every((key) => Object.is(a[key], b[key]));
}

function hasHiddenPresenterOverlay(presentationState) {
  return presentationState?.overlays?.some((overlay) => {
    return overlay?.source === 'Presenter' && overlay?.hidden === true;
  }) ?? false;
}

function deriveNextSlide(manifestSlides, slideId) {
  if (!Array.isArray(manifestSlides) || manifestSlides.length === 0 || typeof slideId !== 'string') {
    return null;
  }

  const currentIndex = manifestSlides.findIndex((entry) => entry.id === slideId);

  if (currentIndex === -1 || currentIndex + 1 >= manifestSlides.length) {
    return null;
  }

  const next = manifestSlides[currentIndex + 1];
  return {
    slideId: next.id,
    title: next.title ?? null,
    heading: next.heading ?? null,
    index: { ...next.index },
  };
}

function coerceActiveLine(lines, activeLineIndex) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return 0;
  }

  return clampToSpokenLine(lines, Math.max(0, Math.min(lines.length - 1, activeLineIndex)));
}

function buildTranscriptSearchText(items) {
  const words = items
    .slice(-DEFAULT_TRANSCRIPT_MATCH_ITEM_WINDOW)
    .flatMap((item) => String(item?.text ?? '').trim().split(/\s+/).filter(Boolean));

  return words.slice(-DEFAULT_TRANSCRIPT_MATCH_WORD_WINDOW).join(' ');
}

function isForwardMatch(match, activeLineIndex, minConfidence, farLimit) {
  return match.confidence >= minConfidence
    && (match.index - activeLineIndex) <= farLimit;
}

/**
 * Create the coordinator-owned presenter session reducer.
 *
 * @param {{ followEnabledByDefault: boolean, predictionLeadMs?: number, recentTranscriptLimit?: number, tracking?: { offScriptMs?: number, lostMs?: number, minConfidence?: number, farJumpLines?: number } }} options Presenter session options.
 * @returns {{ applyCommand(command: { op: string, source: string, delta?: number, lineIndex?: number }, nowMs?: number): boolean, applyPresentationState(presentationState: { seq: number, slideId: string, layoutId: string, focus?: string | null, script?: string | null, overlays?: Array<Record<string, unknown>> }, nowMs?: number): boolean, applySlideManifest(manifest: { slides: Array<{ id: string, index: { h: number, v: number }, title?: string, heading?: string }> }, nowMs?: number): boolean, applyTranscript(transcript: { source: string, text: string, capturedAtMs: number }, nowMs?: number): boolean, getState(): Record<string, unknown>, tick(nowMs?: number): boolean, updateObsPreview(preview: Partial<ReturnType<typeof createInitialPreviewState>>, nowMs?: number): boolean, updateStream(stream: Partial<ReturnType<typeof createInitialStreamState>>, nowMs?: number): boolean }}
 */
export function createPresenterSession(options) {
  const predictor = createPredictor({ alpha: 0.6, maxRate: 4, minRate: 0.25 });
  const predictionLeadMs = Number.isFinite(options.predictionLeadMs) && options.predictionLeadMs > 0
    ? options.predictionLeadMs
    : 0;
  const recentTranscriptLimit = options.recentTranscriptLimit ?? DEFAULT_RECENT_TRANSCRIPT_LIMIT;
  const tracking = {
    ...DEFAULT_TRACKING,
    ...(options.tracking ?? {}),
  };
  const state = {
    type: 'presenterState',
    seq: 0,
    presentationSeq: 0,
    current: createInitialCurrentState(),
    next: null,
    teleprompter: createInitialTeleprompterState(options.followEnabledByDefault),
    timer: createInitialTimerState(),
    obs: {
      preview: createInitialPreviewState(),
    },
    stream: createInitialStreamState(),
    updatedAtMs: 0,
  };
  const runtime = {
    ignoreTranscriptBeforeMs: -Infinity,
    lastEarlyAdvanceAtMs: null,
    lastObservedMatchAtMs: null,
    lastMatchedLineIndex: null,
    lastPredictionAnchorObservedAtMs: null,
    manifestSlides: [],
    timerStartedAtMs: null,
  };

  function commit(nowMs) {
    state.seq += 1;
    state.updatedAtMs = nowMs;
    state.next = deriveNextSlide(runtime.manifestSlides, state.current.slideId);
  }

  function resetTeleprompterPosition(targetIndex, nowMs) {
    state.teleprompter.activeLineIndex = coerceActiveLine(state.current.lines, targetIndex);
    state.teleprompter.recentTranscript = [];
    state.teleprompter.trackingState = 'idle';
    runtime.ignoreTranscriptBeforeMs = nowMs;
    runtime.lastEarlyAdvanceAtMs = null;
    runtime.lastObservedMatchAtMs = null;
    runtime.lastMatchedLineIndex = null;
    runtime.lastPredictionAnchorObservedAtMs = null;
    predictor.reset();
  }

  function updateTrackingState(nowMs) {
    if (!state.teleprompter.followEnabled || state.current.hidden || state.current.lines.length === 0) {
      state.teleprompter.trackingState = 'idle';
      return;
    }

    if (runtime.lastObservedMatchAtMs === null) {
      state.teleprompter.trackingState = 'idle';
      return;
    }

    const sinceLastMatch = Math.max(0, nowMs - runtime.lastObservedMatchAtMs);

    if (sinceLastMatch >= tracking.lostMs) {
      state.teleprompter.trackingState = 'lost';
      return;
    }

    if (sinceLastMatch >= tracking.offScriptMs) {
      state.teleprompter.trackingState = 'offScript';
      return;
    }

    state.teleprompter.trackingState = 'listening';
  }

  function projectActiveLine(nowMs) {
    if (!state.teleprompter.followEnabled
      || state.current.hidden
      || state.current.lines.length === 0
      || runtime.lastPredictionAnchorObservedAtMs === null
      || runtime.lastEarlyAdvanceAtMs !== null) {
      return false;
    }

    const predictionNow = predictionLeadMs > 0
      ? Math.min(nowMs, runtime.lastPredictionAnchorObservedAtMs + predictionLeadMs)
      : nowMs;
    const nextIndex = coerceActiveLine(
      state.current.lines,
      predictor.predict(Math.max(runtime.lastPredictionAnchorObservedAtMs, predictionNow), state.current.lines.length),
    );

    if (nextIndex === state.teleprompter.activeLineIndex) {
      return false;
    }

    state.teleprompter.activeLineIndex = nextIndex;
    return true;
  }

  function syncTimer(nowMs) {
    if (!state.timer.running || runtime.timerStartedAtMs === null) {
      return;
    }

    state.timer.elapsedMs = Math.max(0, nowMs - runtime.timerStartedAtMs);
    state.timer.remainingMs = state.timer.targetDurationMs === null
      ? null
      : Math.max(0, state.timer.targetDurationMs - state.timer.elapsedMs);
  }

  return {
    applyPresentationState(presentationState, nowMs = Date.now()) {
      const hidden = hasHiddenPresenterOverlay(presentationState);
      const lines = splitScript(presentationState.script);
      const current = state.current;
      const changed = current.slideId !== presentationState.slideId
        || current.layoutId !== presentationState.layoutId
        || hidden !== current.hidden
        || presentationState.script !== undefined && presentationState.script !== null && presentationState.script !== current.script;

      state.presentationSeq = presentationState.seq;
      state.current = {
        slideId: presentationState.slideId,
        layoutId: presentationState.layoutId,
        focus: presentationState.focus ?? null,
        hidden,
        lines,
        script: presentationState.script ?? null,
      };

      if (changed) {
        resetTeleprompterPosition(findFirstSpokenLine(lines), nowMs);
      } else {
        state.teleprompter.activeLineIndex = coerceActiveLine(lines, state.teleprompter.activeLineIndex);
      }

      updateTrackingState(nowMs);
      commit(nowMs);
      return true;
    },

    applySlideManifest(manifest, nowMs = Date.now()) {
      runtime.manifestSlides = Array.isArray(manifest?.slides)
        ? manifest.slides.map((entry) => ({
          id: entry.id,
          index: { ...entry.index },
          ...(entry.title === undefined ? {} : { title: entry.title }),
          ...(entry.heading === undefined ? {} : { heading: entry.heading }),
        }))
        : [];

      commit(nowMs);
      return true;
    },

    applyTranscript(transcript, nowMs = transcript?.capturedAtMs ?? Date.now()) {
      if (typeof transcript?.text !== 'string' || transcript.text.trim() === '') {
        return false;
      }

      if ((transcript.capturedAtMs ?? nowMs) <= runtime.ignoreTranscriptBeforeMs) {
        return false;
      }

      const previousTranscript = state.teleprompter.recentTranscript.at(-1);

      if (previousTranscript !== undefined
        && previousTranscript.source === transcript.source
        && previousTranscript.text === transcript.text
        && previousTranscript.capturedAtMs === transcript.capturedAtMs) {
        return false;
      }

      state.teleprompter.recentTranscript = [...state.teleprompter.recentTranscript, {
        source: transcript.source,
        text: transcript.text,
        capturedAtMs: transcript.capturedAtMs,
      }].slice(-recentTranscriptLimit);

      if (!state.teleprompter.followEnabled || state.current.hidden || state.current.lines.length === 0) {
        updateTrackingState(nowMs);
        commit(nowMs);
        return true;
      }

      const transcriptTail = buildTranscriptSearchText(state.teleprompter.recentTranscript);
      // Off-script/lost states widen the search: a lower threshold and a longer
      // forward reach (farJumpLines * 3) so a distinctive upcoming line can snap
      // follow back into sync. The trackingState here reflects the latest tick
      // or transcript, which is the state we want to recover from.
      const isOffScriptRecovery = state.teleprompter.trackingState === 'offScript'
        || state.teleprompter.trackingState === 'lost';
      const searchThreshold = isOffScriptRecovery ? OFF_SCRIPT_RECOVERY_THRESHOLD : tracking.minConfidence;
      const farLimit = isOffScriptRecovery
        ? tracking.farJumpLines * OFF_SCRIPT_RECOVERY_FAR_MULTIPLIER
        : tracking.farJumpLines;
      const matchOptions = { threshold: searchThreshold };

      if (isOffScriptRecovery) {
        matchOptions.maxIndex = state.teleprompter.activeLineIndex + farLimit;
      }

      const match = matchLineDetailed(
        transcriptTail,
        state.current.lines,
        state.teleprompter.activeLineIndex,
        matchOptions,
      );

      if (isForwardMatch(match, state.teleprompter.activeLineIndex, searchThreshold, farLimit)) {
        // Capture time preserves the speaker's actual pace, while `nowMs` records
        // when the reducer observed enough evidence to refresh follow state.
        if (runtime.lastMatchedLineIndex !== match.index || match.handoff === 'early') {
          if (match.handoff === 'early') {
            runtime.lastEarlyAdvanceAtMs = nowMs;
            predictor.reset();
          } else {
            runtime.lastEarlyAdvanceAtMs = null;
            predictor.onMatch(match.index, transcript.capturedAtMs ?? nowMs);
            runtime.lastPredictionAnchorObservedAtMs = nowMs;
            runtime.lastMatchedLineIndex = match.index;
          }
        }

        state.teleprompter.activeLineIndex = coerceActiveLine(state.current.lines, match.index);
        runtime.lastObservedMatchAtMs = nowMs;
      }

      projectActiveLine(nowMs);

      updateTrackingState(nowMs);
      commit(nowMs);
      return true;
    },

    applyCommand(command, nowMs = Date.now()) {
      const op = command?.op;

      if (op === 'toggleFollow') {
        state.teleprompter.followEnabled = !state.teleprompter.followEnabled;
        updateTrackingState(nowMs);
        commit(nowMs);
        return true;
      }

      if (op === 'nudge') {
        resetTeleprompterPosition(moveBySpokenLines(state.current.lines, state.teleprompter.activeLineIndex, command.delta ?? 0), nowMs);
        commit(nowMs);
        return true;
      }

      if (op === 'jumpParagraph') {
        resetTeleprompterPosition(findParagraphJumpTarget(state.current.lines, state.teleprompter.activeLineIndex, command.delta ?? 0), nowMs);
        commit(nowMs);
        return true;
      }

      if (op === 'jump') {
        resetTeleprompterPosition(command.lineIndex ?? 0, nowMs);
        commit(nowMs);
        return true;
      }

      if (op === 'reset') {
        resetTeleprompterPosition(findFirstSpokenLine(state.current.lines), nowMs);
        commit(nowMs);
        return true;
      }

      if (op === 'timerStart') {
        if (!state.timer.running) {
          runtime.timerStartedAtMs = nowMs - state.timer.elapsedMs;
          state.timer.running = true;
          syncTimer(nowMs);
          commit(nowMs);
        }
        return true;
      }

      if (op === 'timerPause') {
        if (state.timer.running) {
          syncTimer(nowMs);
          state.timer.running = false;
          runtime.timerStartedAtMs = null;
          commit(nowMs);
        }
        return true;
      }

      if (op === 'timerReset') {
        state.timer.running = false;
        state.timer.elapsedMs = 0;
        state.timer.remainingMs = state.timer.targetDurationMs;
        runtime.timerStartedAtMs = null;
        commit(nowMs);
        return true;
      }

      return false;
    },

    updateObsPreview(preview, nowMs = Date.now()) {
      const nextPreview = {
        ...state.obs.preview,
        ...preview,
      };

      if (isSameFlatState(state.obs.preview, nextPreview)) {
        return false;
      }

      state.obs.preview = nextPreview;
      commit(nowMs);
      return true;
    },

    updateStream(stream, nowMs = Date.now()) {
      const nextStream = {
        ...state.stream,
        ...stream,
      };

      if (isSameFlatState(state.stream, nextStream)) {
        return false;
      }

      state.stream = nextStream;
      commit(nowMs);
      return true;
    },

    tick(nowMs = Date.now()) {
      const previousElapsedMs = state.timer.elapsedMs;
      const previousRemainingMs = state.timer.remainingMs;
      const previousActiveLineIndex = state.teleprompter.activeLineIndex;
      const previousTrackingState = state.teleprompter.trackingState;

      syncTimer(nowMs);
      projectActiveLine(nowMs);
      updateTrackingState(nowMs);

      if (state.timer.elapsedMs === previousElapsedMs
        && state.timer.remainingMs === previousRemainingMs
        && state.teleprompter.activeLineIndex === previousActiveLineIndex
        && state.teleprompter.trackingState === previousTrackingState) {
        return false;
      }

      commit(nowMs);
      return true;
    },

    getState() {
      return structuredClone(state);
    },
  };
}
