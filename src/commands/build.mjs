import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../context.mjs';
import { run } from '../lib/run.mjs';
import { checkBudget } from './budget.mjs';

export async function build() {
  const project = loadProject();

  await run('npm', ['run', 'build'], { cwd: project.root });

  const distIndex = join(project.root, 'dist', 'index.html');
  if (!existsSync(distIndex)) {
    throw new Error('Build failed: dist/index.html not found');
  }

  checkBudget(project.root, project.distBudgetMb);
}
