import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpProject, cleanup, fakeBin, runCli, pkg, versionJson } from './helpers.mjs';

after(cleanup);

// terraform stands in only far enough to answer the two `output -raw` calls
// deployEnv() makes; python3 stands in for build_tools.py and logs what it
// was called with, so tests can assert on the arguments wrench passed through.
function stubs() {
  return {
    terraform: [
      'eval last=\\${$#}',
      'case "$last" in',
      '  bucket_name) echo test-bucket ;;',
      '  cloudfront_distribution_id) echo E123 ;;',
      'esac',
    ].join('\n'),
    python3: 'shift; echo "$@" >> "$LOGFILE"',
  };
}

test('promote with an explicit version skips version.json entirely', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const log = join(dir, 'log.txt');
  const restore = fakeBin(stubs());
  try {
    const r = await runCli(dir, ['promote', '1.2.3'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(log, 'utf8').trim(), 'promote --version 1.2.3');
  } finally { restore(); }
});

test('promote with no argument reads the version from version.json', async () => {
  const dir = tmpProject({ 'package.json': pkg(), 'version.json': versionJson(0, 4, 2) });
  const log = join(dir, 'log.txt');
  const restore = fakeBin(stubs());
  try {
    const r = await runCli(dir, ['promote'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(log, 'utf8').trim(), 'promote --version 0.4.2');
  } finally { restore(); }
});

test('promote with no version and no version.json is a UserError', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const restore = fakeBin(stubs());
  try {
    const r = await runCli(dir, ['promote']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No version\.json found/);
  } finally { restore(); }
});

test('promote rejects more than one argument', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const r = await runCli(dir, ['promote', '1.2.3', 'extra']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: wrench promote \[version\]/);
});

test('list rejects any argument', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const r = await runCli(dir, ['list', 'extra']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: wrench list/);
});

test('list shells through to build_tools.py list', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const log = join(dir, 'log.txt');
  const restore = fakeBin(stubs());
  try {
    const r = await runCli(dir, ['list'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(log, 'utf8').trim(), 'list');
  } finally { restore(); }
});
