// The Node CLI and build_tools.py talk over environment variables. Nothing in
// either language checks the other's spelling, so a rename on one side would
// silently drop a value. This pins the seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDeployEnv } from '../src/lib/deploy-env.mjs';
import { repoRoot } from './helpers.mjs';

const Q = '"'.repeat(3);

const project = {
  root: '/p', name: 'demo', displayName: 'Demo', accentColor: '#569cd6',
  distBudgetMb: null, subdomain: 'app',
};

function nodeSets() {
  const withSubdomain = buildDeployEnv(project, { bucket: 'b', distribution: 'E1' },
    { rootDomain: 'example.com', registryBucket: 'reg' });
  return new Set(Object.keys(withSubdomain).filter((k) => k.startsWith('WRENCH_')));
}

function pythonReads() {
  const src = readFileSync(join(repoRoot, 'python', 'build_tools.py'), 'utf8');
  const config = src.slice(src.indexOf('def config_from_env'), src.indexOf('def _client'));
  return new Set([...config.matchAll(/"(WRENCH_[A-Z0-9_]+)"/g)].map((m) => m[1]));
}

test('every variable Node sets is one build_tools.py reads', () => {
  const unread = [...nodeSets()].filter((k) => !pythonReads().has(k));
  assert.deepEqual(unread, [], 'set by the CLI but never read by build_tools.py');
});

test('every variable build_tools.py reads is one Node sets', () => {
  const unset = [...pythonReads()].filter((k) => !nodeSets().has(k));
  assert.deepEqual(unset, [], 'read by build_tools.py but never set by the CLI');
});

test('the documented variables match the ones actually read', () => {
  const src = readFileSync(join(repoRoot, 'python', 'build_tools.py'), 'utf8');
  const open = src.indexOf(Q);
  const docblock = src.slice(open, src.indexOf(Q, open + 3));
  for (const name of pythonReads()) {
    assert.ok(docblock.includes(name), `${name} is read but undocumented`);
  }
});
