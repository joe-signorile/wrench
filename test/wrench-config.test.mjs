import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadWrenchConfig } from '../src/lib/wrench-config.mjs';
import { UserError } from '../src/lib/errors.mjs';
import { tmpProject, cleanup } from './helpers.mjs';

after(cleanup);

test('a missing config file yields nulls, not a throw', () => {
  assert.deepEqual(loadWrenchConfig(tmpProject()), { rootDomain: null, registryBucket: null });
});

test('a valid config is read through', () => {
  const dir = tmpProject({
    'wrench.config.json': JSON.stringify({ rootDomain: 'example.com', registryBucket: 'reg' }),
  });
  assert.deepEqual(loadWrenchConfig(dir), { rootDomain: 'example.com', registryBucket: 'reg' });
});

test('malformed JSON is a UserError naming the file', () => {
  const dir = tmpProject({ 'wrench.config.json': '{' });
  assert.throws(() => loadWrenchConfig(dir), (e) => e instanceof UserError && /wrench\.config\.json/.test(e.message));
});

test('a non-object config is rejected', () => {
  const dir = tmpProject({ 'wrench.config.json': '["example.com"]' });
  assert.throws(() => loadWrenchConfig(dir), UserError);
});

test('absent keys normalise to null', () => {
  const dir = tmpProject({ 'wrench.config.json': '{}' });
  assert.deepEqual(loadWrenchConfig(dir), { rootDomain: null, registryBucket: null });
});
