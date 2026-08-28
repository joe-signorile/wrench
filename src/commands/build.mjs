import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../context.mjs';
import { run } from '../lib/run.mjs';
import { UserError } from '../lib/errors.mjs';
import { checkBudget } from './budget.mjs';

export function parseBuildFlags(args = []) {
  const flags = { clean: false };
  for (const arg of args) {
    if (arg === '--clean') flags.clean = true;
    else throw new UserError(`Unknown argument for 'wrench build': ${arg}`);
  }
  return flags;
}

export async function build({ clean = false } = {}, project = loadProject()) {
  const dist = join(project.root, 'dist');
  if (clean && existsSync(dist)) {
    console.log('removing dist/');
    rmSync(dist, { recursive: true, force: true });
  }

  await run('npm', ['run', 'build'], { cwd: project.root });

  if (!existsSync(join(dist, 'index.html'))) {
    throw new UserError('Build failed: dist/index.html not found');
  }

  checkBudget(project.root, project.distBudgetMb);
}
