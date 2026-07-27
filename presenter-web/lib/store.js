import { createPredictor } from './createPredictor.js';
import { matchLine } from './matchLine.js';
import { splitScript } from './splitScript.js';

/**
 * Create the presenter-web state store.
 *
 * @param {{ followEnabledByDefault: boolean, transcriptLimit?: number }} options Store options.
 * @returns {{ beginConnection(connectionId: number): void, applyPresentationState(payload: { seq: number, slideId: string, layoutId: string, audienceScene: string, focus: string | null, script: string | null }, connectionId: number): void, applyTranscript(payload: { source: string, text: string, capturedAtMs: number }, connectionId: number): void, moveLine(delta: number): void, resetLine(): void, toggleFollow(): void, getState(): { connection: { connectionId: number | null, phase: string }, follow: { enabled: boolean, activeLineIndex: number }, presentation: null | { seq: number, slideId: string, layoutId: string, audienceScene: string, focus: string | null, script: string | null, lines: string[] }, transcript: { items: Array<{ source: string, text: string, capturedAtMs: number }> } }} }
 */
export function createPresenterStore(options) {
  const transcriptLimit = options.transcriptLimit ?? 10;
  const predictor = createPredictor({ alpha: 0.6, maxRate: 4, minRate: 0.25 });
  const state = {
    connection: {
      connectionId: null,
      phase: 'connecting',
    },
    follow: {
      enabled: options.followEnabledByDefault,
      activeLineIndex: 0,
    },
    presentation: null,
    transcript: {
      items: [],
    },
  };

  function clampActiveLine() {
    const max = Math.max(0, (state.presentation?.lines.length ?? 1) - 1);
    state.follow.activeLineIndex = Math.min(max, Math.max(0, state.follow.activeLineIndex));
  }

  return {
    beginConnection(connectionId) {
      state.connection = {
        connectionId,
        phase: 'live',
      };
      state.presentation = null;
      state.transcript.items = [];
      state.follow.activeLineIndex = 0;
      predictor.reset();
    },

    applyPresentationState(payload, connectionId) {
      if (state.connection.connectionId !== connectionId) {
        return;
      }

      if (state.presentation !== null && state.connection.connectionId === connectionId && payload.seq <= state.presentation.seq) {
        return;
      }

      state.presentation = {
        seq: payload.seq,
        slideId: payload.slideId,
        layoutId: payload.layoutId,
        audienceScene: payload.audienceScene,
        focus: payload.focus,
        script: payload.script,
        lines: splitScript(payload.script),
      };
      state.transcript.items = [];
      state.follow.activeLineIndex = 0;
      predictor.reset();
    },

    applyTranscript(payload, connectionId) {
      if (state.connection.connectionId !== connectionId) {
        return;
      }

      const previous = state.transcript.items.at(-1);
      if (previous && previous.source === payload.source && previous.text === payload.text && previous.capturedAtMs === payload.capturedAtMs) {
        return;
      }

      state.transcript.items.push(payload);
      if (state.transcript.items.length > transcriptLimit) {
        state.transcript.items = state.transcript.items.slice(-transcriptLimit);
      }

      if (!state.follow.enabled || state.presentation === null || state.presentation.lines.length === 0) {
        return;
      }

      const transcriptTail = state.transcript.items.map((item) => item.text).join(' ');
      const nextIndex = matchLine(transcriptTail, state.presentation.lines, state.follow.activeLineIndex);
      state.follow.activeLineIndex = nextIndex;
      predictor.onMatch(nextIndex, payload.capturedAtMs);
      state.follow.activeLineIndex = predictor.predict(payload.capturedAtMs, state.presentation.lines.length);
    },

    getState() {
      return state;
    },

    moveLine(delta) {
      state.follow.activeLineIndex += delta;
      clampActiveLine();
    },

    resetLine() {
      state.follow.activeLineIndex = 0;
    },

    toggleFollow() {
      state.follow.enabled = !state.follow.enabled;
    },
  };
}
