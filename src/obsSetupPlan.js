import { listLayoutSources, regionTransform } from './scenes.js';
import { parsePresentationCliArgs } from './presentations.js';

/**
 * Parse `setup:obs` CLI flags.
 *
 * @param {string[]} argv CLI args.
 * @returns {{ check: boolean, presentationName: string, setCanvas: boolean }}
 */
export function parseSetupObsOptions(argv) {
  const { presentationName, values } = parsePresentationCliArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      'set-canvas': { type: 'boolean', default: false },
    },
  });

  if (values.check && values['set-canvas']) {
    throw new Error('--check and --set-canvas are mutually exclusive');
  }

  return {
    check: values.check,
    presentationName,
    setCanvas: values['set-canvas'],
  };
}

/**
 * Return the expected OBS canvas dimensions when presenter mode is enabled.
 *
 * @param {{ presenter: null | { stage: { width: number, height: number } } }} config Normalized config.
 * @returns {{ width: number, height: number } | null}
 */
export function getExpectedPresenterCanvas(config) {
  if (config.presenter === null) {
    return null;
  }

  return {
    width: config.presenter.stage.width,
    height: config.presenter.stage.height,
  };
}

/**
 * Decide how OBS canvas mismatch should be handled.
 *
 * @param {{ actual: { width: number, height: number }, expected: { width: number, height: number } | null, options: { check: boolean, setCanvas: boolean } }} input Canvas decision inputs.
 * @returns {{ action: 'ok' | 'warn' | 'set' | 'fail', usesCanvas: { width: number, height: number }, warning?: string, error?: string }}
 */
export function evaluateCanvasPolicy(input) {
  const expected = input.expected;

  if (expected === null) {
    return {
      action: 'ok',
      usesCanvas: input.actual,
    };
  }

  if (expected.width === input.actual.width && expected.height === input.actual.height) {
    return {
      action: 'ok',
      usesCanvas: input.actual,
    };
  }

  if (input.options.check) {
    return {
      action: 'fail',
      usesCanvas: input.actual,
      error: 'OBS canvas does not match presenter stage dimensions',
    };
  }

  if (input.options.setCanvas) {
    return {
      action: 'set',
      usesCanvas: expected,
    };
  }

  return {
    action: 'warn',
    usesCanvas: input.actual,
    warning: 'OBS canvas does not match presenter stage dimensions',
  };
}

/**
 * Build the desired OBS scene catalog from normalized layouts.
 *
 * @param {{ layouts: Record<string, { audienceScene: string, slots: Array<{ source: string, position: 'full' | 'left' | 'right' }> }> }} config Normalized config.
 * @param {{ width: number, height: number }} canvas Canvas dimensions.
 * @returns {{ scenes: Array<{ sceneName: string, items: Array<{ sourceName: string, position: 'full' | 'left' | 'right', transform: { positionX: number, positionY: number, boundsType: string, boundsWidth: number, boundsHeight: number } }> }>, sources: string[] }}
 */
export function buildObsSceneDefinitions(config, canvas) {
  return {
    scenes: Object.values(config.layouts).map((layout) => ({
      sceneName: layout.audienceScene,
      items: layout.slots.map((slot) => ({
        sourceName: slot.source,
        position: slot.position,
        transform: regionTransform(slot.position, canvas.width, canvas.height),
      })),
    })),
    sources: listLayoutSources(config),
  };
}
