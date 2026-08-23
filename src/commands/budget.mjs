// Reports dist/ size, and names the largest files when it runs over budget.
// Advisory only — never fails the build.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

export function checkBudget(projectRoot, budgetMb) {
  const budget = budgetMb ?? Number(process.env.DIST_BUDGET_MB ?? 15);
  const dist = join(projectRoot, 'dist');

  let result;
  try {
    result = walk(projectRoot, dist);
  } catch {
    console.warn('wrench budget: dist/ not found — skipping.');
    return;
  }

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
