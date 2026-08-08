const DRIVER_READY_TIMEOUT_MS = 10000;
const PRESENTER_OBSERVER_TIMEOUT_MS = 5000;

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function hasPresentationObserver(hubSnapshot) {
  return hubSnapshot.observers.some((observer) => Array.isArray(observer.subscriptions) && observer.subscriptions.includes('presentationState'));
}

export function waitForEvent(timeoutMs, timeoutMessage, register) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    register((payload) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export async function waitForFirstDriverPosition({ coordinator, hub, timeoutMs = DRIVER_READY_TIMEOUT_MS, presentationName }) {
  if (coordinator.getCurrentPresentationState() !== null) {
    return;
  }

  await waitForEvent(
    timeoutMs,
    `Timed out waiting for the first driver position for presentation ${presentationName}. Open the deck and confirm the driver connects.`,
    (resolve) => {
      hub.on('driverPositionChanged', resolve);
    },
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
      hub.on('observerRegistered', (observer) => {
        if (Array.isArray(observer.subscriptions) && observer.subscriptions.includes('presentationState')) {
          resolve(observer);
        }
      });
    },
  );
}
