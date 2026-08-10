function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Create a smoothing predictor for teleprompter follow mode.
 *
 * @param {{ minRate: number, maxRate: number, alpha: number }} options Predictor options.
 * @returns {{ onMatch(index: number, now: number): void, predict(now: number, totalLines: number): number, reset(): void }}
 */
export function createPredictor(options) {
  let lastAnchor = null;
  let smoothedRate = 0;

  return {
    onMatch(index, now) {
      if (lastAnchor !== null) {
        const deltaIndex = index - lastAnchor.index;
        const deltaTimeSeconds = (now - lastAnchor.time) / 1000;

        if (deltaTimeSeconds > 0 && deltaIndex >= 0) {
          const rawRate = clamp(deltaIndex / deltaTimeSeconds, options.minRate, options.maxRate);
          smoothedRate = smoothedRate === 0
            ? rawRate
            : (options.alpha * rawRate) + ((1 - options.alpha) * smoothedRate);
        }
      }

      lastAnchor = { index, time: now };
    },

    predict(now, totalLines) {
      if (lastAnchor === null) {
        return 0;
      }

      const deltaTimeSeconds = Math.max(0, (now - lastAnchor.time) / 1000);
      const projected = lastAnchor.index + (smoothedRate * deltaTimeSeconds);
      return Math.floor(clamp(projected, lastAnchor.index, Math.max(0, totalLines - 1)));
    },

    reset() {
      lastAnchor = null;
      smoothedRate = 0;
    },
  };
}
