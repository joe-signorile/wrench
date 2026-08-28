import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadProject } from '../src/context.mjs';
import { UserError } from '../src/lib/errors.mjs';
import { tmpProject, cleanup, pkg, versionJson } from './helpers.mjs';

after(cleanup);

test('missing package.json is a UserError naming the directory', () => {
  const dir = tmpProject();
  assert.throws(() => loadProject(dir), (e) => e instanceof UserError && e.message.includes(dir));
});

test('malformed package.json is a UserError, not a raw SyntaxError', () => {
  const dir = tmpProject({ 'package.json': '{oops' });
  assert.throws(() => loadProject(dir), (e) => e instanceof UserError && /Failed to parse/.test(e.message));
});

test('defaults fill in for an absent wrench block', () => {
  const dir = tmpProject({ 'package.json': pkg() });
  assert.deepEqual(loadProject(dir), {
    root: dir,
    name: 'demo',
    displayName: 'demo',
    accentColor: '#569cd6',
    distBudgetMb: null,
    subdomain: null,
  });
});

test('displayName falls back to the package name, then to "App"', () => {
  const named = tmpProject({ 'package.json': JSON.stringify({}) });
  assert.equal(loadProject(named).displayName, 'App');
  const withName = tmpProject({ 'package.json': pkg(null, { name: 'thing' }) });
  assert.equal(loadProject(withName).displayName, 'thing');
});

test('wrench block values win over defaults', () => {
  const dir = tmpProject({
    'package.json': pkg({ displayName: 'Demo', accentColor: '#abc', distBudgetMb: 4, subdomain: 'app' }),
  });
  const p = loadProject(dir);
  assert.equal(p.displayName, 'Demo');
  assert.equal(p.accentColor, '#abc');
  assert.equal(p.distBudgetMb, 4);
  assert.equal(p.subdomain, 'app');
});

test('accentColor is validated as a hex color', () => {
  for (const good of ['#abc', '#AABBCC', '#aabbccdd']) {
    const dir = tmpProject({ 'package.json': pkg({ accentColor: good }) });
    assert.equal(loadProject(dir).accentColor, good);
  }
  for (const bad of ['red', '#ab', '#abcd', 'javascript:x', '#569cd6; }', 5]) {
    const dir = tmpProject({ 'package.json': pkg({ accentColor: bad }) });
    assert.throws(() => loadProject(dir), UserError, `accepted ${bad}`);
  }
});

test('distBudgetMb must be a positive number', () => {
  // Infinity/NaN are unrepresentable in JSON, so they can't reach here.
  for (const bad of ['15', 0, -1, true]) {
    const dir = tmpProject({ 'package.json': pkg({ distBudgetMb: bad }) });
    assert.throws(() => loadProject(dir), UserError, `accepted ${bad}`);
  }
});

test('an empty-string subdomain means the apex and survives as ""', () => {
  const dir = tmpProject({ 'package.json': pkg({ subdomain: '' }) });
  assert.equal(loadProject(dir).subdomain, '');
});

test('an absent subdomain is null, not ""', () => {
  const dir = tmpProject({ 'package.json': pkg({ displayName: 'x' }) });
  assert.equal(loadProject(dir).subdomain, null);
});

test('a non-string subdomain is rejected', () => {
  const dir = tmpProject({ 'package.json': pkg({ subdomain: 3 }) });
  assert.throws(() => loadProject(dir), UserError);
});

test('requireVersion only demands version.json when asked', () => {
  const dir = tmpProject({ 'package.json': pkg() });
  assert.ok(loadProject(dir));
  assert.throws(() => loadProject(dir, { requireVersion: true }), (e) => /version\.json/.test(e.message));

  const full = tmpProject({ 'package.json': pkg(), 'version.json': versionJson() });
  assert.ok(loadProject(full, { requireVersion: true }));
});
