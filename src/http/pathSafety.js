import { isAbsolute, join, normalize, relative, sep } from 'node:path';

/**
 * Resolve an untrusted request path against a trusted root directory.
 *
 * Returns the joined absolute path when it stays inside `root`, and `null`
 * when it escapes `root` — including when it lands in a sibling directory
 * whose name merely shares a prefix with `root` (root `/srv/deck` vs target
 * `/srv/deck-secret/x`), which a plain `filePath.startsWith(root)` check
 * wrongly allows.
 *
 * @param {string} root Trusted directory the request path is served from.
 * @param {string} requestPath Untrusted request path, relative to `root`.
 * @returns {string | null} Absolute path inside `root`, or `null` when the path escapes it.
 */
export function resolvePathWithinRoot(root, requestPath) {
  const stripped = normalize(requestPath).replace(/^([/\\])+/, '');
  const filePath = join(root, stripped);
  const contained = relative(root, filePath);

  // `contained === ''` means the request resolves to the root directory
  // itself, which is never a servable file. `..` is matched against whole
  // segments so ordinary names like `..foo` stay allowed.
  if (contained === '' || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    return null;
  }

  return filePath;
}
