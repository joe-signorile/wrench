import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wrenchRoot } from '../context.mjs';
import { UserError } from './errors.mjs';

// Wrench-repo-global config (root domain + shared registry bucket), distinct
// from a site's own per-project package.json "wrench" block.
export function loadWrenchConfig(root = wrenchRoot) {
  const path = join(root, 'wrench.config.json');

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { rootDomain: null, registryBucket: null };
    throw new UserError(`Failed to read ${path}: ${err.message}`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new UserError(`Failed to parse ${path}: ${err.message}`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new UserError(`${path} must contain a JSON object.`);
  }

  return { rootDomain: config.rootDomain ?? null, registryBucket: config.registryBucket ?? null };
}
