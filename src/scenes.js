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
 * Resolve a configured slide to a full presentation-state payload.
 *
 * @param {string} slideId Normalized slide identifier.
 * @param {{ layouts: Record<string, { id: string, audienceScene: string, slots: Array<{ source: string, position: 'full' | 'left' | 'right' }> }>, slides: Record<string, { layoutId: string, focus: string | null, script: string | null, commands: Array<Record<string, unknown>> }>, presenter: null | { stage: { x: number, y: number, width: number, height: number }, windows: Record<string, { app: string, titleIncludes?: string }> } }} config Normalized config.
 * @param {number} seq Monotonic presentation-state sequence number.
 * @param {{ windowBindings?: Record<string, { app?: string, titleIncludes?: string, pid?: number, macWindowId?: number, strict?: boolean }> }} [runtime] Runtime binding overlays.
 * @returns {{ type: 'presentationState', seq: number, slideId: string, layoutId: string, audienceScene: string, slots: Array<{ source: string, position: 'full' | 'left' | 'right', rect?: { x: number, y: number, w: number, h: number } }>, windowBindings?: Record<string, { app: string, titleIncludes?: string, pid?: number, macWindowId?: number, strict?: boolean }>, managedWindowBindings?: Record<string, { app: string, titleIncludes?: string, pid?: number, macWindowId?: number, strict?: boolean }>, focus: string | null, script: string | null, commands: Array<Record<string, unknown>> }}
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

  // Owned source kinds (iterm2, app) may omit a presenter.windows selector:
  // their owner name and exact macWindowId are derived from the runtime
  // binding rather than committed config. Surface those bindings too so they
  // flow to Hammerspoon and OBS without a configured window selector.
  for (const [sourceId, binding] of Object.entries(runtime.windowBindings ?? {})) {
    if (managedWindowBindings[sourceId] === undefined) {
      managedWindowBindings[sourceId] = { ...binding };
    }
  }
  const windowBindings = {};
  state.slots = layout.slots.map((slot) => {
    windowBindings[slot.source] = managedWindowBindings[slot.source];

    return {
      source: slot.source,
      position: slot.position,
      rect: screenRect(slot.position, config.presenter.stage),
    };
  });
  state.windowBindings = windowBindings;
  state.managedWindowBindings = managedWindowBindings;

  return state;
}
