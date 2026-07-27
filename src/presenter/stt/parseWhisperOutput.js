/**
 * Parse whisper.cpp stdout into a single transcript string.
 *
 * @param {string} stdout Whisper stdout.
 * @returns {string}
 */
export function parseWhisperOutput(stdout) {
  return String(stdout)
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}
