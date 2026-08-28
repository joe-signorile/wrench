import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './lib/errors.mjs';
import { versionPath } from './lib/version-file.mjs';

export const wrenchRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const DEFAULT_ACCENT = '#569cd6';

function readAccentColor(config) {
  const raw = config.accentColor;
  if (raw === undefined || raw === null) return DEFAULT_ACCENT;
  if (typeof raw !== 'string' || !HEX_COLOR_RE.test(raw)) {
    throw new UserError(
      `package.json wrench.accentColor must be a hex color like "#569cd6", got ${JSON.stringify(raw)}.`
    );
  }
  return raw;
}

function readBudget(config) {
  const raw = config.distBudgetMb;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new UserError(
      `package.json wrench.distBudgetMb must be a positive number, got ${JSON.stringify(raw)}.`
    );
  }
  return raw;
}

function readSubdomain(config) {
  const raw = config.subdomain;
  // undefined/null means "custom-domain wiring is off"; "" means the apex.
  // The two are NOT interchangeable — see buildDeployEnv.
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new UserError(
      `package.json wrench.subdomain must be a string ("" for the apex), got ${JSON.stringify(raw)}.`
    );
  }
  return raw;
}

export function loadProject(cwd = process.cwd(), { requireVersion = false } = {}) {
  const packageJsonPath = join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new UserError(`No package.json found in ${cwd}. Run wrench from a project's root directory.`);
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (err) {
    throw new UserError(`Failed to parse package.json in ${cwd}: ${err.message}`);
  }
  const config = pkg.wrench || {};

  if (requireVersion && !existsSync(versionPath(cwd))) {
    throw new UserError(`No version.json found in ${cwd}. wrench-managed projects must have one.`);
  }

  return {
    root: cwd,
    name: pkg.name,
    displayName: config.displayName || pkg.name || 'App',
    accentColor: readAccentColor(config),
    distBudgetMb: readBudget(config),
    subdomain: readSubdomain(config),
  };
}
