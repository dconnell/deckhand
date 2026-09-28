import { CONSOLE_SOURCE_ID, PRESENTER_SOURCE_ID } from './windowBindingRegistry.js';

/**
 * Owns deckhand's presenter aux-window behavior: the teleprompter window the
 * coordinator focuses/reopens, the startup teleprompter binding resolution,
 * and the presenter console window bootstrap. Each successful (or failed)
 * open updates the window-binding registry and, where the original flow did,
 * triggers a coordinator presentation-state refresh.
 *
 * The browser session and coordinator are read through accessors because both
 * are created after this module in `run()`'s wiring order.
 *
 * @param {{
 *   config: Record<string, any>,
 *   logger: Record<string, any>,
 *   registry: ReturnType<import('./windowBindingRegistry.js').createWindowBindingRegistry>,
 *   getBrowserSession: () => Record<string, any> | null,
 *   getCoordinator: () => Record<string, any> | null | undefined,
 * }} input
 * @returns {{
 *   focusTeleprompter: (input?: { reopen?: boolean }) => Promise<object | null>,
 *   resolveStartupTeleprompterBinding: (input: { resolveFn: (input: object) => Promise<object | null> }) => Promise<void>,
 *   openConsoleWindow: () => Promise<void>,
 * }} presenter window bootstrap
 */
export function createPresenterWindowBootstrap({
  config,
  logger,
  registry,
  getBrowserSession,
  getCoordinator,
}) {
  /**
   * Open (or reopen) the presenter teleprompter window and refresh the
   * coordinator's presentation state. This is the callback handed to the
   * coordinator; it may be invoked at any point mid-run.
   *
   * @param {{ reopen?: boolean }} [input] Reopen forces a fresh window.
   * @returns {Promise<object | null>} The opened aux window, or null when
   *   presenter mode / the browser session / the window selector is absent.
   */
  async function focusTeleprompter({ reopen = false } = {}) {
    const browserSession = getBrowserSession();

    if (config.presenter === null || browserSession === null || config.presenter.teleprompter.window === null) {
      return null;
    }

    const auxWindow = await browserSession.openAuxWindow({
      key: 'presenter-teleprompter',
      title: config.presenter.teleprompter.window.titleIncludes ?? 'Deckhand Presenter',
      url: `http://${config.presenter.http.host}:${config.presenter.http.port}/presenter/teleprompter.html`,
      reopen,
    });
    const chromePid = browserSession.getStatus().chromePid;

    if (typeof auxWindow?.macWindowId === 'number') {
      registry.set(PRESENTER_SOURCE_ID, {
        macWindowId: auxWindow.macWindowId,
        ...(Number.isInteger(chromePid) && chromePid > 0 ? { pid: chromePid } : {}),
      });
    } else {
      registry.delete(PRESENTER_SOURCE_ID);
    }

    const coordinator = getCoordinator();
    if (coordinator !== undefined && coordinator !== null && typeof coordinator.refreshCurrentPresentationState === 'function') {
      await coordinator.refreshCurrentPresentationState(reopen ? 'teleprompterReopened' : 'teleprompterFocused');
    }

    return auxWindow;
  }

  /**
   * Resolve the teleprompter window binding at startup and register it for
   * Hammerspoon positioning. Resolution failures are warn-only so a missing
   * presenter window can never fail startup.
   *
   * @param {{ resolveFn: (input: object) => Promise<object | null> }} input
   *   Injectable teleprompter binding resolver (the real implementation by
   *   default, a stub in tests).
   * @returns {Promise<void>}
   */
  async function resolveStartupTeleprompterBinding({ resolveFn }) {
    try {
      const binding = await resolveFn({
        browserSession: getBrowserSession(),
        config,
        logger,
      });

      if (binding !== null) {
        registry.set(PRESENTER_SOURCE_ID, binding);
      }
    } catch (error) {
      logger.warn('Failed to open presenter window', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Open the presenter console window, register its binding, and refresh the
   * presentation state. Failures are warn-only: the console window is a
   * convenience surface and must never fail startup.
   *
   * @returns {Promise<void>}
   */
  async function openConsoleWindow() {
    const browserSession = getBrowserSession();

    try {
      const auxWindow = await browserSession.openAuxWindow({
        key: 'presenter-console',
        title: 'Deckhand Console',
        url: `http://${config.presenter.http.host}:${config.presenter.http.port}/presenter/`,
      });
      const chromePid = browserSession.getStatus().chromePid;

      if (typeof auxWindow?.macWindowId === 'number') {
        registry.set(CONSOLE_SOURCE_ID, {
          macWindowId: auxWindow.macWindowId,
          ...(Number.isInteger(chromePid) && chromePid > 0 ? { pid: chromePid } : {}),
        });
      } else {
        registry.delete(CONSOLE_SOURCE_ID);
      }

      // The window is already open at this point, so a refresh failure must
      // not be reported as a failure to open it. Binding registration above
      // cannot throw, so this catch only sees the refresh.
      try {
        const coordinator = getCoordinator();
        if (coordinator !== undefined && coordinator !== null && typeof coordinator.refreshCurrentPresentationState === 'function') {
          await coordinator.refreshCurrentPresentationState('consoleOpened');
        }
      } catch (error) {
        logger.warn('Failed to refresh presentation state after console open', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      logger.warn('Failed to open presenter console window', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    focusTeleprompter,
    resolveStartupTeleprompterBinding,
    openConsoleWindow,
  };
}
