import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function versionPath(projectRoot) {
  return join(projectRoot, 'version.json');
}

function parseVersionFile(path) {
  let v;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${err.message}`);
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (typeof v[key] !== 'number') {
      throw new Error(`${path} is missing a numeric "${key}" field.`);
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

export function bumpVersion(projectRoot) {
  const path = versionPath(projectRoot);
  const v = parseVersionFile(path);

  v.patch += 1;
  if (v.patch >= 100) { v.patch = 0; v.minor += 1; }
  if (v.minor >= 100) { v.minor = 0; v.major += 1; }

  writeFileSync(path, JSON.stringify(v));
  return v;
}
