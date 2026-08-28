import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const cliPath = join(repoRoot, 'bin', 'wrench.mjs');

const created = [];

export function tmpProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wrench-test-'));
  created.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return dir;
}

export function cleanup() {
  while (created.length) rmSync(created.pop(), { recursive: true, force: true });
}

export function pkg(wrench, rest = {}) {
  return JSON.stringify({ name: 'demo', ...rest, ...(wrench ? { wrench } : {}) });
}

export function versionJson(major = 0, minor = 0, patch = 0) {
  return JSON.stringify({ major, minor, patch });
}
