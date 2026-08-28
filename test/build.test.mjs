import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from '../src/commands/build.mjs';
import { UserError } from '../src/lib/errors.mjs';
import { tmpProject, cleanup } from './helpers.mjs';

// Stand in for npm so these tests exercise build()'s own logic — the dist/
// wipe, the index.html check, the budget hand-off — without a real toolchain.
function fakeNpm(script) {
  const bin = tmpProject({ npm: `#!/bin/sh\n${script}\n` });
  chmodSync(join(bin, 'npm'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  return () => { process.env.PATH = previous; };
}

function silence() {
  const log = mock.method(console, 'log', () => {});
  const warn = mock.method(console, 'warn', () => {});
  return () => { log.mock.restore(); warn.mock.restore(); };
}

const project = (root) => ({ root, name: 'demo', displayName: 'Demo', accentColor: '#569cd6', distBudgetMb: null, subdomain: null });

after(cleanup);

test('runs npm run build and accepts a dist/ with an index.html', async () => {
  const dir = tmpProject();
  const restorePath = fakeNpm('mkdir -p dist && echo hi > dist/index.html');
  const restoreLog = silence();
  try {
    await build({}, project(dir));
    assert.ok(existsSync(join(dir, 'dist', 'index.html')));
  } finally { restoreLog(); restorePath(); }
});

test('a build that produces no index.html is a UserError', async () => {
  const dir = tmpProject();
  const restorePath = fakeNpm('mkdir -p dist && echo hi > dist/other.txt');
  const restoreLog = silence();
  try {
    await assert.rejects(build({}, project(dir)), (e) => e instanceof UserError && /dist\/index\.html not found/.test(e.message));
  } finally { restoreLog(); restorePath(); }
});

test('a failing npm run build propagates and never reaches the dist check', async () => {
  const dir = tmpProject();
  const restorePath = fakeNpm('exit 2');
  const restoreLog = silence();
  try {
    await assert.rejects(build({}, project(dir)), (e) => /exited with code 2/.test(e.message));
  } finally { restoreLog(); restorePath(); }
});

test('--clean wipes dist/ before building, so stale files cannot survive', async () => {
  const dir = tmpProject();
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'assets', 'stale.js'), 'old');
  const restorePath = fakeNpm('mkdir -p dist && echo hi > dist/index.html');
  const restoreLog = silence();
  try {
    await build({ clean: true }, project(dir));
    assert.ok(!existsSync(join(dir, 'dist', 'assets', 'stale.js')), '--clean must remove the previous build');
    assert.ok(existsSync(join(dir, 'dist', 'index.html')));
  } finally { restoreLog(); restorePath(); }
});

test('without --clean, previous output is left in place', async () => {
  const dir = tmpProject();
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'stale.js'), 'old');
  const restorePath = fakeNpm('mkdir -p dist && echo hi > dist/index.html');
  const restoreLog = silence();
  try {
    await build({}, project(dir));
    assert.ok(existsSync(join(dir, 'dist', 'stale.js')));
  } finally { restoreLog(); restorePath(); }
});

test('--clean on a project with no dist/ yet is a no-op, not an error', async () => {
  const dir = tmpProject();
  const restorePath = fakeNpm('mkdir -p dist && echo hi > dist/index.html');
  const restoreLog = silence();
  try {
    await build({ clean: true }, project(dir));
    assert.ok(existsSync(join(dir, 'dist', 'index.html')));
  } finally { restoreLog(); restorePath(); }
});
