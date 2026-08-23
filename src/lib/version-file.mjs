import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function versionPath(projectRoot) {
  return join(projectRoot, 'version.json');
}

export function readVersion(projectRoot) {
  const v = JSON.parse(readFileSync(versionPath(projectRoot), 'utf8'));
  return v;
}

export function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function bumpVersion(projectRoot) {
  const path = versionPath(projectRoot);
  const v = JSON.parse(readFileSync(path, 'utf8'));

  v.patch += 1;
  if (v.patch >= 100) { v.patch = 0; v.minor += 1; }
  if (v.minor >= 100) { v.minor = 0; v.major += 1; }

  writeFileSync(path, JSON.stringify(v));
  return v;
}
