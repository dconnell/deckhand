/**
 * Build a compact operator-facing runtime status payload.
 *
 * @param {{ currentPresentationState: null | { seq: number, slideId: string, layoutId: string, audienceScene: string, focus: string | null, slots: Array<Record<string, unknown>> }, hubAddress: { host: string, port: number }, hubSnapshot: { activeDriver: Record<string, unknown> | null, observers: Array<Record<string, unknown>>, targets: Array<Record<string, unknown>> }, obsConnected: boolean, presenterEnabled: boolean }} input Runtime state.
 * @returns {{ service: 'deckhand', presenterEnabled: boolean, obs: { connected: boolean }, hub: { host: string, port: number, driverConnected: boolean, observerCount: number, targetCount: number }, current: null | { seq: number, slideId: string, layoutId: string, audienceScene: string, focus: string | null, slots: Array<Record<string, unknown>> } }}
 */
export function buildRuntimeStatus(input) {
  return {
    service: 'deckhand',
    presenterEnabled: input.presenterEnabled,
    obs: {
      connected: input.obsConnected,
    },
    hub: {
      host: input.hubAddress.host,
      port: input.hubAddress.port,
      driverConnected: input.hubSnapshot.activeDriver !== null,
      observerCount: input.hubSnapshot.observers.length,
      targetCount: input.hubSnapshot.targets.length,
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
