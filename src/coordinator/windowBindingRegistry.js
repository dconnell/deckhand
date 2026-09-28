/**
 * Coordinator-owned window-binding registry.
 *
 * Owns the two mutable binding maps the coordinator used to mutate inline:
 * the runtime window bindings learned from observer updates, and the per-source
 * cache of window-capture settings already pushed to OBS. Pure state only —
 * the OBS push itself stays with the coordinator's apply policy.
 */

/**
 * The binding registry surface used by `createCoordinator`.
 *
 * @typedef {object} WindowBindingRegistry
 * @property {(source: string) => boolean} canResolveSource Whether a source id is a browser source the registry may bind.
 * @property {(payload: { bindings?: Record<string, Record<string, unknown>>, cleared?: string[] }) => boolean} mergeObserverBindings Merge an observer bindings payload; returns whether anything changed.
 * @property {() => Record<string, Record<string, unknown>>} snapshot Copy of the runtime bindings keyed by source id.
 * @property {(source: string) => string | undefined} getAppliedSettingsKey Last OBS settings key applied for a source.
 * @property {(source: string, settingsKey: string) => void} setAppliedSettingsKey Record the OBS settings key applied for a source.
 * @property {() => void} clearAppliedSettings Forget every applied settings key (used on recovery reapply).
 */

/**
 * Create the window-binding registry for one coordinator instance.
 *
 * @param {object} options Registry dependencies.
 * @param {import('../contracts/coordinator.js').CoordinatorConfig} options.config Normalized presentation config.
 * @returns {WindowBindingRegistry} The registry.
 */
export function createWindowBindingRegistry(options) {
  const { config } = options;
  const runtimeWindowBindings = {};
  // The last window-capture settings actually pushed to OBS, per source, so an
  // unchanged binding between slides does not trigger a macOS capture
  // re-acquisition that would delay the resized frame.
  const lastAppliedObsBindings = new Map();

  function canResolveSource(source) {
    return config.sources[source]?.kind === 'browser';
  }

  function mergeObserverBindings(payload) {
    let changed = false;

    for (const source of payload.cleared ?? []) {
      if (!canResolveSource(source)) {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(runtimeWindowBindings, source)) {
        delete runtimeWindowBindings[source];
        changed = true;
      }
    }

    for (const [source, binding] of Object.entries(payload.bindings ?? {})) {
      if (!canResolveSource(source)) {
        continue;
      }

      const current = runtimeWindowBindings[source];
      const next = { ...binding };

      if (current === undefined || JSON.stringify(current) !== JSON.stringify(next)) {
        runtimeWindowBindings[source] = next;
        changed = true;
      }
    }

    return changed;
  }

  function snapshot() {
    return { ...runtimeWindowBindings };
  }

  function getAppliedSettingsKey(source) {
    return lastAppliedObsBindings.get(source);
  }

  function setAppliedSettingsKey(source, settingsKey) {
    lastAppliedObsBindings.set(source, settingsKey);
  }

  function clearAppliedSettings() {
    lastAppliedObsBindings.clear();
  }

  return {
    canResolveSource,
    mergeObserverBindings,
    snapshot,
    getAppliedSettingsKey,
    setAppliedSettingsKey,
    clearAppliedSettings,
  };
}
