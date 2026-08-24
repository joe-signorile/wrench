import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const wrenchRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadProject(cwd = process.cwd()) {
  const packageJsonPath = join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`No package.json found in ${cwd}. Run wrench from a project's root directory.`);
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse package.json in ${cwd}: ${err.message}`);
  }
  const config = pkg.wrench || {};

  if (!existsSync(join(cwd, 'version.json'))) {
    throw new Error(`No version.json found in ${cwd}. wrench-managed projects must have one.`);
  }

  return {
    root: cwd,
    name: pkg.name,
    displayName: config.displayName || pkg.name || 'App',
    accentColor: config.accentColor || '#569cd6',
    distBudgetMb: config.distBudgetMb ?? null,
    subdomain: config.subdomain ?? null,
  };
}
