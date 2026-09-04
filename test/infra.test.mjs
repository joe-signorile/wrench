import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpProject, cleanup, fakeBin, runCli, pkg } from './helpers.mjs';

after(cleanup);

test('apply passes -auto-approve; plan does not', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const log = join(dir, 'log.txt');
  const restore = fakeBin({ terraform: 'echo "$@" >> "$LOGFILE"' });
  try {
    const r = await runCli(dir, ['infra', 'apply'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    const [init, apply] = readFileSync(log, 'utf8').trim().split('\n');
    assert.match(init, /init -input=false/);
    assert.match(apply, /apply -auto-approve$/);
  } finally { restore(); }
});

test('plan does not get -auto-approve appended', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const log = join(dir, 'log.txt');
  const restore = fakeBin({ terraform: 'echo "$@" >> "$LOGFILE"' });
  try {
    const r = await runCli(dir, ['infra', 'plan'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    const [, plan] = readFileSync(log, 'utf8').trim().split('\n');
    assert.match(plan, / plan$/);
  } finally { restore(); }
});

test('extra arguments after the subcommand are forwarded to terraform', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const log = join(dir, 'log.txt');
  const restore = fakeBin({ terraform: 'echo "$@" >> "$LOGFILE"' });
  try {
    const r = await runCli(dir, ['infra', 'output', 'bucket_name'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    const [, output] = readFileSync(log, 'utf8').trim().split('\n');
    assert.match(output, / output bucket_name$/);
  } finally { restore(); }
});
