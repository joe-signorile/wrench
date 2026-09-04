import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpProject, cleanup, fakeBin, runCli, pkg, versionJson } from './helpers.mjs';

after(cleanup);

test('bumps the version, runs npm test best-effort, then npm run dev', async () => {
  const dir = tmpProject({
    'package.json': pkg(null, { scripts: { dev: 'vite' } }),
    'version.json': versionJson(0, 0, 5),
  });
  const log = join(dir, 'log.txt');
  const restore = fakeBin({ npm: 'echo "npm $@" >> "$LOGFILE"' });
  try {
    const r = await runCli(dir, ['dev'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'v0.0.6');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')), { major: 0, minor: 0, patch: 6 });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['npm test', 'npm run dev']);
  } finally { restore(); }
});

test('a failing npm test does not block npm run dev from starting', async () => {
  const dir = tmpProject({
    'package.json': pkg(null, { scripts: { dev: 'vite' } }),
    'version.json': versionJson(0, 0, 0),
  });
  const log = join(dir, 'log.txt');
  const restore = fakeBin({ npm: 'echo "npm $@" >> "$LOGFILE"; [ "$1" = test ] && exit 1; exit 0' });
  try {
    const r = await runCli(dir, ['dev'], { LOGFILE: log });
    assert.equal(r.code, 0, r.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['npm test', 'npm run dev']);
  } finally { restore(); }
});

test('no "dev" script in package.json is a UserError', async () => {
  const dir = tmpProject({
    'package.json': pkg(),
    'version.json': versionJson(0, 0, 0),
  });
  const restore = fakeBin({ npm: 'exit 0' });
  try {
    const r = await runCli(dir, ['dev']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No "dev" script in package\.json/);
  } finally { restore(); }
});

test('extra arguments are rejected', async () => {
  const dir = tmpProject({ 'package.json': pkg(), 'version.json': versionJson() });
  const r = await runCli(dir, ['dev', 'extra']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: wrench dev/);
});
