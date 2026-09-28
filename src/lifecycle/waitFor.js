import { withTimeout } from './time.js';

const DRIVER_READY_TIMEOUT_MS = 10000;
const PRESENTER_OBSERVER_TIMEOUT_MS = 5000;

export function hasPresentationObserver(hubSnapshot) {
  return hubSnapshot.observers.some((observer) => Array.isArray(observer.subscriptions) && observer.subscriptions.includes('presentationState'));
}

/**
 * Wait for a single event, resolving with the first payload `register`
 * delivers.
 *
 * `register(resolve)` attaches the underlying listener and may return an
 * unsubscribe function. The unsubscribe (when provided) runs once the wait
 * settles — on resolve or on timeout — so registered listeners never outlive
 * the wait. Callers registering on an emitter that supports removal
 * (e.g. `hub.on`) should return the unsubscribe they get back.
 *
 * @template T
 * @param {number} timeoutMs Milliseconds to wait before rejecting.
 * @param {string} timeoutMessage Message used for the timeout rejection.
 * @param {(resolve: (payload: T) => void) => (() => void) | void} register Attaches the underlying listener; may return an unsubscribe function.
 * @returns {Promise<T>} Settles with the first delivered payload, or rejects once the timeout fires.
 */
export function waitForEvent(timeoutMs, timeoutMessage, register) {
  let cleanup = null;

  return withTimeout(
    new Promise((resolve) => {
      cleanup = register(resolve) ?? null;
    }),
    timeoutMs,
    timeoutMessage,
  ).finally(() => {
    cleanup?.();
  });
}

export async function waitForFirstDriverPosition({ coordinator, hub, timeoutMs = DRIVER_READY_TIMEOUT_MS, presentationName }) {
  if (coordinator.getCurrentPresentationState() !== null) {
    return;
  }

  await waitForEvent(
    timeoutMs,
    `Timed out waiting for the first driver position for presentation ${presentationName}. Open the deck and confirm the driver connects.`,
    (resolve) => hub.on('driverPositionChanged', resolve),
  );
}

export async function waitForPresentationObserver({ hub, timeoutMs = PRESENTER_OBSERVER_TIMEOUT_MS }) {
  if (hasPresentationObserver(hub.getSnapshot())) {
    return;
  }

  await waitForEvent(
    timeoutMs,
    'Timed out waiting for a presenter observer. Check Hammerspoon, reload its config, and confirm Accessibility permission.',
    (resolve) => {
      const handler = (observer) => {
        if (Array.isArray(observer.subscriptions) && observer.subscriptions.includes('presentationState')) {
          resolve(observer);
        }
      };

      return hub.on('observerRegistered', handler);
    },
  );
}
