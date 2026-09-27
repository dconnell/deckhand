/**
 * Named JSDoc contracts for the runtime entry point in `src/index.js`.
 *
 * These typedefs exist so `run()`'s public documentation can reference a stable
 * name (`import('./contracts/runtime.js').RunOptions`) instead of re-listing
 * every nested field inline. They document the shapes `run()` actually consumes;
 * they are not a runtime abstraction and this module exports nothing.
 */

/**
 * Injectable relaunch hook for owned app sources. The default implementation
 * relaunches via `open -a` and re-resolves the mac window id by diffing
 * CGWindowList around the launch.
 *
 * @typedef {(input: { config: Record<string, unknown>, logger: Record<string, unknown>, sourceId: string }) => Promise<{ macWindowId?: number, pid?: number } | null>} RelaunchAppSourceFn
 */

/**
 * Startup options for the `run()` entry point.
 *
 * Every `*Fn` field is an injectable adapter override so tests can stub process
 * side effects; production callers omit them and `run()` falls back to the real
 * implementations.
 *
 * @typedef {object} RunOptions
 * @property {string} [cwd] Working directory holding the presentation tree.
 * @property {string} [presentationName] Presentation directory under `presentation/`.
 * @property {string} [configPath] Explicit config path; defaults to the presentation's config.
 * @property {Console} [consoleLike] Console sink for pre-logger startup errors.
 * @property {typeof import('../hub.js').createHub} [createHubFn] Hub factory override.
 * @property {typeof import('../obsClient.js').createObsClient} [createObsClientFn] OBS client factory override.
 * @property {typeof import('../coordinator.js').createCoordinator} [createCoordinatorFn] Coordinator factory override.
 * @property {typeof import('../presenterHttp.js').createPresenterHttpServer} [createPresenterHttpFn] Presenter HTTP factory override.
 * @property {typeof import('../presentationServer.js').createPresentationServer} [createPresentationServerFn] Presentation static server factory override.
 * @property {typeof import('../browserSession.js').createBrowserSession} [createBrowserSessionFn] Browser session factory override.
 * @property {typeof import('../browserSession.js').createBrowserCommandExecutor} [createBrowserCommandExecutorFn] Browser command executor factory override.
 * @property {typeof import('../cdpClient.js').createCdpClient} [createCdpClientFn] CDP client factory override.
 * @property {typeof import('../chromeLauncher.js').launchChromeSession} [launchChromeSessionFn] Chrome launch override.
 * @property {typeof import('../chromeLauncher.js').discoverCdpEndpoint} [discoverCdpEndpointFn] CDP endpoint discovery override.
 * @property {typeof import('../macWindows.js').enumerateWindowsByOwnerName} [preflightEnumerateWindowsFn] Window enumerator used by the owned-app preflight.
 * @property {typeof import('../setupObs.js').reconcileObsPresentation} [reconcileObsFn] OBS reconcile override.
 * @property {typeof import('../lifecycle/waitFor.js').waitForFirstDriverPosition} [waitForDriverPositionFn] Driver-position wait override.
 * @property {typeof import('../lifecycle/waitFor.js').waitForPresentationObserver} [waitForPresentationObserverFn] Presentation-observer wait override.
 * @property {typeof import('../recovery/slideResume.js').loadResumableSlide} [loadResumableSlideFn] Slide-resume load override.
 * @property {RelaunchAppSourceFn} [relaunchAppSourceFn] Owned app relaunch override.
 * @property {boolean} [installSignalHandlers] Whether to install SIGINT/SIGTERM/SIGHUP shutdown handlers.
 * @property {string} [presenterAssetsPath] Presenter web assets root.
 * @property {boolean} [noResume] Disable resume-from-persisted-slide for this run.
 * @property {number} [shutdownCloseTimeoutMs] Budget for closing one owned app window during shutdown.
 * @property {number} [shutdownStopTimeoutMs] Budget for stopping the coordinator/browser runtime during shutdown.
 * @property {typeof import('../macWindows.js').closeMacWindow} [closeMacWindowFn] mac window close override.
 * @property {typeof import('../appRuntime.js').terminateProcessGroup} [terminateProcessGroupFn] Process-group termination override.
 * @property {(pgid: number) => void} [killProcessGroupFn] Raw SIGKILL override, so tests never signal the developer's machine.
 * @property {(command: string) => void} [reapChromeProfilesFn] Chrome profile reaper (`pkill`) override.
 * @property {(input: { bindings: Array<{ sourceId: string, [key: string]: unknown }> }) => Promise<void> | void} [closeOwnedWindowsFn] Owned-window close override.
 * @property {(pid: number) => Array<{ windowId: number, width?: number, height?: number }>} [enumerateWindowIdsByPidFn] CGWindowList enumerator used to resolve new browser windows.
 * @property {typeof import('../appRuntime.js').resolvePresenterTeleprompterBinding} [resolvePresenterTeleprompterBindingFn] Teleprompter binding resolution override.
 * @property {typeof import('../presenter/stt/runner.js').runSttObserver} [runSttObserverFn] STT observer override.
 * @property {typeof import('../appRuntime.js').seedBrowserMacWindowBindings} [resolveMacWindowBindingsFn] Browser window binding seeding override.
 * @property {typeof import('../appRuntime.js').defaultResolveOwnedWindowBindings} [resolveOwnedWindowBindingsFn] Owned app window binding resolution override.
 */
