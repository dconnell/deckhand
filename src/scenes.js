/**
 * Shared layout and geometry helpers for audience and presenter state.
 *
 * This module stays pure so it can back config validation, OBS setup, and
 * presenter-state derivation from one place.
 */

/**
 * OBS bounds type used for every region.
 *
 * `OBS_BOUNDS_SCALE_INNER` preserves source aspect ratio so content is never
 * stretched.
 *
 * @type {'OBS_BOUNDS_SCALE_INNER' | 'OBS_BOUNDS_STRETCH' | 'OBS_BOUNDS_SCALE_OUTER'}
 */
export const BOUNDS_TYPE = 'OBS_BOUNDS_SCALE_INNER';
const PRESENTER_OVERLAY_SOURCE = 'Presenter';
const CONSOLE_OVERLAY_SOURCE = 'Console';
// Overlay sources whose windows Deckhand owns inside its own Chrome session;
// only their rects are subject to Chrome's enforced minimum window size.
const CHROME_OWNED_OVERLAY_SOURCES = new Set([PRESENTER_OVERLAY_SOURCE, CONSOLE_OVERLAY_SOURCE]);

function cloneOverlay(overlay) {
  if (overlay.rect !== undefined) {
    return {
      source: overlay.source,
      rect: { ...overlay.rect },
    };
  }

  return {
    source: overlay.source,
    hidden: true,
  };
}

function mergeOverlays(presenterOverlays = [], layoutOverlays = [], slideOverlays = []) {
  const bySource = new Map();

  for (const overlay of presenterOverlays) {
    bySource.set(overlay.source, cloneOverlay(overlay));
  }

  for (const overlay of layoutOverlays) {
    bySource.set(overlay.source, cloneOverlay(overlay));
  }

  for (const overlay of slideOverlays) {
    bySource.set(overlay.source, cloneOverlay(overlay));
  }

  return [...bySource.values()];
}

/**
 * Compute the OBS scene-item transform for a region position.
 *
 * @param {'full' | 'left' | 'right'} position Region position on the canvas.
 * @param {number} canvasWidth Canvas base width (px).
 * @param {number} canvasHeight Canvas base height (px).
 * @returns {{ positionX: number, positionY: number, boundsType: string, boundsWidth: number, boundsHeight: number }}
 */
export function regionTransform(position, canvasWidth, canvasHeight) {
  const halfWidth = canvasWidth / 2;

  if (position === 'left') {
    return {
      positionX: 0,
      positionY: 0,
      boundsType: BOUNDS_TYPE,
      boundsWidth: halfWidth,
      boundsHeight: canvasHeight,
    };
  }

  if (position === 'right') {
    return {
      positionX: halfWidth,
      positionY: 0,
      boundsType: BOUNDS_TYPE,
      boundsWidth: halfWidth,
      boundsHeight: canvasHeight,
    };
  }

  return {
    positionX: 0,
    positionY: 0,
    boundsType: BOUNDS_TYPE,
    boundsWidth: canvasWidth,
    boundsHeight: canvasHeight,
  };
}

/**
 * Compute the presenter-stage screen rectangle for a logical slot position.
 *
 * @param {'full' | 'left' | 'right'} position Region position on the stage.
 * @param {{ x: number, y: number, width: number, height: number }} stage Presenter stage rectangle.
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function screenRect(position, stage) {
  const halfWidth = stage.width / 2;

  if (position === 'left') {
    return {
      x: stage.x,
      y: stage.y,
      w: halfWidth,
      h: stage.height,
    };
  }

  if (position === 'right') {
    return {
      x: stage.x + halfWidth,
      y: stage.y,
      w: halfWidth,
      h: stage.height,
    };
  }

  return {
    x: stage.x,
    y: stage.y,
    w: stage.width,
    h: stage.height,
  };
}

/**
 * List unique audience scenes from the config layout catalog.
 *
 * @param {{ layouts: Record<string, { audienceScene: string }> }} config Normalized config.
 * @returns {string[]}
 */
export function listAudienceScenes(config) {
  const seen = new Set();
  const scenes = [];

  for (const layout of Object.values(config.layouts)) {
    if (!seen.has(layout.audienceScene)) {
      seen.add(layout.audienceScene);
      scenes.push(layout.audienceScene);
    }
  }

  return scenes;
}

/**
 * List unique logical sources from the config layout catalog.
 *
 * @param {{ layouts: Record<string, { slots: Array<{ source: string }> }> }} config Normalized config.
 * @returns {string[]}
 */
export function listLayoutSources(config) {
  const seen = new Set();
  const sources = [];

  for (const layout of Object.values(config.layouts)) {
    for (const slot of layout.slots) {
      if (!seen.has(slot.source)) {
        seen.add(slot.source);
        sources.push(slot.source);
      }
    }
  }

  return sources;
}

/**
 * Decide whether a slide advance can skip the OBS audience transition.
 *
 * True when the incoming slide resolves to the same audience scene with
 * identical slots and dispatches no browser commands: nothing the audience
 * sees can change, so only presenter-side state needs updating. Any scene,
 * slot, or command difference must run the normal freeze → mutate → reveal
 * sequence (browser commands can change visible content and belong behind
 * the freeze).
 *
 * @param {{ slideId?: string, audienceScene: string, slots: Array<{ source: string, position: string }> } | null} previousState Previous resolved presentation state (null before the first advance).
 * @param {{ slideId?: string, audienceScene: string, slots: Array<{ source: string, position: string }> }} nextState Incoming resolved presentation state.
 * @param {{ commands?: Array<unknown> } | undefined} slideConfig Normalized config for the incoming slide.
 * @returns {boolean}
 */
export function shouldSkipAudienceTransition(previousState, nextState, slideConfig) {
  if (previousState === null || previousState === undefined) {
    return false;
  }

  if (previousState.audienceScene !== nextState.audienceScene) {
    return false;
  }

  // The driver deck's Slide surface is audience-visible (coordinator's
  // sourceNeedsDifferentFrame special-cases it the same way), so when the
  // slide id changes on a Slide-backed layout the deck's own advance already
  // changed what the audience sees: it must keep the full masked transition.
  // States without slideId compare undefined === undefined and are unaffected.
  if (previousState.slideId !== nextState.slideId
    && nextState.slots.some((slot) => slot.source === 'Slide')) {
    return false;
  }

  if (slideConfig?.commands !== undefined && slideConfig.commands.length > 0) {
    return false;
  }

  const previousSlots = previousState.slots;
  const nextSlots = nextState.slots;

  if (previousSlots.length !== nextSlots.length) {
    return false;
  }

  for (let index = 0; index < previousSlots.length; index += 1) {
    if (previousSlots[index].source !== nextSlots[index].source
      || previousSlots[index].position !== nextSlots[index].position) {
      return false;
    }
  }

  return true;
}

/**
 * Resolve a configured slide to a full presentation-state payload.
 *
 * @param {string} slideId Normalized slide identifier.
 * @param {{ layouts: Record<string, { id: string, audienceScene: string, slots: Array<{ source: string, position: 'full' | 'left' | 'right' }>, overlays: Array<{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }> }>, slides: Record<string, { layoutId: string, focus: string | null, script: string | null, commands: Array<Record<string, unknown>>, overlays: Array<{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }> }>, presenter: null | { stage: { x: number, y: number, width: number, height: number }, windows: Record<string, { app: string, titleIncludes?: string }>, overlays: Array<{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }>, externalWindows: Record<string, { app: string, titleIncludes?: string }> } }} config Normalized config.
 * @param {number} seq Monotonic presentation-state sequence number.
 * @param {{ windowBindings?: Record<string, { app?: string, titleIncludes?: string, pid?: number, macWindowId?: number, strict?: boolean }> }} [runtime] Runtime binding overlays.
 * @returns {{ type: 'presentationState', seq: number, slideId: string, layoutId: string, audienceScene: string, slots: Array<{ source: string, position: 'full' | 'left' | 'right', rect?: { x: number, y: number, w: number, h: number } }>, windowBindings?: Record<string, { app: string, titleIncludes?: string, pid?: number, macWindowId?: number, strict?: boolean }>, managedWindowBindings?: Record<string, { app: string, titleIncludes?: string, pid?: number, macWindowId?: number, strict?: boolean }>, overlays?: Array<{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }>, focus: string | null, script: string | null, commands: Array<Record<string, unknown>> }}
 */
export function buildPresentationState(slideId, config, seq, runtime = {}) {
  const slide = config.slides[slideId];

  if (slide === undefined) {
    throw new Error(`Unknown slide: ${slideId}`);
  }

  const layout = config.layouts[slide.layoutId];
  const state = {
    type: 'presentationState',
    seq,
    slideId,
    layoutId: layout.id,
    audienceScene: layout.audienceScene,
    slots: [],
    focus: slide.focus,
    script: slide.script,
    commands: slide.commands,
  };

  if (config.presenter === null) {
    state.slots = layout.slots.map((slot) => ({
      source: slot.source,
      position: slot.position,
    }));
    return state;
  }

  const managedWindowBindings = {};
  for (const [sourceId, binding] of Object.entries(config.presenter.windows)) {
    managedWindowBindings[sourceId] = {
      ...binding,
      ...(runtime.windowBindings?.[sourceId] ?? {}),
    };
  }

  for (const [sourceId, binding] of Object.entries(config.presenter.externalWindows ?? {})) {
    managedWindowBindings[sourceId] = {
      ...binding,
      ...(runtime.windowBindings?.[sourceId] ?? {}),
    };
  }

  if (config.presenter.teleprompter?.window !== null && config.presenter.teleprompter?.window !== undefined) {
    managedWindowBindings[PRESENTER_OVERLAY_SOURCE] = {
      ...config.presenter.teleprompter.window,
      ...(runtime.windowBindings?.[PRESENTER_OVERLAY_SOURCE] ?? {}),
    };
  }

  // Owned source kinds (browser, app) may omit a presenter.windows selector:
  // their owner name and exact macWindowId are derived from the runtime
  // binding rather than committed config. Surface those bindings too so they
  // flow to Hammerspoon and OBS without a configured window selector.
  for (const [sourceId, binding] of Object.entries(runtime.windowBindings ?? {})) {
    if (managedWindowBindings[sourceId] === undefined) {
      managedWindowBindings[sourceId] = { ...binding };
    }
  }

  // Precedence (later wins, keyed by source): presenter defaults < layout < slide.
  const overlays = mergeOverlays(config.presenter.overlays, layout.overlays, slide.overlays);
  const windowBindings = {};
  state.slots = layout.slots.map((slot) => {
    windowBindings[slot.source] = managedWindowBindings[slot.source];

    return {
      source: slot.source,
      position: slot.position,
      rect: screenRect(slot.position, config.presenter.stage),
    };
  });

  for (const overlay of overlays) {
    if (managedWindowBindings[overlay.source] !== undefined) {
      windowBindings[overlay.source] = managedWindowBindings[overlay.source];
    }
  }

  state.windowBindings = windowBindings;
  state.managedWindowBindings = managedWindowBindings;

  if (overlays.length > 0) {
    state.overlays = overlays;
  }

  return state;
}

/**
 * Find configured overlay rects that fall below Chrome's enforced minimum
 * window size.
 *
 * Deckhand-owned Chrome overlay windows (`Presenter`, `Console`) are silently
 * clamped by Chrome when their configured rect is smaller than the enforced
 * minimum, so such rects can never be honored. Foreign app windows (e.g.
 * `presenter.externalWindows` entries) are positioned by the OS and are
 * ignored, as are hidden overlays (no rect). Exactly-at-minimum rects are not
 * below. The result is warn-only input: callers must not clamp config or fail
 * startup because of a finding.
 *
 * @param {{ layouts: Record<string, { overlays: Array<{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }> }>, slides: Record<string, { overlays: Array<{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }> }>, presenter: null | { overlays: Array<{ source: string, rect?: { x: number, y: number, w: number, h: number }, hidden?: true }> } }} config Normalized config.
 * @param {{ width: number, height: number }} minimum Chrome's enforced minimum window size.
 * @returns {Array<{ source: string, origin: string, rect: { x: number, y: number, w: number, h: number } }>} Findings in scan order: presenter-level overlays (`origin: 'presenter.overlays'`), then layouts in object order (`origin: 'layout:<layoutId>'`), then slides in object order (`origin: 'slide:<slideId>'`).
 */
export function findBelowMinimumOverlayRects(config, minimum) {
  const findings = [];

  const scanOverlays = (overlays, origin) => {
    for (const overlay of overlays) {
      if (!CHROME_OWNED_OVERLAY_SOURCES.has(overlay.source) || overlay.rect === undefined) {
        continue;
      }

      if (overlay.rect.w >= minimum.width && overlay.rect.h >= minimum.height) {
        continue;
      }

      findings.push({
        source: overlay.source,
        origin,
        rect: { ...overlay.rect },
      });
    }
  };

  scanOverlays(config.presenter?.overlays ?? [], 'presenter.overlays');

  for (const [layoutId, layout] of Object.entries(config.layouts)) {
    scanOverlays(layout.overlays ?? [], `layout:${layoutId}`);
  }

  for (const [slideId, slide] of Object.entries(config.slides)) {
    scanOverlays(slide.overlays ?? [], `slide:${slideId}`);
  }

  return findings;
}
