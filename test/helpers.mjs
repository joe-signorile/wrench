import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

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

// Puts fake executables on PATH ahead of the real ones, so tests can exercise
// wrench's own logic without touching real npm/terraform/AWS/python3. Returns
// a restore function; callers must call it (in a finally) to undo the PATH
// mutation, since PATH is process-global and tests run in one process.
export function fakeBin(scripts) {
  const bin = tmpProject(Object.fromEntries(
    Object.entries(scripts).map(([name, body]) => [name, `#!/bin/sh\n${body}\n`])
  ));
  for (const name of Object.keys(scripts)) chmodSync(join(bin, name), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  return () => { process.env.PATH = previous; };
}

// Runs the real CLI entrypoint as a subprocess and reports the exit code
// rather than throwing, so a test can assert on status, stdout and stderr
// together.
export async function runCli(cwd, args = [], env = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliPath, ...args], {
      cwd, env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
