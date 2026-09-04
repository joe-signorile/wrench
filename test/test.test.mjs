import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpProject, cleanup, fakeBin, runCli, pkg } from './helpers.mjs';

after(cleanup);

nodeTest('shells out to npm test in the project root', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const log = join(dir, 'log.txt');
  const restore = fakeBin({ npm: 'echo "$@" >> "$LOGFILE"; pwd >> "$LOGFILE"' });
  try {
    const r = await runCli(dir, ['test'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    const [args, cwd] = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(args, 'test');
    assert.match(cwd, new RegExp(`${dir}$`));
  } finally { restore(); }
});

nodeTest('a failing npm test propagates as a non-zero exit', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const restore = fakeBin({ npm: 'exit 7' });
  try {
    const r = await runCli(dir, ['test']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /exited with code 7/);
  } finally { restore(); }
});

nodeTest('extra arguments are rejected', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const r = await runCli(dir, ['test', 'extra']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: wrench test/);
});
