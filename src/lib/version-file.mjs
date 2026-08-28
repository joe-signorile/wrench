import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from './errors.mjs';

// Strict SemVer: no leading zeroes, no pre-release, no build metadata. The S3
// layout uses the version string as a key prefix, so it has to be exact.
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function versionPath(projectRoot) {
  return join(projectRoot, 'version.json');
}

function parseVersionFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new UserError(`No version.json found at ${path}. wrench-managed projects must have one.`);
    }
    throw new UserError(`Failed to read ${path}: ${err.message}`);
  }

  let v;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    throw new UserError(`Failed to parse ${path}: ${err.message}`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new UserError(`${path} must contain a JSON object.`);
  }

  for (const key of ['major', 'minor', 'patch']) {
    const n = v[key];
    if (!Number.isInteger(n) || n < 0) {
      throw new UserError(`${path}: "${key}" must be a non-negative integer, got ${JSON.stringify(n)}.`);
    }
  }
  return v;
}

export function readVersion(projectRoot) {
  return parseVersionFile(versionPath(projectRoot));
}

export function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function assertSemver(version, label = 'version') {
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new UserError(`${label} "${version}" isn't strict SemVer (X.Y.Z).`);
  }
  return version;
}

// Write via a sibling temp file + rename so a crash mid-write can never leave
// a truncated version.json behind and brick the project.
export function writeVersion(projectRoot, v) {
  const path = versionPath(projectRoot);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(v)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
  return v;
}

export function setVersion(projectRoot, version) {
  assertSemver(version);
  const [major, minor, patch] = version.split('.').map(Number);
  return writeVersion(projectRoot, { ...readVersion(projectRoot), major, minor, patch });
}

export function bumpVersion(projectRoot) {
  const v = readVersion(projectRoot);

  v.patch += 1;
  if (v.patch >= 100) { v.patch = 0; v.minor += 1; }
  if (v.minor >= 100) { v.minor = 0; v.major += 1; }

  return writeVersion(projectRoot, v);
}
