import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  readVersion, bumpVersion, setVersion, formatVersion, assertSemver, versionPath, SEMVER_RE,
} from '../src/lib/version-file.mjs';
import { UserError } from '../src/lib/errors.mjs';
import { tmpProject, cleanup, versionJson } from './helpers.mjs';

after(cleanup);

test('reads a well-formed version.json', () => {
  const dir = tmpProject({ 'version.json': versionJson(1, 2, 3) });
  assert.deepEqual(readVersion(dir), { major: 1, minor: 2, patch: 3 });
  assert.equal(formatVersion(readVersion(dir)), '1.2.3');
});

test('a missing version.json is a UserError naming the path', () => {
  const dir = tmpProject();
  assert.throws(() => readVersion(dir), (e) => e instanceof UserError && e.message.includes('version.json'));
});

test('malformed JSON is a UserError, not a raw SyntaxError', () => {
  const dir = tmpProject({ 'version.json': '{not json' });
  assert.throws(() => readVersion(dir), (e) => e instanceof UserError && /Failed to parse/.test(e.message));
});

test('a JSON array or scalar is rejected', () => {
  for (const body of ['[1,2,3]', '"1.2.3"', 'null']) {
    const dir = tmpProject({ 'version.json': body });
    assert.throws(() => readVersion(dir), UserError, `accepted ${body}`);
  }
});

test('non-integer, negative and missing fields are rejected before any build runs', () => {
  const bad = [
    { major: 1.5, minor: 0, patch: 0 },
    { major: -1, minor: 0, patch: 0 },
    { major: 1, minor: 0 },
    { major: '1', minor: 0, patch: 0 },
    { major: 1, minor: null, patch: 0 },
    { major: 1, minor: 0, patch: NaN },
  ];
  for (const v of bad) {
    const dir = tmpProject({ 'version.json': JSON.stringify(v) });
    assert.throws(() => readVersion(dir), UserError, `accepted ${JSON.stringify(v)}`);
  }
});

test('bump increments patch and writes a trailing newline', () => {
  const dir = tmpProject({ 'version.json': versionJson(0, 0, 1) });
  assert.equal(formatVersion(bumpVersion(dir)), '0.0.2');
  const raw = readFileSync(versionPath(dir), 'utf8');
  assert.equal(raw, '{"major":0,"minor":0,"patch":2}\n');
});

test('bump rolls patch into minor at 100', () => {
  const dir = tmpProject({ 'version.json': versionJson(1, 4, 99) });
  assert.equal(formatVersion(bumpVersion(dir)), '1.5.0');
});

test('bump carries twice: 1.99.99 -> 2.0.0', () => {
  const dir = tmpProject({ 'version.json': versionJson(1, 99, 99) });
  assert.equal(formatVersion(bumpVersion(dir)), '2.0.0');
});

test('bump preserves unrelated keys in version.json', () => {
  const dir = tmpProject({ 'version.json': JSON.stringify({ major: 0, minor: 0, patch: 0, note: 'keep me' }) });
  bumpVersion(dir);
  assert.equal(JSON.parse(readFileSync(versionPath(dir), 'utf8')).note, 'keep me');
});

test('a failed write leaves no temp file and no truncated version.json', () => {
  const dir = tmpProject({ 'version.json': versionJson(1, 0, 0) });
  chmodSync(dir, 0o500); // read+execute: rename and create both fail
  try {
    assert.throws(() => bumpVersion(dir));
    assert.deepEqual(readVersion(dir), { major: 1, minor: 0, patch: 0 });
    assert.deepEqual(readdirSync(dir), ['version.json']);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('setVersion writes an explicit version', () => {
  const dir = tmpProject({ 'version.json': versionJson(0, 0, 1) });
  assert.equal(formatVersion(setVersion(dir, '3.4.5')), '3.4.5');
  assert.deepEqual(readVersion(dir), { major: 3, minor: 4, patch: 5 });
});

test('setVersion rejects a non-SemVer string', () => {
  const dir = tmpProject({ 'version.json': versionJson() });
  assert.throws(() => setVersion(dir, '1.2'), UserError);
  assert.deepEqual(readVersion(dir), { major: 0, minor: 0, patch: 0 });
});

test('SEMVER_RE accepts strict versions only', () => {
  for (const good of ['0.0.0', '1.2.3', '10.20.30', '0.0.100']) {
    assert.ok(SEMVER_RE.test(good), `rejected ${good}`);
  }
  for (const bad of ['1.2', '1.2.3.4', '01.2.3', '1.02.3', 'v1.2.3', '1.2.3-rc1', '1.2.3+build', '', ' 1.2.3']) {
    assert.ok(!SEMVER_RE.test(bad), `accepted ${bad}`);
  }
});

test('assertSemver labels the offending flag', () => {
  assert.throws(() => assertSemver('nope', '--version'), (e) => /--version "nope"/.test(e.message));
  assert.equal(assertSemver('1.2.3'), '1.2.3');
});

test('versionPath joins onto the project root', () => {
  assert.equal(versionPath('/a/b'), join('/a/b', 'version.json'));
});
