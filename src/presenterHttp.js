import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { resolvePathWithinRoot } from './http/pathSafety.js';
import { createNoopLogger } from './logger.js';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Create the local presenter HTTP server.
 *
 * @param {{ assetsRoot: string, getProgramPreview?: () => { body: Buffer, etag: string, lastModified?: string } | null, getStatus(): Record<string, unknown>, host: string, logger?: import('./logger.js').Logger, presenterBootstrap: Record<string, unknown>, port: number }} options Server options.
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, getAddress(): { host: string, port: number } }}
 */
export function createPresenterHttpServer(options) {
  const logger = options.logger ?? createNoopLogger();
  let server = null;
  let address = { host: options.host, port: options.port };

  function resolveAssetPath(pathname) {
    const relative = pathname.replace(/^\/presenter\//, '');
    // The bare `/presenter/` root serves the index page; everything else is
    // resolved — and contained — by the shared path guard.
    const fallbackPath = relative === '' || relative === '.' ? 'index.html' : relative;

    return resolvePathWithinRoot(options.assetsRoot, fallbackPath);
  }

  async function handleRequest(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }

    const requestUrl = new URL(req.url, `http://${options.host}:${address.port}`);

    if (requestUrl.pathname === '/status.json') {
      const body = JSON.stringify(options.getStatus());
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      });
      if (req.method !== 'HEAD') {
        res.end(body);
        return;
      }

      res.end();
      return;
    }

    if (requestUrl.pathname === '/presenter/bootstrap.json') {
      const body = JSON.stringify(options.presenterBootstrap);
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      });
      if (req.method !== 'HEAD') {
        res.end(body);
        return;
      }

      res.end();
      return;
    }

    if (requestUrl.pathname === '/presenter/program.jpg') {
      const preview = options.getProgramPreview?.() ?? null;

      if (preview === null) {
        res.writeHead(503, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end('Preview unavailable');
        return;
      }

      if (req.headers['if-none-match'] === preview.etag) {
        res.writeHead(304, {
          'Cache-Control': 'no-store',
          ETag: preview.etag,
        });
        res.end();
        return;
      }

      const headers = {
        'Cache-Control': 'no-store',
        'Content-Type': 'image/jpeg',
        ETag: preview.etag,
      };

      if (typeof preview.lastModified === 'string') {
        headers['Last-Modified'] = preview.lastModified;
      }

      res.writeHead(200, headers);
      if (req.method !== 'HEAD') {
        res.end(preview.body);
        return;
      }

      res.end();
      return;
    }

    if (requestUrl.pathname === '/presenter') {
      res.writeHead(301, { Location: '/presenter/' });
      res.end();
      return;
    }

    if (!requestUrl.pathname.startsWith('/presenter/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const assetPath = resolveAssetPath(requestUrl.pathname);

    if (assetPath === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    try {
      const body = await readFile(assetPath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(assetPath)] ?? 'application/octet-stream',
      });
      if (req.method !== 'HEAD') {
        res.end(body);
        return;
      }

      res.end();
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
          logger.error('Presenter HTTP request failed', {
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

      logger.info('Presenter HTTP listening', address);
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

      logger.info('Presenter HTTP stopped');
    },
  };
}
