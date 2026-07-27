/**
 * Build ffmpeg capture args for macOS avfoundation chunk capture.
 *
 * @param {{ chunkSeconds: number, inputDevice: string, outputPath: string }} options Capture options.
 * @returns {string[]}
 */
export function buildCaptureArgs(options) {
  return [
    '-f', 'avfoundation',
    '-i', options.inputDevice,
    '-t', String(options.chunkSeconds),
    '-y',
    options.outputPath,
  ];
}
