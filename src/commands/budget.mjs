// Reports dist/ size, and names the largest files when it runs over budget.
// Advisory only — never fails the build.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BUDGET_MB = 15;

function walk(root, dir) {
  let total = 0;
  const biggest = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walk(root, full);
      total += sub.total;
      biggest.push(...sub.biggest);
    } else {
      const { size } = statSync(full);
      total += size;
      biggest.push([full.slice(root.length + 1), size]);
    }
  }
  return { total, biggest };
}

export function resolveBudget(budgetMb, envValue) {
  if (budgetMb != null) return budgetMb;
  if (envValue === undefined || envValue === '') return DEFAULT_BUDGET_MB;

  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `wrench budget: DIST_BUDGET_MB="${envValue}" isn't a positive number — using ${DEFAULT_BUDGET_MB} MB.`
    );
    return DEFAULT_BUDGET_MB;
  }
  return parsed;
}

export function checkBudget(projectRoot, budgetMb, env = process.env) {
  const budget = resolveBudget(budgetMb, env.DIST_BUDGET_MB);
  const dist = join(projectRoot, 'dist');

  // Only a missing dist/ is skippable. Anything else (permissions, a broken
  // symlink) is a real problem and should surface rather than be reported as
  // "dist/ not found".
  if (!existsSync(dist)) {
    console.warn('wrench budget: dist/ not found — skipping.');
    return;
  }

  const result = walk(projectRoot, dist);
  const mb = result.total / 1024 / 1024;

  if (mb > budget) {
    console.warn(`\n⚠  dist/ is ${mb.toFixed(1)} MB, over the ${budget} MB advisory budget. Largest files:`);
    for (const [path, size] of result.biggest.sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.warn(`     ${(size / 1024 / 1024).toFixed(2)} MB  ${path}`);
    }
    console.warn('');
  } else {
    console.log(`dist/ is ${mb.toFixed(1)} MB (under the ${budget} MB advisory budget)`);
  }
}
