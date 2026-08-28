import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasBuildScript, buildScriptPath } from '../src/lib/detect.mjs';
import { UserError } from '../src/lib/errors.mjs';
import { tmpProject, cleanup } from './helpers.mjs';

after(cleanup);

test('no build.sh means no passthrough', () => {
  assert.equal(hasBuildScript(tmpProject()), false);
});

test('an executable build.sh is a passthrough target', () => {
  const dir = tmpProject({ 'build.sh': '#!/bin/sh\ntrue\n' });
  chmodSync(buildScriptPath(dir), 0o755);
  assert.equal(hasBuildScript(dir), true);
});

test('a non-executable build.sh is called out rather than failing inside spawn', () => {
  const dir = tmpProject({ 'build.sh': '#!/bin/sh\ntrue\n' });
  chmodSync(buildScriptPath(dir), 0o644);
  assert.throws(() => hasBuildScript(dir), (e) => e instanceof UserError && /chmod \+x/.test(e.message));
});

test('a directory named build.sh is rejected', () => {
  const dir = tmpProject();
  mkdirSync(join(dir, 'build.sh'));
  assert.throws(() => hasBuildScript(dir), (e) => e instanceof UserError && /not a regular file/.test(e.message));
});
