import { buildBootstrapBinding, getSourceOwnerName } from '../appRuntime.js';

/** Registry key for deckhand's own presenter teleprompter window. */
export const PRESENTER_SOURCE_ID = 'Presenter';

/** Registry key for deckhand's own presenter console window. */
export const CONSOLE_SOURCE_ID = 'Console';

/**
 * Owns the runtime's managed-window binding state:
 *
 * 1. the live macWindowId bindings used for OBS capture, Hammerspoon
 *    positioning, and coordinator refresh/reapply flows; and
 * 2. the shutdown stash — last-known bindings for windows whose live entry was
 *    invalidated mid-run (e.g. Hammerspoon reported the window unfindable), so
 *    shutdown can still close windows deckhand itself opened.
 *
 * @returns {{
 *   set: (sourceId: string, binding: object) => void,
 *   setMany: (bindings: Record<string, object>) => void,
 *   get: (sourceId: string) => object | undefined,
 *   delete: (sourceId: string) => void,
 *   snapshot: () => Record<string, object>,
 *   stashForShutdown: (sourceId: string) => boolean,
 *   getForShutdown: (sourceId: string) => object | undefined,
 * }} registry
 */
export function createWindowBindingRegistry() {
  const live = {};
  const shutdownStash = {};

  return {
    /** Register or replace the live binding for a source. */
    set(sourceId, binding) {
      live[sourceId] = binding;
    },

    /** Merge a batch of freshly resolved bindings into the live cache. */
    setMany(bindings) {
      for (const [sourceId, binding] of Object.entries(bindings)) {
        live[sourceId] = binding;
      }
    },

    /** Read the live binding for a source (undefined when invalidated). */
    get(sourceId) {
      return live[sourceId];
    },

    /** Drop the live binding for a source. */
    delete(sourceId) {
      delete live[sourceId];
    },

    /** Shallow copy of the live bindings, for synchronous OBS view building. */
    snapshot() {
      return { ...live };
    },

    /**
     * Move a source's live binding into the shutdown stash and drop it from
     * the live cache. When the live entry is already gone the stash is left
     * untouched: a stash written earlier (e.g. by the observer `cleared`
     * event) must survive so shutdown can still close the original window.
     *
     * @returns {boolean} Whether a live binding was stashed.
     */
    stashForShutdown(sourceId) {
      if (live[sourceId] !== undefined) {
        shutdownStash[sourceId] = live[sourceId];
        delete live[sourceId];
        return true;
      }

      delete live[sourceId];
      return false;
    },

    /**
     * Shutdown-time lookup: the live binding when present, otherwise the
     * stale identity stashed when the live entry was invalidated mid-run.
     */
    getForShutdown(sourceId) {
      return live[sourceId] ?? shutdownStash[sourceId];
    },
  };
}

/**
 * Build the coordinator-facing managed-window bindings view: one entry per
 * configured source plus deckhand's own Presenter/Console windows, blending
 * configured selectors, the browser-session registry, and cached macWindowIds.
 * Presenter-mode only; returns an empty view for audience-only configs.
 *
 * @param {{
 *   config: Record<string, any>,
 *   registry: ReturnType<typeof createWindowBindingRegistry>,
 *   browserSession: Record<string, any> | null,
 * }} input
 * @returns {Record<string, object>} Bindings keyed by source id.
 */
export function buildManagedWindowBindings({ config, registry, browserSession }) {
  if (config.presenter === null) {
    return {};
  }

  const chromePid = browserSession?.getStatus().chromePid ?? null;
  const registrySources = browserSession?.getRegistry().sources ?? {};
  const result = {};

  for (const [sourceId, source] of Object.entries(config.sources)) {
    const configured = config.presenter.windows?.[sourceId];
    const cached = registry.get(sourceId);
    const binding = {};

    if (source.kind === 'browser') {
      binding.app = configured?.app ?? getSourceOwnerName(config, sourceId);
      binding.titleIncludes = registrySources[sourceId]?.title;
      if (typeof chromePid === 'number') {
        binding.pid = chromePid;
      }
    } else {
      Object.assign(binding, buildBootstrapBinding(source, configured));
      if (typeof cached?.pid === 'number') {
        binding.pid = cached.pid;
      }
    }

    if (cached?.macWindowId !== undefined) {
      binding.macWindowId = cached.macWindowId;
    }

    result[sourceId] = binding;
  }

  if (config.presenter.teleprompter.window !== null) {
    result[PRESENTER_SOURCE_ID] = {
      ...config.presenter.teleprompter.window,
    };

    const cached = registry.get(PRESENTER_SOURCE_ID);
    if (typeof chromePid === 'number') {
      result[PRESENTER_SOURCE_ID].pid = chromePid;
    }
    if (cached?.pid !== undefined) {
      result[PRESENTER_SOURCE_ID].pid = cached.pid;
    }
    if (cached?.macWindowId !== undefined) {
      result[PRESENTER_SOURCE_ID].macWindowId = cached.macWindowId;
    }
  }

  // Unlike the teleprompter there is no config selector gate: the Console
  // window only exists when deckhand opened it, which is exactly when the
  // cached binding exists.
  const consoleCached = registry.get(CONSOLE_SOURCE_ID);
  if (consoleCached !== undefined) {
    result[CONSOLE_SOURCE_ID] = {
      app: getSourceOwnerName(config, CONSOLE_SOURCE_ID),
      titleIncludes: 'Deckhand Console',
    };

    if (typeof chromePid === 'number') {
      result[CONSOLE_SOURCE_ID].pid = chromePid;
    }
    if (consoleCached.pid !== undefined) {
      result[CONSOLE_SOURCE_ID].pid = consoleCached.pid;
    }

    result[CONSOLE_SOURCE_ID].macWindowId = consoleCached.macWindowId;
  }

  return result;
}
