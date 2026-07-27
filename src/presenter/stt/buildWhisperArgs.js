/**
 * Build whisper.cpp CLI args for one audio chunk.
 *
 * @param {{ audioPath: string, language?: string, model: string }} options Whisper options.
 * @returns {string[]}
 */
export function buildWhisperArgs(options) {
  const args = [
    '-m', options.model,
    '-f', options.audioPath,
  ];

  if (typeof options.language === 'string' && options.language.trim() !== '') {
    args.push('-l', options.language.trim());
  }

  args.push('-nt', '-np');
  return args;
}
