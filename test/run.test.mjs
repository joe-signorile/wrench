import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { run, runCapture, runBestEffort } from '../src/lib/run.mjs';
import { UserError } from '../src/lib/errors.mjs';
import { tmpProject, cleanup } from './helpers.mjs';

after(cleanup);

const NODE = process.execPath;
const quiet = { stdio: ['ignore', 'ignore', 'ignore'] };

test('a zero exit resolves', async () => {
  await run(NODE, ['-e', 'process.exit(0)'], quiet);
});

test('a non-zero exit rejects with the command, args and code', async () => {
  await assert.rejects(
    run(NODE, ['-e', 'process.exit(3)'], quiet),
    (e) => e instanceof UserError && e.message.includes('exited with code 3') && e.message.includes('-e'),
  );
});

test('being killed by a signal is reported as a signal, not an exit code', async () => {
  await assert.rejects(
    run(NODE, ['-e', 'process.kill(process.pid, "SIGKILL")'], quiet),
    (e) => e instanceof UserError && /killed by signal SIGKILL/.test(e.message),
  );
});

test('a missing command carries an install hint for known tools', async () => {
  await assert.rejects(
    run('terraform-does-not-exist', [], quiet),
    (e) => e instanceof UserError && /Command not found/.test(e.message),
  );
});

test('a non-executable file is a friendly permission error, not a raw EACCES', async () => {
  const dir = tmpProject();
  const script = join(dir, 'no-exec.sh');
  writeFileSync(script, '#!/bin/sh\nexit 0\n');
  chmodSync(script, 0o644); // readable, not executable
  await assert.rejects(
    run(script, [], quiet),
    (e) => e instanceof UserError && /Permission denied running/.test(e.message) && e.message.includes(script),
  );
});

test('runBestEffort swallows a failure', async () => {
  await runBestEffort(NODE, ['-e', 'process.exit(1)'], quiet);
  await runBestEffort('definitely-not-a-command', [], quiet);
});

test('runCapture returns trimmed stdout', async () => {
  const out = await runCapture(NODE, ['-e', 'console.log("  bucket-name  ")'], { stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out, 'bucket-name');
});

test('runCapture rejects on a non-zero exit even with output on stdout', async () => {
  await assert.rejects(
    runCapture(NODE, ['-e', 'console.log("partial"); process.exit(1)'], { stdio: ['ignore', 'pipe', 'ignore'] }),
    (e) => /exited with code 1/.test(e.message),
  );
});

test('runCapture decodes a multi-byte character split across chunk boundaries', async () => {
  // €  is E2 82 AC. Written as two separate chunks, concatenating raw Buffers
  // would produce replacement characters.
  const script = `
    process.stdout.write(Buffer.from([0xe2, 0x82]));
    setTimeout(() => process.stdout.write(Buffer.from([0xac])), 20);
  `;
  const out = await runCapture(NODE, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out, '€');
});

test('runCapture waits for stdout to close, not merely for exit', async () => {
  const script = 'process.stdout.write("x".repeat(200000))';
  const out = await runCapture(NODE, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out.length, 200000);
});

test('cwd is honoured', async () => {
  const out = await runCapture(NODE, ['-e', 'console.log(process.cwd())'], {
    cwd: '/tmp', stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.match(out, /tmp$/);
});
