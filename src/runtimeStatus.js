/**
 * Build a compact operator-facing runtime status payload.
 *
 * Browser-session health replaces the earlier target-client counts. The hub
 * snapshot no longer carries a target catalog; browser runtime state comes from
 * the browser session runtime.
 *
 * @param {{ phase: 'starting' | 'ready' | 'shuttingDown' | 'failed', currentPresentationState: null | { seq: number, slideId: string, layoutId: string, audienceScene: string, focus: string | null, slots: Array<Record<string, unknown>> }, hubAddress: { host: string, port: number }, hubSnapshot: { activeDriver: Record<string, unknown> | null, observers: Array<Record<string, unknown>> }, browserSessionStatus: { connected: boolean, chromePid: number | null, sources: Record<string, { ready: boolean, activeTab: string | null, tabs: string[] }> }, obsConnected: boolean, presenterEnabled: boolean }} input Runtime state.
 * @returns {{ service: 'deckhand', phase: 'starting' | 'ready' | 'shuttingDown' | 'failed', presenterEnabled: boolean, obs: { connected: boolean }, hub: { host: string, port: number, driverConnected: boolean, observerCount: number }, browserSession: { connected: boolean, chromePid: number | null, sources: Record<string, { ready: boolean, activeTab: string | null, tabs: string[] }> }, current: null | { seq: number, slideId: string, layoutId: string, audienceScene: string, focus: string | null, slots: Array<Record<string, unknown>> } }}
 */
export function buildRuntimeStatus(input) {
  return {
    service: 'deckhand',
    phase: input.phase,
    presenterEnabled: input.presenterEnabled,
    obs: {
      connected: input.obsConnected,
    },
    hub: {
      host: input.hubAddress.host,
      port: input.hubAddress.port,
      driverConnected: input.hubSnapshot.activeDriver !== null,
      observerCount: input.hubSnapshot.observers.length,
    },
    browserSession: {
      connected: input.browserSessionStatus.connected,
      chromePid: input.browserSessionStatus.chromePid,
      sources: Object.fromEntries(
        Object.entries(input.browserSessionStatus.sources).map(([id, source]) => [
          id,
          {
            ready: source.ready,
            activeTab: source.activeTab,
            tabs: [...source.tabs],
          },
        ]),
      ),
    },
    current: input.currentPresentationState === null
      ? null
      : {
          seq: input.currentPresentationState.seq,
          slideId: input.currentPresentationState.slideId,
          layoutId: input.currentPresentationState.layoutId,
          audienceScene: input.currentPresentationState.audienceScene,
          focus: input.currentPresentationState.focus,
          slots: input.currentPresentationState.slots,
        },
  };
}
