import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import { errorMessage } from '../../lib/errors.js';
import { createNoopLogger } from '../../logger.js';
import { buildWhisperArgs } from './buildWhisperArgs.js';
import { shouldPublishTranscript } from './dedupeTranscript.js';
import { createWhisperOutputParser } from './parseWhisperOutput.js';
import { createSubprocess } from './subprocess.js';

/**
 * Named failure for a whisper-stream run. Carries the captured process stderr
 * (and the triggering error as `cause`) as structured fields instead of the
 * ad-hoc `error.stderr = ...` property mutation this module used before.
 */
class WhisperStreamError extends Error {
  /**
   * @param {string} message Failure description.
   * @param {{ cause?: unknown, stderr?: string }} [details] Structured diagnostics.
   */
  constructor(message, details = {}) {
    super(message, { cause: details.cause });
    this.name = 'WhisperStreamError';

    if (details.stderr !== undefined) {
      this.stderr = details.stderr;
    }
  }
}

/**
 * Build the warn-log context for a caught error, exposing stderr only when the
 * failure carries structured whisper diagnostics.
 *
 * @param {unknown} error The caught error.
 * @returns {{ error: string, stderr: string | undefined }} Log context.
 */
function errorDiagnostics(error) {
  return {
    error: errorMessage(error),
    stderr: error instanceof WhisperStreamError ? error.stderr : undefined,
  };
}

function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError';
}

function isSocketOpen(socket, WebSocketClass) {
  return socket.readyState === WebSocketClass.OPEN;
}

function closeSocket(socket) {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.once?.('error', () => {});

    try {
      socket.terminate?.();
    } catch {
      // ignore websocket cleanup failures
    }

    return;
  }

  try {
    socket.close();
  } catch {
    // ignore websocket cleanup failures
  }
}

function closeProcess(child) {
  if (typeof child?.kill !== 'function') {
    return;
  }

  try {
    child.kill();
  } catch {
    // ignore subprocess cleanup failures
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

async function waitForRetry(delayFn, delayMs, signal) {
  if (delayMs <= 0) {
    return;
  }

  await delayFn(delayMs, signal);
}

function normalizeChunkInput(chunkInput) {
  return chunkInput ?? undefined;
}

function normalizeSttMode(stt) {
  return stt.mode === 'vad' ? 'vad' : 'step';
}

function buildParser(stt) {
  return createWhisperOutputParser({
    mode: normalizeSttMode(stt),
    nowFn: Date.now,
  });
}

function estimateTranscriptLagMs(stt, event) {
  if (event?.kind === 'segment') {
    return Number.isFinite(stt.lengthMs) && stt.lengthMs > 0
      ? Math.round(stt.lengthMs / 2)
      : 0;
  }

  return Number.isFinite(stt.stepMs) && stt.stepMs > 0
    ? Math.round(stt.stepMs)
    : 0;
}

function buildCommandArgs(stt, chunkInput) {
  return buildWhisperArgs({
    audioCtx: stt.audioCtx,
    beamSize: stt.beamSize,
    captureId: chunkInput ?? stt.captureId ?? ':0',
    flashAttn: stt.flashAttn,
    freqThreshold: stt.freqThreshold,
    keepContext: stt.keepContext,
    keepMs: stt.keepMs,
    language: stt.language,
    lengthMs: stt.lengthMs,
    mode: normalizeSttMode(stt),
    model: stt.model,
    noFallback: stt.noFallback,
    stepMs: stt.stepMs,
    threads: stt.threads,
    useGpu: stt.useGpu,
    vadThreshold: stt.vadThreshold,
  });
}

/**
 * Run the local presenter STT observer.
 *
 * @param {{ chunkInput?: string, createSubprocess?: (command: string, args: string[], options?: { signal?: AbortSignal }) => { stdout: NodeJS.ReadableStream & { setEncoding?(encoding: string): void }, stderr: NodeJS.ReadableStream & { setEncoding?(encoding: string): void }, result: Promise<{ stdout?: string, stderr?: string, exitCode?: number }>, kill?: () => void }, delayFn?: (delayMs: number, signal?: AbortSignal) => Promise<void>, hubUrl: string, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void }, nowFn?: () => number, once?: boolean, restartDelayMs?: number, signal?: AbortSignal, stt: { whisperBin: string, model: string, audioCtx?: number, beamSize?: number, captureId?: number | string, flashAttn?: boolean, freqThreshold?: number, keepContext?: boolean, keepMs?: number, language?: string, lengthMs?: number, mode?: 'step' | 'vad', noFallback?: boolean, stepMs?: number, threads?: number, useGpu?: boolean, vadThreshold?: number, chunkSeconds?: number }, WebSocketClass?: typeof WebSocket }} options Runner options.
 * @returns {Promise<void>}
 */
export async function runSttObserver(options) {
  const logger = options.logger ?? createNoopLogger();
  const spawnPersistent = options.createSubprocess ?? createSubprocess;
  const delayFn = options.delayFn ?? (async (delayMs, signal) => {
    await delay(delayMs, undefined, { signal });
  });
  const WebSocketClass = options.WebSocketClass ?? WebSocket;
  const nowFn = options.nowFn ?? Date.now;
  const restartDelayMs = options.restartDelayMs ?? 1000;
  const signal = options.signal;
  const whisperArgs = buildCommandArgs(options.stt, normalizeChunkInput(options.chunkInput));
  let lastTranscript = '';

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
          let child = null;

          try {
            const parser = buildParser(options.stt);
            let capturedStderr = '';
            let publishedThisRun = false;
            let stopReason = null;

            function publishEvent(event) {
              if (!shouldPublishTranscript(lastTranscript, event.text)) {
                return;
              }

              if (!isSocketOpen(socket, WebSocketClass)) {
                stopReason = new WhisperStreamError('Hub socket is not open');
                closeProcess(child);
                return;
              }

              lastTranscript = event.text;
              publishedThisRun = true;
              sendJson(socket, {
                type: 'transcript',
                source: 'whisper',
                text: event.text,
                capturedAtMs: nowFn() - estimateTranscriptLagMs(options.stt, event),
              });

              if (options.once) {
                stopReason = { type: 'once-complete' };
                closeProcess(child);
              }
            }

            child = spawnPersistent(options.stt.whisperBin, whisperArgs, { signal });
            child.stdout.setEncoding?.('utf8');
            child.stderr.setEncoding?.('utf8');
            child.stderr.on('data', (chunk) => {
              capturedStderr += String(chunk ?? '');
            });
            child.stdout.on('data', (chunk) => {
              for (const event of parser.push(String(chunk ?? ''))) {
                publishEvent(event);
              }
            });

            let exitResult = null;

            try {
              exitResult = await child.result;
            } catch (error) {
              for (const event of parser.flush()) {
                publishEvent(event);
              }

              if (stopReason?.type === 'once-complete' && publishedThisRun) {
                logger.info('STT observer completed');
                return;
              }

              if (stopReason instanceof WhisperStreamError) {
                throw new WhisperStreamError(stopReason.message, { cause: error, stderr: capturedStderr });
              }

              // Abort errors must keep their identity: the enclosing catch
              // relies on the error name to stop the retry loop cleanly.
              if (capturedStderr !== '' && !isAbortError(error)) {
                throw new WhisperStreamError(errorMessage(error), { cause: error, stderr: capturedStderr });
              }

              throw error;
            }

            for (const event of parser.flush()) {
              publishEvent(event);
            }

            if (stopReason?.type === 'once-complete' && publishedThisRun) {
              logger.info('STT observer completed');
              return;
            }

            if (stopReason instanceof WhisperStreamError) {
              throw new WhisperStreamError(stopReason.message, { stderr: exitResult?.stderr ?? capturedStderr });
            }

            if (!signal?.aborted) {
              throw new WhisperStreamError(
                exitResult?.stderr?.trim() || capturedStderr.trim() || 'whisper-stream exited unexpectedly',
                { stderr: exitResult?.stderr ?? capturedStderr },
              );
            }
          } catch (error) {
            if (isAbortError(error)) {
              break;
            }

            if (options.once) {
              throw error;
            }

            if (!isSocketOpen(socket, WebSocketClass)) {
              logger.warn('STT hub connection dropped; reconnecting', errorDiagnostics(error));
              break;
            }

            logger.warn('STT stream failed; retrying', errorDiagnostics(error));
            await waitForRetry(delayFn, restartDelayMs, signal);
          } finally {
            if (child !== null) {
              closeProcess(child);
            }
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          break;
        }

        if (options.once) {
          throw error;
        }

        logger.warn('STT hub connection failed; retrying', errorDiagnostics(error));
        await waitForRetry(delayFn, restartDelayMs, signal);
      } finally {
        if (socket !== null) {
          closeSocket(socket);
        }
      }
    }

    logger.info('STT observer stopped');
  } catch (error) {
    if (isAbortError(error)) {
      logger.info('STT observer stopped');
      return;
    }

    throw error;
  }
}
