import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { resolvePathWithinRoot } from '../../../src/http/pathSafety.js';

function rootFor(...segments) {
  return path.join(path.sep, 'srv', 'deckhand', ...segments);
}

test('resolvePathWithinRoot resolves simple request paths inside the root', () => {
  const root = rootFor('deck');

  assert.equal(resolvePathWithinRoot(root, 'index.html'), path.join(root, 'index.html'));
  assert.equal(resolvePathWithinRoot(root, '/nested/deck.css'), path.join(root, 'nested', 'deck.css'));
  assert.equal(resolvePathWithinRoot(root, 'nested/../index.html'), path.join(root, 'index.html'));
});

test('resolvePathWithinRoot rejects request paths that escape the root', () => {
  const root = rootFor('deck');

  assert.equal(resolvePathWithinRoot(root, '../config.json'), null);
  assert.equal(resolvePathWithinRoot(root, '..'), null);
  assert.equal(resolvePathWithinRoot(root, '.'), null);
  assert.equal(resolvePathWithinRoot(root, ''), null);
  // `normalize` clamps leading dot segments at the filesystem root, so even
  // absolute-looking deep escapes resolve back inside the root.
  assert.equal(resolvePathWithinRoot(root, '/deck/../../../config.json'), path.join(root, 'config.json'));
});

test('resolvePathWithinRoot rejects sibling directories whose names share a prefix with the root', () => {
  // Regression guard for the old `filePath.startsWith(root)` check: root
  // `/srv/deckhand/deck` and target `/srv/deckhand/deck-secret/config.json`
  // merely share a text prefix, so the old check served the sibling file.
  const root = rootFor('deck');

  assert.equal(resolvePathWithinRoot(root, '../deck-secret/config.json'), null);
  assert.equal(resolvePathWithinRoot(root, '../deck-secret/nested/config.json'), null);
});

test('resolvePathWithinRoot contains absolute-looking request paths inside the root', () => {
  const root = rootFor('deck');

  assert.equal(resolvePathWithinRoot(root, '/config.json'), path.join(root, 'config.json'));
  assert.equal(resolvePathWithinRoot(root, '/etc/passwd'), path.join(root, 'etc', 'passwd'));
});

test('resolvePathWithinRoot allows root-local names that merely start with dot segments', () => {
  // `..foo` is an ordinary file name; only a whole `..` segment may escape.
  const root = rootFor('deck');

  assert.equal(resolvePathWithinRoot(root, '..foo'), path.join(root, '..foo'));
});
