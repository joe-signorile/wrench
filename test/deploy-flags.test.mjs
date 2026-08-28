import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../src/commands/deploy.mjs';
import { parseBuildFlags } from '../src/commands/build.mjs';
import { UserError } from '../src/lib/errors.mjs';

test('no arguments means no flags', () => {
  assert.deepEqual(parseFlags([]), { force: false, clean: false, version: null });
  assert.deepEqual(parseFlags(), { force: false, clean: false, version: null });
});

test('each flag is recognised, in any order', () => {
  assert.equal(parseFlags(['--force']).force, true);
  assert.equal(parseFlags(['--clean']).clean, true);
  assert.deepEqual(parseFlags(['--clean', '--version', '1.2.3', '--force']), {
    force: true, clean: true, version: '1.2.3',
  });
});

test('an unknown argument is rejected rather than silently ignored', () => {
  // The whole point: `--forse` used to deploy without force, quietly.
  for (const bad of ['--forse', '-f', 'extra', '--version=1.2.3']) {
    assert.throws(() => parseFlags([bad]), (e) => e instanceof UserError && e.message.includes(bad));
  }
});

test('--version with no value is rejected instead of falling back to a bump', () => {
  assert.throws(() => parseFlags(['--version']), (e) => /--version needs a value/.test(e.message));
  assert.throws(() => parseFlags(['--force', '--version']), UserError);
});

test('--version must be strict SemVer', () => {
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-rc1', '01.2.3']) {
    assert.throws(() => parseFlags(['--version', bad]), (e) => /isn't strict SemVer/.test(e.message));
  }
});

test('--version swallows its value rather than parsing it as a flag', () => {
  assert.deepEqual(parseFlags(['--version', '1.2.3']), { force: false, clean: false, version: '1.2.3' });
});

test('build accepts only --clean', () => {
  assert.deepEqual(parseBuildFlags([]), { clean: false });
  assert.deepEqual(parseBuildFlags(['--clean']), { clean: true });
  assert.throws(() => parseBuildFlags(['--clea']), (e) => e instanceof UserError && /--clea/.test(e.message));
  assert.throws(() => parseBuildFlags(['--force']), UserError);
});
