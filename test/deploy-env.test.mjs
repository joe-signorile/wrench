import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildDeployEnv, infraDir } from '../src/lib/deploy-env.mjs';

const project = {
  root: '/p',
  name: 'demo',
  displayName: 'Demo',
  accentColor: '#569cd6',
  distBudgetMb: null,
  subdomain: 'app',
};
const outputs = { bucket: 'demo-client-abc', distribution: 'E123' };
const config = { rootDomain: 'example.com', registryBucket: 'reg' };

test('infraDir hangs off the project root', () => {
  assert.equal(infraDir(project), join('/p', 'infra'));
});

test('terraform outputs and project config are passed through', () => {
  const env = buildDeployEnv(project, outputs, config);
  assert.equal(env.WRENCH_PROJECT_ROOT, '/p');
  assert.equal(env.WRENCH_S3_BUCKET, 'demo-client-abc');
  assert.equal(env.WRENCH_CF_DISTRIBUTION, 'E123');
  assert.equal(env.WRENCH_DISPLAY_NAME, 'Demo');
  assert.equal(env.WRENCH_ACCENT_COLOR, '#569cd6');
  assert.equal(env.WRENCH_PROJECT_NAME, 'demo');
  assert.equal(env.WRENCH_ROOT_DOMAIN, 'example.com');
  assert.equal(env.WRENCH_REGISTRY_BUCKET, 'reg');
});

test('the ambient environment is inherited, so AWS credentials survive', () => {
  const env = buildDeployEnv(project, outputs, config);
  assert.equal(env.PATH, process.env.PATH);
});

test('an apex site sets WRENCH_SUBDOMAIN to the empty string', () => {
  const env = buildDeployEnv({ ...project, subdomain: '' }, outputs, config);
  assert.ok('WRENCH_SUBDOMAIN' in env);
  assert.equal(env.WRENCH_SUBDOMAIN, '');
});

test('a site with no subdomain leaves WRENCH_SUBDOMAIN unset, not empty', () => {
  // Collapsing null to "" made unmigrated sites claim the apex URL in the
  // shared registry manifest.
  const env = buildDeployEnv({ ...project, subdomain: null }, outputs, config);
  assert.ok(!('WRENCH_SUBDOMAIN' in env));
});

test('an inherited WRENCH_SUBDOMAIN cannot leak in when the project has none', () => {
  const previous = process.env.WRENCH_SUBDOMAIN;
  process.env.WRENCH_SUBDOMAIN = 'stale';
  try {
    const env = buildDeployEnv({ ...project, subdomain: null }, outputs, config);
    assert.ok(!('WRENCH_SUBDOMAIN' in env));
  } finally {
    if (previous === undefined) delete process.env.WRENCH_SUBDOMAIN;
    else process.env.WRENCH_SUBDOMAIN = previous;
  }
});

test('unset wrench.config values become empty strings, never "null"', () => {
  const env = buildDeployEnv(project, outputs, { rootDomain: null, registryBucket: null });
  assert.equal(env.WRENCH_ROOT_DOMAIN, '');
  assert.equal(env.WRENCH_REGISTRY_BUCKET, '');
});

test('a package without a name still produces a string project name', () => {
  const env = buildDeployEnv({ ...project, name: undefined }, outputs, config);
  assert.equal(env.WRENCH_PROJECT_NAME, '');
});
