import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import { buildCaptureArgs } from './buildCaptureArgs.js';
import { buildWhisperArgs } from './buildWhisperArgs.js';
import { shouldPublishTranscript } from './dedupeTranscript.js';
import { parseWhisperOutput } from './parseWhisperOutput.js';
import { runSubprocess } from './subprocess.js';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError';
}

function isSocketOpen(socket, WebSocketClass) {
  return socket.readyState === WebSocketClass.OPEN;
}

function closeSocket(socket) {
  try {
    socket.close();
  } catch {
    // ignore websocket cleanup failures
  }
}

function connectSocket(WebSocketClass, hubUrl, signal) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClass(hubUrl);

    function cleanup() {
      socket.off?.('open', handleOpen);
      socket.off?.('error', handleError);

      if (signal !== undefined) {
        signal.removeEventListener('abort', handleAbort);
      }
    }

    function handleAbort() {
      cleanup();
      closeSocket(socket);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    }

    function handleError(error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    function handleOpen() {
      cleanup();
      resolve(socket);
    }

    socket.once('open', handleOpen);
    socket.once('error', handleError);

    if (signal !== undefined) {
      if (signal.aborted) {
        handleAbort();
        return;
      }

      signal.addEventListener('abort', handleAbort, { once: true });
    }
  });
}

function sendJson(socket, payload) {
  socket.send(JSON.stringify(payload));
}

async function waitForRetry(delayMs, signal) {
  if (delayMs <= 0) {
    return;
  }

  await delay(delayMs, undefined, { signal });
}

/**
 * Run the local presenter STT observer.
 *
 * @param {{ chunkInput?: string, commandRunner?: (command: string, args: string[]) => Promise<{ stdout?: string, stderr?: string, exitCode?: number }>, hubUrl: string, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void }, nowFn?: () => number, once?: boolean, restartDelayMs?: number, signal?: AbortSignal, stt: { whisperBin: string, model: string, chunkSeconds: number, language?: string }, WebSocketClass?: typeof WebSocket }} options Runner options.
 * @returns {Promise<void>}
 */
export async function runSttObserver(options) {
  const logger = options.logger ?? createNoopLogger();
  const runCommand = options.commandRunner ?? runSubprocess;
  const WebSocketClass = options.WebSocketClass ?? WebSocket;
  const nowFn = options.nowFn ?? Date.now;
  const restartDelayMs = options.restartDelayMs ?? 1000;
  const signal = options.signal;
  let lastTranscript = '';
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckhand-stt-'));
  const audioPath = path.join(tempDir, 'chunk.wav');

  try {
    while (!signal?.aborted) {
      let socket = null;

      try {
        socket = await connectSocket(WebSocketClass, options.hubUrl, signal);
        sendJson(socket, {
          type: 'register',
          role: 'observer',
          subscriptions: [],
        });

        while (!signal?.aborted) {
          try {
            const captureArgs = buildCaptureArgs({
              chunkSeconds: options.stt.chunkSeconds,
              inputDevice: options.chunkInput ?? ':0',
              outputPath: audioPath,
            });
            const whisperArgs = buildWhisperArgs({
              audioPath,
              language: options.stt.language,
              model: options.stt.model,
            });

            await runCommand('ffmpeg', captureArgs);
            const result = await runCommand(options.stt.whisperBin, whisperArgs);
            const transcriptText = parseWhisperOutput(result.stdout ?? '');

            if (shouldPublishTranscript(lastTranscript, transcriptText)) {
              lastTranscript = transcriptText;
              if (!isSocketOpen(socket, WebSocketClass)) {
                throw new Error('Hub socket is not open');
              }

              sendJson(socket, {
                type: 'transcript',
                source: 'whisper',
                text: transcriptText,
                capturedAtMs: nowFn(),
              });
            }

            if (options.once) {
              logger.info('STT observer completed');
              return;
            }
          } catch (error) {
            if (isAbortError(error)) {
              break;
            }

            if (options.once) {
              throw error;
            }

            if (!isSocketOpen(socket, WebSocketClass)) {
              logger.warn('STT hub connection dropped; reconnecting', {
                error: error instanceof Error ? error.message : String(error),
              });
              break;
            }

            logger.warn('STT iteration failed; retrying', {
              error: error instanceof Error ? error.message : String(error),
            });
            await waitForRetry(restartDelayMs, signal);
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          break;
        }

        if (options.once) {
          throw error;
        }

        logger.warn('STT hub connection failed; retrying', {
          error: error instanceof Error ? error.message : String(error),
        });
        await waitForRetry(restartDelayMs, signal);
      } finally {
        if (socket !== null) {
          closeSocket(socket);
        }
      }
    }

    logger.info('STT observer stopped');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
