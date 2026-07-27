import assert from 'node:assert/strict';
import test from 'node:test';

import { runSubprocess, SubprocessError } from '../../../../src/presenter/stt/subprocess.js';

test('runSubprocess captures stdout from a successful child process', async () => {
  const result = await runSubprocess(process.execPath, ['-e', 'process.stdout.write("ok")']);

  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 0);
});

test('runSubprocess surfaces non-zero exits with stderr context', async () => {
  await assert.rejects(
    () => runSubprocess(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3);']),
    (error) => {
      assert.ok(error instanceof SubprocessError);
      assert.equal(error.exitCode, 3);
      assert.equal(error.stderr, 'boom');
      assert.match(error.message, /exit code 3/i);
      return true;
    },
  );
});
