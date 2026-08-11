import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubprocess, runSubprocess, SubprocessError } from '../../../../src/presenter/stt/subprocess.js';

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

test('createSubprocess streams stdout and stderr incrementally and reports clean exit', async () => {
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = createSubprocess(process.execPath, ['-e', 'process.stdout.write("hel"); setTimeout(() => process.stdout.write("lo"), 10); process.stderr.write("warn"); setTimeout(() => process.exit(0), 20);']);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk);
  });

  const result = await child.result;

  assert.deepEqual(stdoutChunks, ['hel', 'lo']);
  assert.deepEqual(stderrChunks, ['warn']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, 'warn');
});

test('createSubprocess exposes failed exits as SubprocessError with captured output', async () => {
  const child = createSubprocess(process.execPath, ['-e', 'process.stdout.write("partial"); process.stderr.write("boom"); process.exit(5);']);

  await assert.rejects(
    () => child.result,
    (error) => {
      assert.ok(error instanceof SubprocessError);
      assert.equal(error.exitCode, 5);
      assert.equal(error.stdout, 'partial');
      assert.equal(error.stderr, 'boom');
      return true;
    },
  );
});

test('createSubprocess aborts the child process through the provided signal', async () => {
  const controller = new AbortController();
  const child = createSubprocess(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("late"), 200);'], {
    signal: controller.signal,
  });

  controller.abort();

  await assert.rejects(
    () => child.result,
    (error) => error instanceof Error && error.name === 'AbortError',
  );
});
