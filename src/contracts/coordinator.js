/**
 * Named JSDoc contracts for the coordinator orchestration layer.
 *
 * These typedefs exist so `createCoordinator`'s public documentation can
 * reference stable names (`import('./contracts/coordinator.js').CoordinatorOptions`)
 * instead of re-listing every nested object inline. They document the shapes the
 * coordinator actually consumes; they are not a runtime abstraction and this
 * module exports nothing.
 */

/**
 * OBS transition settings used by the freeze -> mutate -> reveal sequence.
 *
 * @typedef {object} CoordinatorTransitions
 * @property {string | null} forward Transition used for forward advances, or null for a direct cut.
 * @property {string | null} backward Transition used for backward advances, or null for a direct cut.
 * @property {string} freezeScene OBS scene that shows the frozen audience frame.
 * @property {string} freezeImage OBS input that displays the freeze image.
 * @property {string | null} freezeImagePath Explicit freeze image path, or null for the temp-dir default.
 * @property {number} durationMs Directional transition duration in milliseconds.
 * @property {number} settleMs Wait after the freeze scene goes live before mutating.
 * @property {number} navigationWaitMs Wait for browser navigation before revealing.
 * @property {number} windowSettleMs Budget for the presenter window-settle ack.
 * @property {number} freezeDimPercent Freeze frame dimming percentage.
 */

/**
 * OBS client surface the coordinator consumes. Everything except the lifecycle
 * pair is capability-detected, so tests may inject partial clients.
 *
 * @typedef {object} CoordinatorObsClient
 * @property {() => Promise<unknown>} connect Open the OBS websocket connection.
 * @property {() => Promise<unknown>} disconnect Close the OBS websocket connection.
 * @property {(sceneName: string) => Promise<unknown>} setScene Switch the program scene.
 * @property {() => boolean} [isConnected] Whether the OBS connection is up.
 * @property {() => boolean} [isReconnecting] Whether a reconnect attempt is in flight.
 * @property {(event: 'reconnecting' | 'reconnected', handler: (event: string) => void) => void} [on] Subscribe to reconnect lifecycle events.
 * @property {(inputName: string, inputSettings: Record<string, unknown>) => Promise<void>} [applyInputSettings] Push window-capture settings onto an input.
 * @property {() => Promise<string>} [getCurrentTransitionName] Read the operator's current transition.
 * @property {(filePath: string) => Promise<void>} [captureProgramScreenshot] Save the program frame to a file.
 * @property {(sceneName: string, options?: { waitForEvent?: boolean, timeoutMs?: number }) => Promise<void>} [switchProgramScene] Switch scenes, optionally awaiting the transition end event.
 * @property {(options?: { timeoutMs?: number }) => Promise<void>} [waitForSceneTransitionEnd] Await the running transition's end.
 * @property {(name: string, durationMs?: number) => Promise<void>} [setCurrentTransition] Select the active transition by name.
 * @property {(options: { sceneName: string, inputName: string, imagePath: string, dimPercent?: number }) => Promise<void>} [ensureFreezeAssets] Create or refresh the freeze scene assets.
 * @property {() => Promise<Buffer>} [getProgramScreenshotBuffer] Capture the program frame into memory.
 * @property {() => Promise<Record<string, unknown>>} [getStreamStatus] Read OBS stream health status.
 * @property {() => Promise<boolean>} [getStudioModeEnabled] Whether OBS Studio Mode is on.
 * @property {(enabled: boolean) => Promise<void>} [setStudioModeEnabled] Turn OBS Studio Mode on or off.
 * @property {(sceneName: string) => Promise<void>} [setPreviewScene] Set the Studio Mode preview scene.
 * @property {(options: { targetSceneName: string }) => Promise<void>} [triggerStudioModeTransition] Cut the preview scene to program.
 * @property {(sourceName: string, options?: { differentFromData?: string | null }) => Promise<void>} [waitForSourceScreenshotStable] Wait until a source's screenshot stops changing.
 * @property {(sourceName: string) => Promise<string>} [getSourceScreenshotData] Fetch a source screenshot as base64 data.
 */

/**
 * Snapshot of connected hub clients.
 *
 * @typedef {object} CoordinatorHubSnapshot
 * @property {Record<string, unknown> | null} activeDriver Currently active driver client, if any.
 * @property {Array<Record<string, unknown>>} observers Connected observer clients.
 * @property {Record<string, unknown>} sticky Last sticky payload per channel.
 */

/**
 * Hub client surface the coordinator consumes for event wiring and publishing.
 *
 * @typedef {object} CoordinatorHub
 * @property {(eventName: string, handler: (payload: unknown) => Promise<void> | void) => void} on Subscribe to a hub event.
 * @property {() => Promise<unknown>} start Start accepting clients.
 * @property {() => Promise<unknown>} stop Stop the hub.
 * @property {(target: { role?: 'driver' }, command: Record<string, unknown>) => Promise<unknown>} sendCommand Send a command to targeted clients.
 * @property {(channel: string, payload: Record<string, unknown>) => Promise<unknown>} publishSticky Publish a sticky channel payload.
 * @property {() => CoordinatorHubSnapshot} getSnapshot Current client and sticky-payload snapshot.
 */

/**
 * Command-executor seam the coordinator dispatches typed slide commands
 * through. Absent (or null) when the deck declares no browser sources.
 *
 * @typedef {object} CoordinatorExecutor
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(command: Record<string, unknown>) => Promise<void>} execute
 */

/**
 * Resolved per-slide config: the layout that renders and any browser commands.
 *
 * @typedef {object} CoordinatorSlideConfig
 * @property {string} layoutId Layout rendered for this slide.
 * @property {Array<{ type: string, source: string, tab?: string, url?: string }>} commands Browser commands dispatched when the slide becomes active.
 */

/**
 * Driver-reported slide position payload forwarded through the hub.
 *
 * @typedef {object} DriverPosition
 * @property {string} id Slide id the deck advanced to.
 * @property {Record<string, unknown>} [index] Comparable h/v deck index.
 * @property {Record<string, unknown>} [meta] Driver-supplied metadata (e.g. `driverEventId`).
 */

/**
 * The slice of the normalized presentation config (`normalizeConfig` output)
 * that the coordinator reads.
 *
 * @typedef {object} CoordinatorConfig
 * @property {{ type: string }} driver Active deck driver descriptor.
 * @property {{ url: string, password: string, transitions: CoordinatorTransitions | null }} obs OBS connection and transition settings.
 * @property {Record<string, unknown>} layouts Layout definitions keyed by layout id.
 * @property {Record<string, CoordinatorSlideConfig>} slides Slide definitions keyed by slide id.
 * @property {Record<string, { kind: string }>} sources Source descriptors keyed by source id.
 * @property {{ teleprompter: { followEnabledByDefault: boolean, tracking?: { minConfidence?: number, farJumpLines?: number, offScriptMs?: number, lostMs?: number } }, stt: Record<string, unknown> | null } | null} presenter Presenter config, or null when the presentation has no presenter surfaces.
 */

/**
 * Dependencies for `createCoordinator`. Adapter hooks are optional so tests can
 * exercise the coordinator against fakes; production wiring passes the real
 * clients from `run()`.
 *
 * @typedef {object} CoordinatorOptions
 * @property {CoordinatorConfig} config Normalized presentation config.
 * @property {CoordinatorObsClient} obs OBS client adapter.
 * @property {CoordinatorHub} hub Hub client adapter.
 * @property {CoordinatorExecutor | null} [executor] Browser command executor; null when the deck has no browser sources.
 * @property {{ on?: (event: 'recovered', handler: () => void) => void } | null} [browserSession] Browser session, wired for recovery re-apply hooks.
 * @property {() => Record<string, Record<string, unknown>>} [getManagedWindowBindings] Current mac window binding per source id, as known by the runtime.
 * @property {() => number | null} [getManagedBrowserPid] Chrome pid backing managed browser sources.
 * @property {(input: { reopen?: boolean }) => Promise<unknown>} [focusPresenterTeleprompter] Focus or reopen the teleprompter window on presenter command.
 * @property {(input: { sourceId: string }) => Promise<unknown>} [relaunchSource] Relaunch a managed source window on presenter command.
 * @property {(payload: { slideId: string, index: unknown }) => Promise<void> | void} [persistSlideId] Resume-point sink for the active slide id.
 * @property {import('../logger.js').Logger} [logger] Shared logger; defaults to a no-op logger.
 */

/**
 * Public coordinator surface returned by `createCoordinator`.
 *
 * @typedef {object} Coordinator
 * @property {() => Promise<void>} start Connect OBS, start the hub, and begin polling presenter state.
 * @property {() => Promise<void>} stop Tear the runtime down in reverse start order.
 * @property {(position: DriverPosition) => Promise<void>} handleDriverPositionChanged Queue a driver position change for serialized processing.
 * @property {() => Record<string, unknown> | null} getCurrentPresentationState Last published presentation state.
 * @property {() => Record<string, unknown> | null} getCurrentPresenterState Current presenter state, or null with no presenter config.
 * @property {() => Record<string, Record<string, unknown>>} getRuntimeWindowBindings Runtime window bindings learned from observers.
 * @property {(reason?: string) => Promise<void>} refreshCurrentPresentationState Republish the current presentation state.
 * @property {(reason: string, options?: { rearmFreeze?: boolean }) => Promise<void>} reapplyCurrentSlide Re-apply the current slide after transport recovery.
 * @property {() => Promise<void>} awaitSlideOperations Resolve when the serialized slide-operation queue drains.
 * @property {(nowMs?: number) => Promise<unknown>} tickPresenterState Advance presenter state and publish on change.
 * @property {() => { body: Buffer, etag: string, lastModified: string } | null} getProgramPreviewSnapshot Latest presenter program preview for HTTP serving.
 */
