/**
 * Build a compact operator-facing runtime status payload.
 *
 * Browser-session health replaces the earlier target-client counts. The hub
 * snapshot no longer carries a target catalog; browser runtime state comes from
 * the browser session runtime.
 *
 * @param {{ phase: 'starting' | 'ready' | 'shuttingDown' | 'failed', sourceCatalog?: Array<{ id: string, kind: string }>, currentPresentationState: null | { seq: number, slideId: string, layoutId: string, audienceScene: string, focus: string | null, slots: Array<Record<string, unknown>> }, currentPresenterState?: null | { seq: number, presentationSeq: number, current: { slideId: string | null, layoutId: string | null, focus: string | null, hidden: boolean, lines?: Array<unknown> }, next: Record<string, unknown> | null, teleprompter: { followEnabled: boolean, activeLineIndex: number, trackingState: string, recentTranscript: Array<unknown> }, timer: Record<string, unknown>, obs: { preview?: Record<string, unknown> | null }, stream: Record<string, unknown> }, hubAddress: { host: string, port: number }, hubSnapshot: { activeDriver: Record<string, unknown> | null, observers: Array<Record<string, unknown>> }, browserSessionStatus: { connected: boolean, phase?: 'connected' | 'reconnecting' | 'recovering' | 'disconnected', chromePid: number | null, sources: Record<string, { ready: boolean, activeTab: string | null, tabs: string[] }> }, obsConnected: boolean, obsReconnecting?: boolean, presenterEnabled: boolean }} input Runtime state.
 * @returns {{ service: 'deckhand', phase: 'starting' | 'ready' | 'shuttingDown' | 'failed', presenterEnabled: boolean, recovering: boolean, sourceCatalog: Array<{ id: string, kind: string }>, obs: { connected: boolean, reconnecting: boolean }, hub: { host: string, port: number, driverConnected: boolean, observerCount: number }, browserSession: { connected: boolean, phase: 'connected' | 'reconnecting' | 'recovering' | 'disconnected', chromePid: number | null, sources: Record<string, { ready: boolean, activeTab: string | null, tabs: string[] }> }, current: null | { seq: number, slideId: string, layoutId: string, audienceScene: string, focus: string | null, slots: Array<Record<string, unknown>> }, presenter: null | { seq: number, presentationSeq: number, current: { slideId: string | null, layoutId: string | null, focus: string | null, hidden: boolean, lineCount: number }, next: Record<string, unknown> | null, teleprompter: { followEnabled: boolean, activeLineIndex: number, trackingState: string, recentTranscriptCount: number }, timer: Record<string, unknown>, obs: { preview: Record<string, unknown> | null }, stream: Record<string, unknown> } }}
 */
export function buildRuntimeStatus(input) {
  const obsReconnecting = input.obsReconnecting ?? false;
  const browserPhase = input.browserSessionStatus.phase
    ?? (input.browserSessionStatus.connected ? 'connected' : 'disconnected');
  const recovering = obsReconnecting || browserPhase === 'reconnecting' || browserPhase === 'recovering';

  return {
    service: 'deckhand',
    phase: input.phase,
    presenterEnabled: input.presenterEnabled,
    recovering,
    sourceCatalog: Array.isArray(input.sourceCatalog) ? input.sourceCatalog.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
    })) : [],
    obs: {
      connected: input.obsConnected,
      reconnecting: obsReconnecting,
    },
    hub: {
      host: input.hubAddress.host,
      port: input.hubAddress.port,
      driverConnected: input.hubSnapshot.activeDriver !== null,
      observerCount: input.hubSnapshot.observers.length,
    },
    browserSession: {
      connected: input.browserSessionStatus.connected,
      phase: browserPhase,
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
    presenter: input.currentPresenterState === null || input.currentPresenterState === undefined
      ? null
      : {
          seq: input.currentPresenterState.seq,
          presentationSeq: input.currentPresenterState.presentationSeq,
          current: {
            slideId: input.currentPresenterState.current.slideId,
            layoutId: input.currentPresenterState.current.layoutId,
            focus: input.currentPresenterState.current.focus,
            hidden: input.currentPresenterState.current.hidden,
            lineCount: Array.isArray(input.currentPresenterState.current.lines)
              ? input.currentPresenterState.current.lines.length
              : 0,
          },
          next: input.currentPresenterState.next,
          teleprompter: {
            followEnabled: input.currentPresenterState.teleprompter.followEnabled,
            activeLineIndex: input.currentPresenterState.teleprompter.activeLineIndex,
            trackingState: input.currentPresenterState.teleprompter.trackingState,
            recentTranscriptCount: Array.isArray(input.currentPresenterState.teleprompter.recentTranscript)
              ? input.currentPresenterState.teleprompter.recentTranscript.length
              : 0,
          },
          timer: input.currentPresenterState.timer,
          obs: {
            preview: input.currentPresenterState.obs.preview ?? null,
          },
          stream: input.currentPresenterState.stream,
        },
  };
}
