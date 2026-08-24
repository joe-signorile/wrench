import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { wrenchRoot } from '../context.mjs';

// Wrench-repo-global config (root domain + shared registry bucket), distinct
// from a site's own per-project package.json "wrench" block.
export function loadWrenchConfig() {
  const path = join(wrenchRoot, 'wrench.config.json');
  if (!existsSync(path)) {
    return { rootDomain: null, registryBucket: null };
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}
