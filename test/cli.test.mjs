import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpProject, cleanup, cliPath, repoRoot, pkg, versionJson, fakeBin } from './helpers.mjs';

const exec = promisify(execFile);
after(cleanup);

// Runs the real entrypoint and reports the exit code rather than throwing, so
// each test can assert on status, stdout and stderr together.
async function wrench(cwd, args = [], env = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliPath, ...args], {
      cwd, env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('--help prints usage and exits 0', async () => {
  const r = await wrench(repoRoot, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /wrench \[command\]/);
  assert.match(r.stdout, /build \[--clean\]/);
});

test('-h is the same as --help', async () => {
  assert.equal((await wrench(repoRoot, ['-h'])).stdout, (await wrench(repoRoot, ['--help'])).stdout);
});

test('--version prints wrench\'s own package version', async () => {
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const r = await wrench(repoRoot, ['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), `wrench ${version}`);
});

test('a directory with neither build.sh nor package.json exits 1 with usage', async () => {
  const r = await wrench(tmpProject(), []);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no build\.sh and no package\.json/);
  assert.match(r.stderr, /wrench \[command\]/);
});

test('an unknown command exits 1 and names the command', async () => {
  const r = await wrench(tmpProject({ 'package.json': pkg() }), ['bogus']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unknown command: bogus/);
});

test('a wrench-native project is never prompted and never mentions build.sh', async () => {
  // The regression this guards: every deploy used to print "No build.sh found"
  // and then block on a [Y/n] prompt.
  const dir = tmpProject({ 'package.json': pkg(), 'version.json': versionJson() });
  const r = await wrench(dir, ['version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'v0.0.0');
  assert.ok(!/build\.sh/.test(r.stdout + r.stderr));
});

test('build.sh takes priority and receives the full argument list', async () => {
  const dir = tmpProject({
    'build.sh': '#!/bin/sh\necho "legacy: $*"\n',
    'package.json': pkg(),
    'version.json': versionJson(),
  });
  chmodSync(join(dir, 'build.sh'), 0o755);
  const r = await wrench(dir, ['deploy', '--force', '--version', '1.2.3']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /exec .*build\.sh/, 'should announce the executable it hands control to');
  assert.match(r.stdout, /legacy: deploy --force --version 1\.2\.3/);
});

test('version bump writes through to version.json', async () => {
  const dir = tmpProject({ 'package.json': pkg(), 'version.json': versionJson(1, 2, 3) });
  const r = await wrench(dir, ['version', 'bump']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'v1.2.4');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')), { major: 1, minor: 2, patch: 4 });
});

test('version rejects an unknown subcommand', async () => {
  const dir = tmpProject({ 'package.json': pkg(), 'version.json': versionJson() });
  const r = await wrench(dir, ['version', 'bumpp']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: wrench version \[bump\]/);
});

test('infra requires a known subcommand', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const r = await wrench(dir, ['infra']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: wrench infra <plan\|apply\|output>/);

  const bad = await wrench(dir, ['infra', 'destroy']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Usage: wrench infra/);
});

test('infra does not demand version.json', async () => {
  // It used to fail with "No version.json found", which was never the problem.
  const dir = tmpProject({ 'package.json': pkg() });
  const r = await wrench(dir, ['infra', 'plan']);
  assert.ok(!/version\.json/.test(r.stderr), r.stderr);
});

test('a deliberate error prints a bare message, with no stack', async () => {
  const r = await wrench(tmpProject(), []);
  assert.ok(!/ at .*\.mjs:\d+/.test(r.stderr), 'UserError should not print a stack');
});

test('deploy validates its flags before touching version.json', async () => {
  const dir = tmpProject({ 'package.json': pkg(), 'version.json': versionJson(0, 0, 7) });
  const r = await wrench(dir, ['deploy', '--version', 'not-semver']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /isn't strict SemVer/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')), { major: 0, minor: 0, patch: 7 });
});

test('no command at all means deploy', async () => {
  const dir = tmpProject({ 'package.json': pkg(), 'version.json': versionJson(0, 0, 3) });
  const restore = fakeBin({ npm: 'exit 1' }); // fail fast, before terraform — just prove deploy ran
  try {
    const r = await wrench(dir, []);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /v0\.0\.4/, 'deploy should have bumped and printed the version');
  } finally { restore(); }
});

test('build runs through the CLI dispatcher', async () => {
  const dir = tmpProject({ 'package.json': pkg() });
  const restore = fakeBin({ npm: 'mkdir -p dist && echo hi > dist/index.html' });
  try {
    const r = await wrench(dir, ['build']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'dist', 'index.html')));
  } finally { restore(); }
});

test('a bug in wrench (not a UserError) prints a full stack, not a bare message', async () => {
  // writeVersion() re-throws raw fs errors (not UserError) when the atomic
  // rename-into-place fails. Make the project dir unwritable so the tmp-file
  // write inside `wrench version bump` fails with a raw EACCES, and exercise
  // the CLI's "not a UserError" branch.
  const dir = tmpProject({ 'package.json': pkg(), 'version.json': versionJson() });
  chmodSync(dir, 0o500);
  try {
    const r = await wrench(dir, ['version', 'bump']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, / at .*\.mjs:\d+/, 'a real bug should print its stack');
  } finally { chmodSync(dir, 0o755); }
});

test('deploy refuses a corrupt version.json before running the build', async () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'touch BUILD_RAN' } }),
    'version.json': JSON.stringify({ major: 1.5, minor: 0, patch: 0 }),
  });
  const r = await wrench(dir, ['deploy']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"major" must be a non-negative integer/);
  assert.ok(!existsSync(join(dir, 'BUILD_RAN')), 'the build must not have run');
});
