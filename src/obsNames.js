import { listAudienceScenes, listLayoutSources } from './scenes.js';

/**
 * Prefix applied to every OBS entity Deckhand creates.
 *
 * The prefix is the ownership marker: pruning reconciles only `Deckhand_*`
 * entities against the current config, so the operator's non-Deckhand OBS
 * content is never touched. Stateless — no manifest or state directory.
 *
 * @type {string}
 */
export const DECKHAND_PREFIX = 'Deckhand_';

/**
 * Build the OBS input name for a logical source ID.
 *
 * @param {string} sourceId Logical source ID.
 * @returns {string}
 */
export function deckhandInputName(sourceId) {
  return `${DECKHAND_PREFIX}${sourceId}`;
}

/**
 * Build the OBS scene name for an audience scene.
 *
 * @param {string} audienceScene Audience scene name from a layout.
 * @returns {string}
 */
export function deckhandSceneName(audienceScene) {
  return `${DECKHAND_PREFIX}${audienceScene}`;
}

/**
 * Report whether an OBS entity name is Deckhand-managed (prefix-scoped).
 *
 * @param {unknown} name OBS input or scene name.
 * @returns {boolean}
 */
export function isDeckhandManagedName(name) {
  return typeof name === 'string' && name.startsWith(DECKHAND_PREFIX);
}

/**
 * Compute the set of `Deckhand_*` entity names the current config wants to keep.
 *
 * Inputs are the layout sources (plus the freeze image when transitions are
 * configured); scenes are the audience scenes (plus the freeze scene when
 * transitions are configured).
 *
 * @param {{ layouts: Record<string, { audienceScene: string, slots: Array<{ source: string }> }>, obs: { transitions: null | { freezeScene: string, freezeImage: string } } }} config Normalized config.
 * @returns {{ inputs: Set<string>, scenes: Set<string> }}
 */
export function computeDesiredManagedNames(config) {
  const inputs = new Set(listLayoutSources(config).map(deckhandInputName));
  const scenes = new Set(listAudienceScenes(config).map(deckhandSceneName));

  if (config.obs?.transitions !== null && config.obs?.transitions !== undefined) {
    inputs.add(config.obs.transitions.freezeImage);
    scenes.add(config.obs.transitions.freezeScene);
  }

  return { inputs, scenes };
}

/**
 * Compute which existing `Deckhand_*` entities should be pruned.
 *
 * Returns the Deckhand-managed names present in OBS but absent from the desired
 * set, split by kind. Non-`Deckhand_*` names are never returned.
 *
 * @param {{ existingInputs: string[], existingScenes: string[], desired: { inputs: Set<string>, scenes: Set<string> } }} options Existing OBS names and the desired set.
 * @returns {{ inputs: string[], scenes: string[] }}
 */
export function computeManagedPruneSet({ existingInputs, existingScenes, desired }) {
  const inputs = existingInputs.filter((name) => isDeckhandManagedName(name) && !desired.inputs.has(name));
  const scenes = existingScenes.filter((name) => isDeckhandManagedName(name) && !desired.scenes.has(name));

  return { inputs, scenes };
}
