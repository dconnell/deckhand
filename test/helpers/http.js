import { request } from 'node:http';

/**
 * Send a GET whose request target goes over the wire exactly as written.
 * `fetch` normalizes `/a/../b` dot segments before they leave the client, so
 * only a raw `node:http` request can probe a server's path guard with an
 * unnormalized traversal path.
 *
 * @param {number} port Server port.
 * @param {string} requestPath Literal request target, dot segments included.
 * @returns {Promise<{ status: number | undefined, body: string }>} Response status and body.
 */
export function rawGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
