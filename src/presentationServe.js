import { parsePresentationCliArgs } from './presentations.js';
import { createPresentationServer } from './presentationServer.js';

function normalizePort(value) {
  if (value === undefined) {
    return Number(process.env.PORT ?? 3000);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new TypeError('--port must be an integer between 1 and 65535');
  }

  return parsed;
}

function isMainModule(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === new URL(`file://${process.argv[1]}`).href;
}

/**
 * Serve one named presentation deck plus shared reveal assets.
 *
 * @param {{ args?: string[], cwd?: string }} [options] CLI options.
 * @returns {Promise<number>}
 */
export async function runPresentationServe(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  let parsed;

  try {
    parsed = parsePresentationCliArgs({
      args,
      options: {
        port: { type: 'string' },
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const server = createPresentationServer({
    cwd,
    host: '127.0.0.1',
    logger: console,
    port: normalizePort(parsed.values.port),
    presentationName: parsed.presentationName,
  });

  try {
    await server.start();
    const address = server.getAddress();
    console.log(`Deckhand presentation: http://${address.host}:${address.port}/presentation/${parsed.presentationName}/deck/index.html`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  const exitCode = await runPresentationServe();
  process.exitCode = exitCode;
}
