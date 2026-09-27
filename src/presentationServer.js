import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { resolvePathWithinRoot } from './http/pathSafety.js';
import { createNoopLogger } from './logger.js';
import { resolvePresentationPaths } from './presentations.js';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Create the local static server for one presentation deck plus shared reveal assets.
 *
 * @param {{ cwd: string, host: string, logger?: import('./logger.js').Logger, port: number, presentationName: string }} options Server options.
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, getAddress(): { host: string, port: number } }}
 */
export function createPresentationServer(options) {
  const logger = options.logger ?? createNoopLogger();
  const presentation = resolvePresentationPaths({
    cwd: options.cwd,
    presentationName: options.presentationName,
  });
  const revealRoot = join(options.cwd, 'reveal');
  let server = null;
  let address = { host: options.host, port: options.port };

  async function handleRequest(req, res) {
    const requestUrl = new URL(req.url, `http://${options.host}:${address.port}`);

    if (requestUrl.pathname === '/') {
      res.writeHead(302, {
        Location: `/presentation/${presentation.name}/deck/index.html`,
      });
      res.end();
      return;
    }

    let filePath = null;

    if (requestUrl.pathname.startsWith(`/presentation/${presentation.name}/deck/`)) {
      filePath = resolvePathWithinRoot(
        presentation.deckRoot,
        requestUrl.pathname.replace(`/presentation/${presentation.name}/deck/`, ''),
      );
    } else if (requestUrl.pathname.startsWith('/reveal/')) {
      filePath = resolvePathWithinRoot(revealRoot, requestUrl.pathname.replace('/reveal/', ''));
    }

    if (filePath === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    try {
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  return {
    async start() {
      if (server !== null) {
        return;
      }

      server = createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
          logger.error('Presentation HTTP request failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal server error');
        });
      });

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, resolve);
      });

      const serverAddress = server.address();
      if (serverAddress !== null && typeof serverAddress !== 'string') {
        address = { host: serverAddress.address, port: serverAddress.port };
      }

      logger.info('Presentation HTTP listening', {
        ...address,
        presentationName: presentation.name,
      });
    },

    getAddress() {
      return address;
    },

    async stop() {
      if (server === null) {
        return;
      }

      const currentServer = server;
      server = null;

      await new Promise((resolve, reject) => {
        currentServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      logger.info('Presentation HTTP stopped');
    },
  };
}
