import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudget, resolveBudget } from '../src/commands/budget.mjs';
import { tmpProject, cleanup } from './helpers.mjs';

after(cleanup);

function captureConsole(fn) {
  const lines = [];
  const log = mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  const warn = mock.method(console, 'warn', (...a) => lines.push(a.join(' ')));
  try { fn(); } finally { log.mock.restore(); warn.mock.restore(); }
  return lines.join('\n');
}

const mb = (n) => 'x'.repeat(n * 1024 * 1024);

test('resolveBudget prefers the project setting over the env var', () => {
  assert.equal(resolveBudget(4, '99'), 4);
});

test('resolveBudget reads the env var when the project sets nothing', () => {
  assert.equal(resolveBudget(null, '7'), 7);
});

test('resolveBudget defaults to 15 MB when neither is set', () => {
  assert.equal(resolveBudget(null, undefined), 15);
  assert.equal(resolveBudget(null, ''), 15);
});

test('a malformed DIST_BUDGET_MB falls back to the default instead of silently passing', () => {
  for (const bad of ['abc', '-3', '0', 'NaN']) {
    const out = captureConsole(() => assert.equal(resolveBudget(null, bad), 15));
    assert.match(out, /isn't a positive number/);
  }
});

test('reports under budget', () => {
  const dir = tmpProject({ 'dist/index.html': 'hi' });
  const out = captureConsole(() => checkBudget(dir, 15, {}));
  assert.match(out, /under the 15 MB advisory budget/);
});

test('reports over budget and names the largest files, biggest first', () => {
  const dir = tmpProject({
    'dist/index.html': 'hi',
    'dist/assets/small.js': mb(1),
    'dist/assets/nested/big.wasm': mb(3),
  });
  const out = captureConsole(() => checkBudget(dir, 2, {}));
  assert.match(out, /dist\/ is 4\.0 MB, over the 2 MB advisory budget/);
  const big = out.indexOf('dist/assets/nested/big.wasm');
  const small = out.indexOf('dist/assets/small.js');
  assert.ok(big !== -1 && small !== -1 && big < small, 'largest file should be listed first');
});

test('paths are reported relative to the project root', () => {
  const dir = tmpProject({ 'dist/a.js': mb(2) });
  const out = captureConsole(() => checkBudget(dir, 1, {}));
  assert.match(out, /\n {5}2\.00 MB {2}dist\/a\.js/);
  assert.ok(!out.includes(dir), 'should not leak the absolute path');
});

test('a missing dist/ is skipped, not an error', () => {
  const dir = tmpProject({ 'package.json': '{}' });
  const out = captureConsole(() => checkBudget(dir, 15, {}));
  assert.match(out, /dist\/ not found — skipping/);
});

test('the env var is honoured when the project sets no budget', () => {
  const dir = tmpProject({ 'dist/a.js': mb(2) });
  const out = captureConsole(() => checkBudget(dir, null, { DIST_BUDGET_MB: '1' }));
  assert.match(out, /over the 1 MB advisory budget/);
});

test('nested directories are summed', () => {
  const dir = tmpProject({ 'dist/a/b/c/x': mb(1), 'dist/y': mb(1) });
  const out = captureConsole(() => checkBudget(dir, 15, {}));
  assert.match(out, /dist\/ is 2\.0 MB/);
});
